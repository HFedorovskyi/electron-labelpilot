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
const migratedSerial = normalizePrinterConfig({
    packPrinter: { id: 'new', active: true, name: 'New', connection: 'serial', protocol: 'epl', serialPort: 'COM4' },
    boxPrinter: { id: 'old', active: true, name: 'Old', connection: 'serial', protocol: 'zpl', serialPort: 'COM5', baudRate: 9600 },
});
assert.equal(migratedSerial.packPrinter.baudRate, 115200);
assert.equal(migratedSerial.packPrinter.flowControl, 'hardware');
assert.equal(migratedSerial.packPrinter.parity, 'none');
assert.equal(migratedSerial.packPrinter.dataBits, 8);
assert.equal(migratedSerial.boxPrinter.baudRate, 9600);
assert.equal(migratedSerial.boxPrinter.flowControl, 'none');
assert.equal(migratedSerial.packPrinter.zplCompression, 'none');
assert.equal(normalizePrinterConfig({
    packPrinter: { id: 'legacy', active: true, name: 'Legacy', connection: 'tcp', protocol: 'image', z64: false },
}).packPrinter.zplCompression, 'ascii-rle');
assert.equal(normalizePrinterConfig({
    packPrinter: { id: 'full', active: true, name: 'Full', connection: 'tcp', protocol: 'image', detectedProfileId: 'zpl-full' },
}).packPrinter.zplCompression, 'z64');

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
