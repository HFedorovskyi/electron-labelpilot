'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
// Deterministic TEST-ONLY key for the cross-language golden fixture. Its public key is
// intentionally different from the production key embedded in the application.
const fixtureSeed = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([pkcs8Prefix, fixtureSeed]),
    format: 'der',
    type: 'pkcs8',
});
const publicDer = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
const publicKey = publicDer.subarray(publicDer.length - 32);
const licensePayload = {
    customer: 'Fixture Factory',
    edition: 'test',
    expires: '2099-12-31',
    features: ['sync', 'printing'],
    issued: '2026-01-01',
    key_version: 3,
    license_id: 'fixture-license-2026',
    machine_id: '0123456789abcdef0123456789abcdef',
    max_stations: 1,
};
const payloadBytes = Buffer.from(JSON.stringify(licensePayload));
const token = `${payloadBytes.toString('base64url')}.${crypto.sign(null, payloadBytes, privateKey).toString('base64url')}`;
const seedBytes = Buffer.from(`${licensePayload.license_id}|kv${licensePayload.key_version}`);
const key = crypto.hkdfSync(
    'sha256',
    seedBytes,
    Buffer.from('labelpilot-data-key|salt|v1'),
    Buffer.from(`lpi-data-key|${licensePayload.license_id}|kv${licensePayload.key_version}`),
    32,
);
const iv = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const plaintext = {
    station: { uuid: 'fixture-station', number: 7, name: 'Fixture station', server_url: 'http://192.0.2.25:8000' },
    payload: { nomenclature: [], containers: [], barcodes: [], labels: [], operators: [] },
    meta: { type: 'FULL_SYNC', generated_at: '2026-08-13T20:00:00Z', min_client_version: '1.3.0' },
};
const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plaintext), 'utf8'), cipher.final()]);
const blob = Buffer.concat([Buffer.from('LPI2\n'), Buffer.from(token, 'ascii'), Buffer.from('\n'), iv, ciphertext]);
const fixture = {
    public_key_hex: publicKey.toString('hex'),
    token,
    iv_hex: iv.toString('hex'),
    blob_base64: blob.toString('base64'),
    plaintext,
};
const output = path.join(root, 'tests', 'fixtures', 'lpi2-contract.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`LPI2 fixture written: ${path.relative(root, output)} (${blob.length} bytes)`);