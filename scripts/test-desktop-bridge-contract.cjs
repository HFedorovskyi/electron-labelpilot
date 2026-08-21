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

const root = path.resolve(__dirname, '..');
const rendererRoot = path.join(root, 'src', 'renderer');
const bridgePath = path.join(rendererRoot, 'platform', 'tauriBridge.ts');

function collectFiles(directory) {
    const result = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) result.push(...collectFiles(absolute));
        else if (/\.(ts|tsx)$/.test(entry.name)) result.push(absolute);
    }
    return result;
}

function extract(files, regex) {
    const values = new Set();
    for (const file of files) {
        const source = fs.readFileSync(file, 'utf8');
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(source)) !== null) values.add(match[1]);
    }
    return [...values].sort();
}

function assertSubset(actual, expected, label) {
    const allowed = new Set(expected);
    assert.deepEqual(actual.filter(value => !allowed.has(value)), [], `${label} are missing from the bridge contract`);
}

const rendererFiles = collectFiles(rendererRoot);
const rendererInvokes = extract(rendererFiles, /window\.desktopBridge\.invoke\(\s*['"]([^'"]+)['"]/g);
const rendererSends = extract(rendererFiles, /window\.desktopBridge\.send\(\s*['"]([^'"]+)['"]/g);
const rendererEvents = extract(rendererFiles, /window\.desktopBridge\.on\(\s*['"]([^'"]+)['"]/g);
assertSubset(rendererInvokes, DESKTOP_INVOKE_CHANNELS, 'Renderer invoke channels');
assertSubset(rendererSends, DESKTOP_SEND_CHANNELS, 'Renderer send channels');
assertSubset(rendererEvents, DESKTOP_EVENT_CHANNELS, 'Renderer event channels');

const bridge = fs.readFileSync(bridgePath, 'utf8');
for (const channel of DESKTOP_INVOKE_CHANNELS) {
    assert.ok(bridge.includes(`'${channel}'`), `Tauri bridge does not route invoke channel ${channel}`);
}
for (const channel of DESKTOP_SEND_CHANNELS.filter(channel => channel !== 'ready-to-print')) {
    assert.ok(bridge.includes(`'${channel}'`), `Tauri bridge does not route send channel ${channel}`);
}
assert.doesNotMatch(bridge, /Object\.defineProperty\(window, ['"]electron['"]/);
for (const file of rendererFiles) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /window\.electron\b/, `Legacy bridge alias remains in ${file}`);
}

console.log(`Tauri desktop bridge contract: ${DESKTOP_INVOKE_CHANNELS.length} invoke, ${DESKTOP_SEND_CHANNELS.length} send, ${DESKTOP_EVENT_CHANNELS.length} event channels`);
console.log('Renderer bridge surface: window.desktopBridge only');
