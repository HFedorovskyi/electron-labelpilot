'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');

const previousTsLoader = Module._extensions['.ts'];
Module._extensions['.ts'] = function compileTypeScript(mod, filename) {
    const source = fs.readFileSync(filename, 'utf8');
    const output = ts.transpileModule(source, {
        compilerOptions: {
            esModuleInterop: true,
            module: ts.ModuleKind.CommonJS,
            moduleResolution: ts.ModuleResolutionKind.NodeJs,
            target: ts.ScriptTarget.ES2022,
        },
        fileName: filename,
        reportDiagnostics: true,
    });
    mod._compile(output.outputText, filename);
};

function validateBitmaps(buffer) {
    const marker = Buffer.from('BITMAP ', 'ascii');
    let cursor = 0;
    let count = 0;
    let bytes = 0;
    for (;;) {
        const position = buffer.indexOf(marker, cursor);
        if (position < 0) break;
        const headerText = buffer.subarray(position, Math.min(buffer.length, position + 160)).toString('ascii');
        const match = /^BITMAP (\d+),(\d+),(\d+),(\d+),0,/.exec(headerText);
        assert.ok(match, `invalid BITMAP header at byte ${position}`);
        const payloadLength = Number(match[3]) * Number(match[4]);
        const payloadStart = position + Buffer.byteLength(match[0], 'ascii');
        const payloadEnd = payloadStart + payloadLength;
        assert.ok(payloadEnd + 2 <= buffer.length, 'truncated BITMAP payload');
        assert.equal(buffer[payloadEnd], 13, 'BITMAP payload must end with CR');
        assert.equal(buffer[payloadEnd + 1], 10, 'BITMAP payload must end with LF');
        assert.ok(buffer.subarray(payloadStart, payloadEnd).some((value) => value !== 0), 'BITMAP must contain black pixels');
        cursor = payloadEnd + 2;
        count++;
        bytes += payloadLength;
    }
    return { count, bytes };
}

(async () => {
    try {
        const { TsplGenerator } = require('../src/main/printer/generator/TsplGenerator.ts');
        const generator = new TsplGenerator();
        const doc = {
            widthMm: 58,
            heightMm: 40,
            canvas: { width: 400, height: 300 },
            elements: [
                { id: 'ascii', type: 'text', text: 'Lot {{ batch }}', x: 10, y: 8, w: 180, h: 28, fontSize: 16, fontStyle: 'normal', textAlign: 'center' },
                { id: 'rotated', type: 'text', text: 'ROTATED', x: 190, y: 8, w: 80, h: 24, fontSize: 12, rotation: 90 },
                { id: 'bold', type: 'text', text: 'BOLD', x: 280, y: 8, w: 80, h: 24, fontSize: 12, fontWeight: 'bold', verticalAlign: 'bottom', textDecoration: 'underline' },
                { id: 'unicode', type: 'text', text: '\u041f\u0430\u0440\u0442\u0438\u044f {{ batch }}', x: 10, y: 38, w: 180, h: 28, fontSize: 16 },
                { id: 'injection', type: 'text', text: '{{ injection }}', x: 10, y: 65, w: 180, h: 20, fontSize: 12 },
                { id: 'frame', type: 'rect', x: 4, y: 4, w: 392, h: 292, borderWidth: 2 },
                { id: 'fill', type: 'rect', x: 200, y: 8, w: 20, h: 20, fill: '#000000' },
                { id: 'code128', type: 'barcode', value: 'ABC123', x: 10, y: 75, w: 180, h: 55, barcodeType: 'code128', showText: true },
                { id: 'qr', type: 'barcode', value: 'https://example.test/1', x: 205, y: 40, w: 75, h: 75, barcodeType: 'qrcode' },
                { id: 'dm', type: 'barcode', value: 'DM123', x: 290, y: 40, w: 75, h: 75, barcodeType: 'datamatrix' },
                { id: 'gs1', type: 'barcode', value: '(01)01234567890128(10)ABC', x: 10, y: 140, w: 180, h: 55, barcodeType: 'gs1-128' },
                {
                    id: 'table', type: 'table', x: 200, y: 140, w: 190, h: 145, fontSize: 9, groupBy: 'batch',
                    columns: [
                        { id: 'name', key: 'name', title: 'Name', widthRatio: 60 },
                        { id: 'qty', key: 'qty', title: 'Qty', widthRatio: 40 },
                    ],
                },
            ],
        };
        const data = {
            batch: 'A1',
            injection: 'X"\r\nPRINT 9',
            items: [
                { name: '\u0422\u043e\u0432\u0430\u0440 A', qty: 12, batch_number: 'B-1', production_date_batch: '2026-08-13' },
                { name: '\u0422\u043e\u0432\u0430\u0440 B', qty: 7, batch_number: 'B-1', production_date_batch: '2026-08-13' },
            ],
        };
        const buffer = await generator.generate(doc, data, {
            dpi: 203,
            darkness: 30,
            printSpeed: 6,
            gapMm: 3.5,
        });
        const text = buffer.toString('utf8');

        assert.match(text, /^SIZE 58 mm,40 mm\r\nGAP 3.5 mm,0 mm\r\n/);
        assert.match(text, /SPEED 6\r\nDENSITY 15\r\nCODEPAGE UTF-8\r\nCLS\r\n/);
        assert.match(text, /TEXT \d+,\d+,"0",0,12,12,2,"Lot A1"\r\n/);
        assert.match(text, /TEXT \d+,\d+,"0",90,9,9,1,"ROTATED"\r\n/);
        assert.match(text, /BOX \d+,\d+,\d+,\d+,\d+\r\n/);
        assert.match(text, /BAR \d+,\d+,\d+,\d+\r\n/);
        assert.match(text, /BARCODE \d+,\d+,"128",\d+,1,0,\d+,\d+,"ABC123"\r\n/);
        assert.match(text, /QRCODE \d+,\d+,M,\d+,A,0,M2,S7,"https:\/\/example\.test\/1"\r\n/);
        assert.match(text, /DMATRIX \d+,\d+,\d+,\d+,c126,x\d+,r0,"DM123"\r\n/);
        assert.equal((text.match(/PRINT 1,1/g) || []).length, 1, 'command injection must not add print jobs');
        assert.equal(text.includes('\r\nPRINT 9\r\n'), false, 'control text must stay inside BITMAP data');
        assert.ok(buffer.subarray(-11).equals(Buffer.from('PRINT 1,1\r\n', 'ascii')));

        const bitmaps = validateBitmaps(buffer);
        assert.equal(bitmaps.count, 5, 'bold, unicode, control text, GS1-128 and table should use BITMAP');
        console.log(`tspl generator: native commands + ${bitmaps.count} bitmaps (${bitmaps.bytes} bytes) validated`);
    } finally {
        if (previousTsLoader) Module._extensions['.ts'] = previousTsLoader;
        else delete Module._extensions['.ts'];
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
