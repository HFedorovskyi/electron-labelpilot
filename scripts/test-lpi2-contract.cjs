'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'lpi2-contract.json'), 'utf8'));
const blob = Buffer.from(fixture.blob_base64, 'base64');
assert.equal(blob.subarray(0, 5).toString('ascii'), 'LPI2\n');
const tokenEnd = blob.indexOf(0x0a, 5);
assert.ok(tokenEnd > 5);
const token = blob.subarray(5, tokenEnd).toString('ascii');
assert.equal(token, fixture.token);
const [payloadPart, signaturePart] = token.split('.');
const payload = Buffer.from(payloadPart, 'base64url');
const signature = Buffer.from(signaturePart, 'base64url');
const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
const publicKey = crypto.createPublicKey({
    key: Buffer.concat([spkiPrefix, Buffer.from(fixture.public_key_hex, 'hex')]),
    format: 'der',
    type: 'spki',
});
assert.equal(crypto.verify(null, payload, publicKey, signature), true);
const license = JSON.parse(payload.toString('utf8'));
const seed = Buffer.from(`${license.license_id}|kv${Math.trunc(Number(license.key_version))}`);
const key = crypto.hkdfSync(
    'sha256',
    seed,
    Buffer.from('labelpilot-data-key|salt|v1'),
    Buffer.from(`lpi-data-key|${license.license_id}|kv${Math.trunc(Number(license.key_version))}`),
    32,
);
const body = blob.subarray(tokenEnd + 1);
const decipher = crypto.createDecipheriv('aes-256-cbc', key, body.subarray(0, 16));
const plaintext = Buffer.concat([decipher.update(body.subarray(16)), decipher.final()]);
assert.deepEqual(JSON.parse(plaintext.toString('utf8')), fixture.plaintext);
console.log(`Node LPI2 fixture: signature + HKDF + AES-CBC verified (${blob.length} bytes)`);
