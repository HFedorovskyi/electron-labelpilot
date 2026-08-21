'use strict';

require('./register-typescript.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    DESKTOP_EVENT_CHANNELS,
    DESKTOP_INVOKE_CHANNELS,
    DESKTOP_SEND_CHANNELS,
} = require('../src/shared/desktopBridge.ts');

const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'native', 'labelpilot-contracts', 'src', 'lib.rs'),
    'utf8',
);

function rustArray(name) {
    const pattern = new RegExp(`pub const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`);
    const match = source.match(pattern);
    assert.ok(match, `Rust array ${name} was not found`);
    return [...match[1].matchAll(/"([^"]+)"/g)].map(value => value[1]).sort();
}

function sorted(values) {
    return [...values].sort();
}

assert.deepEqual(rustArray('DESKTOP_INVOKE_CHANNELS'), sorted(DESKTOP_INVOKE_CHANNELS));
assert.deepEqual(rustArray('DESKTOP_SEND_CHANNELS'), sorted(DESKTOP_SEND_CHANNELS));
assert.deepEqual(rustArray('DESKTOP_EVENT_CHANNELS'), sorted(DESKTOP_EVENT_CHANNELS));

console.log('Rust/TypeScript desktop contract parity: 59 invoke, 11 send, 19 event channels');