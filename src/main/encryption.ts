import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';

/**
 * LabelPilot data encryption — LOAD-BEARING on the license.
 *
 * Server-issued files (.lpi identity / .lps update) and station-issued files (.lpr report)
 * use the self-describing "LPI2" format:
 *     "LPI2\n" + <license token (ascii)> + "\n" + <IV(16)> + <AES-256-CBC ciphertext>
 *
 * The token is the public, Ed25519-signed license. The data key is HKDF-SHA256 derived
 * from the verified license bytes ALONE (no shared secret), so the server and this client
 * derive the SAME key from the same license. There is NO hardcoded key: without a valid
 * license you cannot derive the key, so removing/forging the license breaks decryption.
 *
 * This MUST stay in lockstep with the server's backend/licensing/core.py and crypto_utils.py
 * (public key, HKDF salt/info, magic). Crypto interop verified Python<->Node.
 */

const LPI2_MAGIC = Buffer.from('LPI2\n');

// Ed25519 public key (hex of the 32-byte raw key) — MUST match the server's
// LICENSE_PUBLIC_KEY_HEX and the LABELPILOT_LICENSE_PUBLIC_KEY used to sign. Production key (2026).
const LICENSE_PUBLIC_KEY_HEX = 'bd770682b1bef5aa9c081320dad25e7e1c81752e357bdeb36d9016b4afe45e56';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const HKDF_SALT = Buffer.from('labelpilot-data-key|salt|v1');

function tokenStorePath(): string {
    return path.join(app.getPath('userData'), 'license.token');
}

function saveToken(token: string): void {
    try {
        fs.writeFileSync(tokenStorePath(), token, 'ascii');
    } catch (e) {
        console.warn('Could not persist license token:', e);
    }
}

function loadToken(): string | null {
    try {
        const t = fs.readFileSync(tokenStorePath(), 'ascii').trim();
        return t || null;
    } catch {
        return null;
    }
}

/** True once this station has a stored license token (i.e. it has decrypted at least one
 *  LPI2 identity/update file). Reporting needs this — see outbox.enqueueReport. */
export function hasLicenseToken(): boolean {
    return loadToken() !== null;
}

/** Best-effort license_id from a token's payload, WITHOUT verifying the signature.
 *  Used only to decide whether an incoming file belongs to the same license as the one
 *  this station is already bound to. null when unparseable. */
function licenseIdOf(token: string): string | null {
    try {
        const dot = token.indexOf('.');
        if (dot < 0) return null;
        const payload = JSON.parse(b64urlToBuffer(token.slice(0, dot)).toString('utf-8'));
        return typeof payload.license_id === 'string' ? payload.license_id : null;
    } catch {
        return null;
    }
}

function b64urlToBuffer(s: string): Buffer {
    let t = s.replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    return Buffer.from(t, 'base64');
}

/** Verify the license token's signature and derive the AES-256 data key from it. */
function deriveKeyFromToken(token: string): Buffer {
    const dot = token.indexOf('.');
    if (dot < 0) throw new Error('Malformed license token');
    const payload = b64urlToBuffer(token.slice(0, dot));
    const signature = b64urlToBuffer(token.slice(dot + 1));

    const pub = crypto.createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(LICENSE_PUBLIC_KEY_HEX, 'hex')]),
        format: 'der',
        type: 'spki',
    });
    if (!crypto.verify(null, payload, pub, signature)) {
        throw new Error('Invalid license signature');
    }

    const lic = JSON.parse(payload.toString('utf-8'));
    // IKM is the STABLE license identity (license_id|kv<version>), NOT the full payload —
    // so a subscription renewal (same id+version, new expiry) yields the SAME key and
    // existing files still decrypt. MUST stay identical to the server's derive_data_key().
    // Coerce key_version to an integer to mirror Python's int(key_version) exactly, so a
    // non-integer value can never derive a divergent key across platforms.
    const kv = Math.trunc(Number(lic.key_version));
    const seed = Buffer.from(`${lic.license_id}|kv${kv}`);
    const info = Buffer.from(`lpi-data-key|${lic.license_id}|kv${kv}`);
    return Buffer.from(crypto.hkdfSync('sha256', seed, HKDF_SALT, info, 32));
}

/** Encrypt a payload as an LPI2 blob using the station's stored license token. */
export function encrypt(data: any): Buffer {
    const token = loadToken();
    if (!token) {
        throw new Error('Станция не активирована: нет лицензии. Импортируйте файл идентификации (.lpi).');
    }
    const key = deriveKeyFromToken(token);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf-8'), cipher.final()]);
    return Buffer.concat([LPI2_MAGIC, Buffer.from(token, 'ascii'), Buffer.from('\n'), iv, ciphertext]);
}

/** Decrypt an LPI2 blob (deriving the key from its embedded license token) or fall back
 *  to plain JSON for legacy/unencrypted files. Persists the token so the station can later
 *  encrypt its own reports. */
export function decrypt(buffer: Buffer): any {
    if (buffer.length > LPI2_MAGIC.length && buffer.subarray(0, LPI2_MAGIC.length).equals(LPI2_MAGIC)) {
        const rest = buffer.subarray(LPI2_MAGIC.length);
        const nl = rest.indexOf(0x0a);
        if (nl < 0) throw new Error('Malformed LPI2 file');
        const token = rest.subarray(0, nl).toString('ascii');
        const body = rest.subarray(nl + 1);
        const key = deriveKeyFromToken(token); // also verifies the license signature

        const iv = body.subarray(0, 16);
        const ciphertext = body.subarray(16);
        let plaintext: string;
        try {
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
            plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
        } catch {
            // AES-256-CBC carries no auth tag, so a corrupted transfer (e.g. a truncated USB
            // copy) surfaces here as an opaque PKCS7 pad error. Translate it to a clear cause.
            throw new Error('Файл повреждён — расшифровка не удалась. Попробуйте экспортировать и перенести файл заново.');
        }

        // Remember the license so this station can later sign its OWN .lpr reports — but do NOT
        // let a mis-delivered file from ANOTHER customer silently repoint an already-bound station
        // (the identity-lock guards uuid/number, not license_id).
        const existing = loadToken();
        const incomingId = licenseIdOf(token);
        if (!existing || licenseIdOf(existing) === incomingId) {
            saveToken(token);
        } else {
            console.warn(`[encryption] refusing to overwrite license token: station is bound to license ${licenseIdOf(existing)}, incoming file carries ${incomingId}`);
        }

        try {
            return JSON.parse(plaintext);
        } catch {
            throw new Error('Файл расшифрован, но содержит некорректные данные (не JSON).');
        }
    }

    // Legacy / unencrypted fallback: plain JSON (older files, or pre-LPI2 transition).
    try {
        const s = buffer.toString('utf-8').replace(/^﻿/, '').trim();
        return JSON.parse(s);
    } catch {
        throw new Error('Invalid file format: not an LPI2 license file and not plain JSON.');
    }
}
