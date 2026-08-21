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

function decodeToken(token) {
    const parts = token.split('.');
    if (parts.length !== 2) throw new Error('Malformed license token');
    const payloadBytes = Buffer.from(parts[0], 'base64url');
    const signature = Buffer.from(parts[1], 'base64url');
    const publicKey = crypto.createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, PUBLIC_KEY_RAW]),
        format: 'der',
        type: 'spki',
    });
    if (!crypto.verify(null, payloadBytes, publicKey, signature)) {
        throw new Error('License token signature does not match the production public key');
    }
    const license = JSON.parse(payloadBytes.toString('utf8'));
    if (typeof license.license_id !== 'string' || license.license_id.length === 0) {
        throw new Error('License token has no license_id');
    }
    const keyVersion = Number(license.key_version ?? 1);
    if (!Number.isInteger(keyVersion)) throw new Error('License token has invalid key_version');
    return { licenseId: license.license_id, keyVersion };
}

function createLpi2(token, value, iv = crypto.randomBytes(16)) {
    const { licenseId, keyVersion } = decodeToken(token);
    const seed = Buffer.from(licenseId + '|kv' + keyVersion);
    const info = Buffer.from('lpi-data-key|' + licenseId + '|kv' + keyVersion);
    const key = Buffer.from(crypto.hkdfSync('sha256', seed, HKDF_SALT, info, 32));
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(value), 'utf8'),
        cipher.final(),
    ]);
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
    console.log('LPI2 push written: ' + path.resolve(outputPath) + ' (' + blob.length + ' bytes)');
}

module.exports = { createLpi2, decodeToken };
