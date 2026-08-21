'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'scale-protocols.json'), 'utf8'));
const { PROTOCOLS } = require(path.join(root, 'dist-electron', 'main', 'protocols'));

assert.equal(Object.keys(PROTOCOLS).length, 20, 'Electron protocol catalog drift');
for (const item of fixture.protocols) {
    const protocol = PROTOCOLS[item.id];
    assert.ok(protocol, `missing Electron protocol ${item.id}`);
    const data = item.encoding === 'hex' ? Buffer.from(item.data, 'hex') : Buffer.from(item.data, 'utf8');
    const actual = protocol.parse(data);
    if (item.expected === null) {
        assert.equal(actual, null, `${item.id}: expected null`);
        continue;
    }
    assert.ok(actual, `${item.id}: no reading`);
    assert.ok(Math.abs(actual.weight - item.expected.weight) < 1e-9, `${item.id}: weight ${actual.weight}`);
    assert.equal(actual.unit, item.expected.unit, `${item.id}: unit`);
    assert.equal(actual.stable, item.expected.stable, `${item.id}: stable`);
}

const rust = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'scale.rs'), 'utf8');
for (const item of fixture.protocols) {
    assert.ok(rust.includes(`id: "${item.id}"`), `missing Rust protocol ${item.id}`);
}
for (const marker of [
    'MAX_FRAME_BUFFER',
    'ReconnectBackoff',
    'READING_THROTTLE',
    'STABILITY_THRESHOLD',
    'run_serial_once',
    'run_tcp_once',
    'serial_access_denied',
    'scale-reading',
    'scale-status',
    'scale-error',
]) {
    assert.ok(rust.includes(marker), `missing Rust scale marker ${marker}`);
}

const bridge = fs.readFileSync(path.join(root, 'src', 'renderer', 'platform', 'tauriBridge.ts'), 'utf8');
for (const channel of ['connect-scale', 'disconnect-scale', 'get-scale-status', 'get-serial-ports', 'get-protocols']) {
    assert.ok(bridge.includes(`'${channel}'`), `missing Tauri bridge mapping ${channel}`);
}

console.log(`Scale protocol parity: ${fixture.protocols.length} recorded fixtures`);
console.log('Scale runtime contract: bounded decoder, reconnect, dedup/throttle, Serial/TCP/simulator');
