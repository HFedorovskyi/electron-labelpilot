'use strict';

require('./register-typescript.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    normalizeNumberingConfig,
    normalizePrinterConfig,
    normalizeScaleConfig,
} = require('../src/shared/persistedContracts.ts');

const root = path.resolve(__dirname, '..');
const fixture = JSON.parse(fs.readFileSync(
    path.join(root, 'tests', 'fixtures', 'persisted-contracts.json'),
    'utf8',
));

assert.deepEqual(normalizeScaleConfig(fixture.scale.input), fixture.scale.expected);
assert.deepEqual(normalizeNumberingConfig(fixture.numbering.input), fixture.numbering.expected);
assert.deepEqual(normalizePrinterConfig(fixture.printer.input), fixture.printer.expected);

const rust = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'persisted.rs'), 'utf8');
assert.match(rust, /LABELPILOT_DATA_DIR/);
assert.match(rust, /electron-labelpilot/);
assert.match(rust, /MoveFileExW/);
assert.match(rust, /SQLITE_OPEN_READ_ONLY/);
assert.match(rust, /sequence_guard/);

const adapter = fs.readFileSync(
    path.join(root, 'src', 'renderer', 'platform', 'tauriBridge.ts'),
    'utf8',
);
for (const command of [
    'desktop_get_scale_config', 'desktop_save_scale_config',
    'desktop_get_numbering_config', 'desktop_save_numbering_config',
    'desktop_get_printer_config', 'desktop_save_printer_config',
    'desktop_get_identity', 'desktop_get_next_sequence',
]) {
    assert.ok(adapter.includes(command), `${command} is missing from the Tauri adapter`);
}

console.log('Persisted contract parity: scale + numbering + printer fixtures match the persisted TypeScript contract');
console.log('Rust persistence: legacy path + SQLite-first identity + atomic replace + sequence mutex');
