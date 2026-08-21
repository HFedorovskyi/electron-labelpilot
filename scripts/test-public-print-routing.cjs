'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
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
    });
    mod._compile(output.outputText, filename);
};

try {
    const bitmap = require('../src/renderer/platform/tauriBitmapFallback.ts');
    const sample = {
        widthDots: 16,
        heightDots: 3,
        bytesPerRow: 2,
        mono: Uint8Array.from([0x00, 0x00, 0xff, 0xff, 0x0f, 0xf0]),
        renderMs: 0,
    };
    const zpl = Buffer.from(bitmap.encodeZplBitmap(sample, { dpi: 203 })).toString('ascii');
    assert.match(zpl, /^\^XA\n\^PW16\n\^LL3\n/);
    assert.match(zpl, /\^GFA,6,6,2,/);
    assert.match(zpl, /\^XZ$/);

    const hybridRequest = {
        config: { dpi: 300, protocol: 'image' },
        doc: {
            canvas: { width: 1276, height: 1335, widthCm: 10.8, heightCm: 11.3, dpi: 300 },
            elements: [{
                id: 'pack-ean13', type: 'barcode', x: 827.7703652675394, y: 1138.2190370515614,
                w: 380, h: 132.74515934326956, rotation: 0, value: '{{ barcode }}',
                barcodeType: 'ean13', showText: true,
            }],
        },
        data: { barcode: '4870254930134' },
    };
    const plans = bitmap.collectNativeZplBarcodePlans(hybridRequest);
    assert.equal(plans.length, 1);
    assert.deepEqual(
        {
            bcid: plans[0].bcid, orientation: plans[0].orientation,
            field: [plans[0].fieldX, plans[0].fieldY, plans[0].fieldWidth, plans[0].fieldHeight],
            symbol: [plans[0].symbolX, plans[0].symbolY, plans[0].symbolWidth, plans[0].symbolHeight],
            moduleWidth: plans[0].moduleWidth, modules: plans[0].modules, barHeight: plans[0].barHeight,
        },
        {
            bcid: 'ean13', orientation: 'N', field: [828, 1138, 380, 133],
            symbol: [828, 1138, 380, 133], moduleWidth: 4, modules: 95, barHeight: 113,
        },
    );
    const overlays = bitmap.collectNativeZplBarcodeCommands(hybridRequest);
    assert.deepEqual(overlays, [
        '^FO828,1138^BY4,3.0,113^BEN,113,Y,N^FD4870254930134^FS\n',
    ]);
    const hybridZpl = Buffer.from(bitmap.encodeZplBitmap(sample, { dpi: 300 }, overlays)).toString('ascii');
    assert.ok(hybridZpl.indexOf('^GFA') < hybridZpl.indexOf('^BE'));
    assert.match(hybridZpl, /\^BY4,3\.0,113\^BEN,113,Y,N/);
    assert.equal(bitmap.collectNativeZplBarcodeCommands({
        ...hybridRequest,
        doc: { ...hybridRequest.doc, elements: [{ ...hybridRequest.doc.elements[0], barcodeType: 'gs1qrcode' }] },
    }).length, 0, 'GS1/2D barcodes must remain in the portable raster path');

    assert.equal(bitmap.collectNativeZplBarcodeCommands({
        ...hybridRequest,
        doc: { ...hybridRequest.doc, elements: [{ ...hybridRequest.doc.elements[0], w: 90 }] },
    }).length, 0, 'an EAN-13 field narrower than 95 modules must stay rasterized');
    assert.equal(bitmap.collectNativeZplBarcodeCommands({
        ...hybridRequest,
        doc: { ...hybridRequest.doc, elements: [{ ...hybridRequest.doc.elements[0], rotation: 15 }] },
    }).length, 0, 'non-orthogonal rotations must stay rasterized');

    const tspl = Buffer.from(bitmap.encodeTsplBitmap(sample, {
        dpi: 203, darkness: 20, printSpeed: 5, gapMm: 2,
    }));
    const bitmapMarker = Buffer.from('BITMAP 0,0,2,3,0,');
    const markerOffset = tspl.indexOf(bitmapMarker);
    assert.ok(markerOffset > 0);
    assert.deepEqual(
        tspl.subarray(markerOffset + bitmapMarker.length, markerOffset + bitmapMarker.length + sample.mono.length),
        Buffer.from(sample.mono),
    );
    assert.match(tspl.toString('latin1'), /PRINT 1,1\r\n$/);

    const bridge = read('src/renderer/platform/tauriBridge.ts');
    const orchestrator = read('src/renderer/platform/tauriPrintOrchestrator.ts');
    const printer = read('src-tauri/src/printer.rs');
    const serial = read('src-tauri/src/printer/serial.rs');
    const spooler = read('src-tauri/src/printer/spooler.rs');

    assert.match(bridge, /channel === 'print-label'/);
    assert.match(bridge, /import\('\.\/tauriPrintOrchestrator'\)/);
    for (const command of [
        'desktop_printer_plan_generation',
        'desktop_printer_generate_and_send',
        'desktop_printer_send_fallback_raw',
        'desktop_printer_send_driver_bitmap',
        'desktop_printer_send_driver_page',
        'desktop_printer_plan_backend',
    ]) {
        assert.ok(orchestrator.includes(`'${command}'`), `${command} is missing from public routing`);
    }
    assert.match(orchestrator, /import\('\.\/tauriBitmapFallback'\)/);
    assert.match(orchestrator, /omitNativeZplBarcodes/);
    assert.match(orchestrator, /collectNativeZplBarcodeCommands/);
    assert.match(printer, /"tcp"\s*=>/);
    assert.match(printer, /"serial"\s*=>/);
    assert.match(printer, /"windows_driver"\s*=>/);
    assert.match(serial, /serialport::new/);
    assert.match(serial, /DataBits::Eight/);
    assert.match(serial, /StopBits::One/);
    assert.match(orchestrator, /Windows default printer/);
    for (const api of ['OpenPrinterW', 'WritePrinter', 'CreateDCW', 'StretchDIBits', 'GetDefaultPrinterW']) {
        assert.ok(spooler.includes(api), `${api} is missing from the Windows spooler backend`);
    }

    console.log('public print routing: native + ZPL/TSPL bitmap fallback + Windows GDI');
    console.log(`bitmap encoders: ZPL ${Buffer.byteLength(zpl)} bytes, TSPL ${tspl.length} bytes`);
    console.log('hybrid EAN-13: template 380x133 -> native ZPL 380-dot width, 113-dot bars plus text reserve');
    console.log('transport coverage: TCP + Serial 8N1 + Windows RAW/GDI');
} finally {
    if (previousTsLoader) Module._extensions['.ts'] = previousTsLoader;
    else delete Module._extensions['.ts'];
}
