// Standalone smoke test for the hybrid barcode generator.
// Stubs the 'electron' module so the compiled main-process code loads under plain Node.
const os = require('os');
const path = require('path');
const Module = require('module');

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
        return {
            app: {
                isPackaged: false,
                getPath: () => os.tmpdir(),
                getAppPath: () => process.cwd(),
            },
            BrowserWindow: function () { },
        };
    }
    return origLoad.apply(this, arguments);
};

const { CanvasBitmapGenerator } = require(path.join(process.cwd(), 'dist-electron/main/printer/generator/CanvasBitmapGenerator.js'));
const { normalizeBarcodeType, shouldRasterizeBarcode, needsGs1Parse } = require(path.join(process.cwd(), 'dist-electron/shared/barcodeTypes.js'));
const bwip = require('bwip-js/node');

// Build a valid GTIN-14 (so GS1 AIs encode for real instead of failing checksum).
function gtin14(body13) {
    const d = body13.split('').map(Number);
    let sum = 0;
    for (let i = 0; i < d.length; i++) {
        const fromRight = d.length - 1 - i;
        sum += d[i] * (fromRight % 2 === 0 ? 3 : 1);
    }
    return body13 + String((10 - (sum % 10)) % 10);
}
const GTIN = gtin14('0400638133393'); // → 14 digits, valid check digit
const AI01 = `(01)${GTIN}`;

const gen = new CanvasBitmapGenerator();
const options = { dpi: 203, widthMm: 58, heightMm: 40, printerId: 'test', cacheMode: 'ram' };

const cases = [
    // [label, barcodeType, value, expectToken, kind]
    ['Code128', 'code128', 'ABC12345', '^BC', 'native'],
    ['EAN-13', 'ean13', '460000000001', '^BE', 'native'],
    ['EAN13_KZ', 'Ean13_KZ', '460000000001', '^BE', 'native'],
    ['EAN-8', 'ean8', '2000000', '^B8', 'native'],
    ['UPC-A', 'upca', '03600029145', '^BU', 'native'],
    ['UPC-E', 'upce', '0123456', '^B9', 'native'],
    ['QR', 'qr', 'https://example.com', '^BQ', 'native'],
    ['DataMatrix', 'datamatrix', 'DM-TEST-123', '^BX', 'native'],
    ['GS1-128', 'gs1-128', `${AI01}(10)BATCH1`, '^GFA', 'raster'],
    ['GS1 QR', 'gs1qr', AI01, '^GFA', 'raster'],
    ['GS1 DataMatrix', 'gs1datamatrix', `${AI01}(21)SN1`, '^GFA', 'raster'],
    ['GS1 DataBar', 'databar', AI01, '^GFA', 'raster'],
    ['ITF-14', 'itf-14', GTIN, '^GFA', 'raster'],
    ['Code39', 'code39', 'CODE39', '^GFA', 'raster'],
    ['PDF417', 'pdf417', 'PDF417 payload data', '^GFA', 'raster'],
    ['Aztec', 'aztec', 'AZTEC payload data', '^GFA', 'raster'],
    ['Code128 + GS1 AI value', 'code128', AI01, '^GFA', 'raster (AI forces raster)'],
];

(async () => {
    console.log(`GTIN-14 test value: ${GTIN}\n`);
    let pass = 0, fail = 0;

    console.log('Phase A — routing (native ZPL command vs ^GFA raster):');
    for (const [label, type, value, token, kind] of cases) {
        const doc = {
            widthMm: 58, heightMm: 40,
            canvas: { width: 464, height: 320 },
            elements: [
                { id: 'b', type: 'barcode', x: 20, y: 20, w: 360, h: 120, barcodeType: type, value, showText: true },
            ],
        };
        try {
            const buf = await gen.generate(doc, {}, options);
            const zpl = buf.toString('utf-8');
            const ok = zpl.includes(token);
            const nativeOk = kind.startsWith('native') ? !zpl.includes('^GFA') : true;
            if (ok && nativeOk) { pass++; console.log(`  OK   ${label.padEnd(24)} → ${token}`); }
            else { fail++; console.log(`  FAIL ${label.padEnd(24)} → expected ${token}; nativeNoGfa=${nativeOk}`); }
        } catch (e) {
            fail++; console.log(`  ERR  ${label.padEnd(24)} → ${e && e.message ? e.message : e}`);
        }
    }

    console.log('\nPhase B — bwip-js encoder names are valid (raster types, real render, no fallback):');
    for (const [label, type, value, , kind] of cases) {
        if (!kind.startsWith('raster')) continue;
        const bcid = normalizeBarcodeType(type);
        if (!shouldRasterizeBarcode(bcid, value)) {
            fail++; console.log(`  FAIL ${label.padEnd(24)} → routed to native unexpectedly (bcid=${bcid})`);
            continue;
        }
        const parse = needsGs1Parse(bcid, value);
        try {
            const png = await bwip.toBuffer({ bcid, text: value, scale: 3, includetext: true, parse, backgroundcolor: 'FFFFFF', barcolor: '000000' });
            if (png && png.length > 0) { pass++; console.log(`  OK   ${label.padEnd(24)} → bcid='${bcid}' rendered (${png.length}B PNG)`); }
            else { fail++; console.log(`  FAIL ${label.padEnd(24)} → empty PNG for bcid='${bcid}'`); }
        } catch (e) {
            fail++; console.log(`  FAIL ${label.padEnd(24)} → bcid='${bcid}' threw: ${e && e.message ? e.message : e}`);
        }
    }

    console.log(`\nResult: ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})();
