'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const result = esbuild.buildSync({
    entryPoints: [path.join(root, 'src/renderer/platform/tauriBitmapFallback.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    write: false,
    logLevel: 'silent',
});
const moduleValue = { exports: {} };
new Function('module', 'exports', 'require', result.outputFiles[0].text)(
    moduleValue,
    moduleValue.exports,
    require,
);
const encoders = moduleValue.exports;

const bitmap = {
    widthDots: 10,
    heightDots: 9,
    bytesPerRow: 2,
    mono: Uint8Array.from([
        0x80, 0x40,
        0x40, 0x80,
        0x20, 0x00,
        0x10, 0x00,
        0x08, 0x00,
        0x04, 0x00,
        0x02, 0x00,
        0x01, 0x00,
        0xff, 0xc0,
    ]),
    renderMs: 0,
};
const config = { dpi: 203, gapMm: 2 };

const ascii = bytes => Buffer.from(bytes).toString('latin1');
const monoHex = Buffer.from(bitmap.mono).toString('hex').toUpperCase();

const epl = encoders.encodeEplBitmap(bitmap, config);
const eplText = ascii(epl);
assert.ok(eplText.startsWith('N\nq10\nQ9,16\nGW0,0,2,9,'));
const eplMarker = Buffer.from('GW0,0,2,9,');
const eplDataStart = Buffer.from(epl).indexOf(eplMarker) + eplMarker.length;
assert.deepEqual(Buffer.from(epl).subarray(eplDataStart, eplDataStart + bitmap.mono.length), Buffer.from(bitmap.mono));
assert.ok(eplText.endsWith('\nP1\n'));

const cpcl = encoders.encodeCpclBitmap(bitmap, config);
const cpclText = ascii(cpcl);
assert.ok(cpclText.startsWith('! 0 203 203 9 1\r\nPAGE-WIDTH 10\r\n'));
assert.ok(cpclText.includes('EG 2 9 0 0 ' + monoHex + '\r\n'));
assert.ok(cpclText.endsWith('FORM\r\nPRINT\r\n'));

const dpl = encoders.encodeDplBitmap(bitmap, config);
const dplBuffer = Buffer.from(dpl);
assert.equal(dplBuffer[0], 0x02);
assert.ok(ascii(dpl).startsWith('\x02xDLP'));
const bmpOffset = dplBuffer.indexOf(Buffer.from('BM'));
assert.ok(bmpOffset > 8);
const bmpSize = dplBuffer.readUInt32LE(bmpOffset + 2);
assert.equal(dplBuffer.readUInt32LE(bmpOffset + 10), 14 + 40 + 256 * 4);
assert.equal(dplBuffer.readUInt32LE(bmpOffset + 18), bitmap.widthDots);
assert.equal(dplBuffer.readUInt32LE(bmpOffset + 22), bitmap.heightDots);
assert.equal(dplBuffer.readUInt16LE(bmpOffset + 28), 8);
const dplFormat = ascii(dplBuffer.subarray(bmpOffset + bmpSize));
assert.match(dplFormat, /^\r\x02L\rD11\r1Y1100000000000LP[0-9A-F]{8}\rQ0001\rE\r$/);

const sbpl = encoders.encodeSbplBitmap(bitmap, config);
const sbplText = ascii(sbpl);
assert.ok(sbplText.startsWith('\x1bA\x1bA100090010\x1bH0000\x1bV0000\x1bGH002002'));
assert.ok(sbplText.endsWith('\x1bQ1\x1bZ'));
const sbplMarker = '\x1bGH002002';
const sbplSuffix = '\x1bQ1\x1bZ';
const sbplData = sbplText.slice(sbplText.indexOf(sbplMarker) + sbplMarker.length, -sbplSuffix.length);
assert.equal(sbplData.length, 2 * 2 * 8 * 2);
assert.match(sbplData, /^[0-9A-F]+$/);

for (const protocol of ['epl', 'cpcl', 'dpl', 'sbpl']) {
    const direct = encoders['encode' + protocol[0].toUpperCase() + protocol.slice(1) + 'Bitmap'](bitmap, config);
    const routed = encoders.encodePortableRaster(protocol, bitmap, config);
    assert.deepEqual(Buffer.from(routed), Buffer.from(direct), protocol);
}

console.log('raster adapters: EPL GW, CPCL EG, DPL 8-bit BMP, SBPL GH');
console.log('fixture: 10x9 dots, 2 bytes/row, exact binary/hex geometry verified');
console.log('adapter bytes:', {
    epl: epl.length,
    cpcl: cpcl.length,
    dpl: dpl.length,
    sbpl: sbpl.length,
});
