'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_KEY_RAW = Buffer.from(
    'bd770682b1bef5aa9c081320dad25e7e1c81752e357bdeb36d9016b4afe45e56',
    'hex',
);
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const HKDF_SALT = Buffer.from('labelpilot-data-key|salt|v1');
const TOKEN_LIMIT = 64 * 1024;
const FIELDS = [
    'customer', 'edition', 'expires', 'features', 'issued',
    'key_version', 'license_id', 'machine_id', 'max_stations',
];

function canonicalPayload(value) {
    const sorted = Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
    return Buffer.from(JSON.stringify(sorted));
}

function boundedText(value, maximum) {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= maximum
        && value.trim() === value
        && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function parseDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error('License date must be YYYY-MM-DD');
    }
    const [year, month, day] = value.split('-').map(Number);
    if (year < 1 || year > 9999) throw new Error('License date year is invalid');
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())
        || parsed.getUTCFullYear() !== year
        || parsed.getUTCMonth() + 1 !== month
        || parsed.getUTCDate() !== day) {
        throw new Error('License date is not a real calendar date');
    }
    return value;
}

function decodeCanonicalBase64url(value, label) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new Error(`${label} is not canonical base64url`);
    }
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) {
        throw new Error(`${label} is not canonical base64url`);
    }
    return decoded;
}

function decodeToken(input) {
    const token = String(input ?? '');
    if (!token || !Buffer.from(token).equals(Buffer.from(token, 'ascii'))
        || Buffer.byteLength(token) > TOKEN_LIMIT || token.trim() !== token) {
        throw new Error('License token size or encoding is invalid');
    }
    const parts = token.split('.');
    if (parts.length !== 2) throw new Error('Malformed license token');
    const payloadBytes = decodeCanonicalBase64url(parts[0], 'License payload');
    const signature = decodeCanonicalBase64url(parts[1], 'License signature');
    if (payloadBytes.length > TOKEN_LIMIT || signature.length !== 64) {
        throw new Error('License token length is invalid');
    }
    const publicKey = crypto.createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, PUBLIC_KEY_RAW]),
        format: 'der',
        type: 'spki',
    });
    if (!crypto.verify(null, payloadBytes, publicKey, signature)) {
        throw new Error('License token signature does not match the production public key');
    }
    const license = JSON.parse(payloadBytes.toString('utf8'));
    if (!license || typeof license !== 'object' || Array.isArray(license)
        || Object.keys(license).length !== FIELDS.length
        || !FIELDS.every((field) => Object.hasOwn(license, field))
        || !canonicalPayload(license).equals(payloadBytes)) {
        throw new Error('License payload does not match the canonical contract');
    }
    if (!boundedText(license.customer, 160)
        || !boundedText(license.edition, 120)
        || typeof license.license_id !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(license.license_id)
        || typeof license.machine_id !== 'string'
        || !/^[0-9a-f]{32}$/.test(license.machine_id)
        || !Number.isInteger(license.key_version)
        || license.key_version < 1
        || license.key_version > 1_000_000
        || (license.max_stations !== null
            && (!Number.isInteger(license.max_stations)
                || license.max_stations < 1
                || license.max_stations > 100_000))
        || !Array.isArray(license.features)
        || license.features.length > 64
        || new Set(license.features).size !== license.features.length
        || license.features.some((feature) => typeof feature !== 'string'
            || !/^[A-Za-z0-9._:-]{1,64}$/.test(feature))) {
        throw new Error('License claims are outside the accepted contract');
    }
    const issued = parseDate(license.issued);
    if (license.expires !== null) {
        const expires = parseDate(license.expires);
        if (expires < issued) throw new Error('License expiry precedes its issue date');
        if (expires < new Date().toISOString().slice(0, 10)) throw new Error('License has expired');
    }
    return {
        licenseId: license.license_id,
        keyVersion: license.key_version,
        machineId: license.machine_id,
    };
}

function createLpi2(token, value, iv = crypto.randomBytes(16)) {
    const { licenseId, keyVersion } = decodeToken(token);
    const seed = Buffer.from(`${licenseId}|kv${keyVersion}`);
    const info = Buffer.from(`lpi-data-key|${licenseId}|kv${keyVersion}`);
    const key = Buffer.from(crypto.hkdfSync('sha256', seed, HKDF_SALT, info, 32));
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([
        Buffer.from('LPI2\n'),
        Buffer.from(token, 'ascii'),
        Buffer.from('\n'),
        iv,
        ciphertext,
    ]);
}

if (require.main === module) {
    const [tokenPath, inputPath, outputPath] = process.argv.slice(2);
    if (!tokenPath || !inputPath || !outputPath) {
        console.error('Usage: node create-lpi2-push.cjs TOKEN_FILE INPUT_JSON OUTPUT_LPI2');
        process.exit(2);
    }
    const token = fs.readFileSync(path.resolve(tokenPath), 'utf8').trim();
    const input = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
    const blob = createLpi2(token, input);
    fs.writeFileSync(path.resolve(outputPath), blob);
    console.log(`LPI2 push written: ${path.resolve(outputPath)} (${blob.length} bytes)`);
}

module.exports = { createLpi2, decodeToken };