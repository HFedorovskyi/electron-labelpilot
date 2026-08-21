'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

function installModuleStub(moduleName, exports) {
    const filename = require.resolve(moduleName);
    require.cache[filename] = {
        id: filename,
        filename,
        loaded: true,
        exports,
        children: [],
        paths: [],
    };
}

const quietLog = {
    transports: {
        file: { level: false, resolvePathFn: null, getFile: () => ({ path: 'test.log' }) },
        console: { level: false },
    },
    variables: {},
    info() {},
    warn() {},
    error() {},
    debug() {},
};

installModuleStub('electron', {
    app: {
        isPackaged: false,
        getPath: () => os.tmpdir(),
        getAppPath: () => process.cwd(),
    },
    BrowserWindow: class BrowserWindow {},
});
installModuleStub('electron-log', quietLog);

// Any worker creation in the ZPL/cache-maintenance path is a regression: besides
// its isolate, the old worker eagerly pulled Canvas, fonts and bwip into memory.
const workerThreads = require('node:worker_threads');
let workerStarts = 0;
workerThreads.Worker = class ForbiddenWorker {
    constructor() {
        workerStarts += 1;
        throw new Error('Worker started in low-resource ZPL path');
    }
};

function heavyModules() {
    const pattern = /node_modules[\\/](?:@napi-rs[\\/]canvas|bwip-js|serialport|@serialport)[\\/]/i;
    return Object.keys(require.cache).filter((filename) => pattern.test(filename));
}

function capabilityModuleLoaded() {
    return Object.keys(require.cache).some((filename) =>
        /[\\/]printer[\\/]capabilities\.js$/i.test(filename)
    );
}

const labelDoc = {
    widthMm: 58,
    heightMm: 40,
    canvas: { width: 400, height: 300, widthCm: 5.8, heightCm: 4 },
    elements: [
        { id: 'title', type: 'text', text: 'PACK {{serial}}', x: 10, y: 10, w: 250, h: 30, fontSize: 16, fontFamily: 'Arial' },
        { id: 'code', type: 'barcode', value: 'ABC123456', x: 10, y: 60, w: 300, h: 80, barcodeType: 'code128' },
        { id: 'frame', type: 'rect', x: 5, y: 5, w: 380, h: 280, borderWidth: 1 },
    ],
};

const printerConfig = {
    id: 'low-resource-zpl',
    active: true,
    name: 'Low resource ZPL',
    connection: 'tcp',
    protocol: 'zpl',
    ip: '127.0.0.1',
    port: 9100,
    dpi: 203,
};

async function run() {
    const heapBefore = process.memoryUsage().heapUsed;
    const importStarted = performance.now();
    const {
        printerService,
        requiresZplBitmapFallback,
    } = require('../dist-electron/main/printer/PrinterService.js');
    const { PRINTER_COMPATIBILITY_PROFILES } = require('../dist-electron/shared/printerProfiles.js');
    const serviceImportMs = performance.now() - importStarted;

    assert.deepEqual(heavyModules(), [], 'PrinterService cold import loaded native printing modules');
    assert.equal(capabilityModuleLoaded(), false, 'settings-only capability profiles loaded at startup');
    printerService.clearGeneratorCaches();
    assert.equal(workerStarts, 0, 'clearing an empty cache started the generation worker');

    const firstZpl = await printerService.generateBuffer(printerConfig, labelDoc, { serial: 1 }, 'low-resource-doc');
    assert.match(firstZpl.toString('utf8'), /^\^XA/);
    assert.equal(workerStarts, 0, 'ZPL generation started the generation worker');
    assert.deepEqual(heavyModules(), [], 'ZPL generation loaded Canvas, bwip or serialport');
    assert.equal(capabilityModuleLoaded(), false, 'ZPL hot path loaded capability profiles');

    const safeZpl = PRINTER_COMPATIBILITY_PROFILES['generic-zpl-safe'];
    const fullZpl = PRINTER_COMPATIBILITY_PROFILES['zpl-full'];
    assert.equal(requiresZplBitmapFallback(safeZpl, labelDoc, { serial: 1 }), false);
    assert.equal(requiresZplBitmapFallback(safeZpl, {
        ...labelDoc,
        elements: [{ id: 'unicode', type: 'text', text: '\u041f\u0430\u0440\u0442\u0438\u044f', x: 0, y: 0, w: 100, h: 20 }],
    }, {}), true, 'safe ZPL must rasterize Unicode text');
    assert.equal(requiresZplBitmapFallback(safeZpl, {
        ...labelDoc,
        elements: [{ id: 'qr', type: 'barcode', value: 'QR', x: 0, y: 0, w: 100, h: 100, barcodeType: 'qrcode' }],
    }, {}), true, 'safe ZPL must rasterize optional 2D commands');
    assert.equal(requiresZplBitmapFallback(fullZpl, {
        ...labelDoc,
        elements: [{ id: 'qr', type: 'barcode', value: 'QR', x: 0, y: 0, w: 100, h: 100, barcodeType: 'qrcode' }],
    }, {}), false, 'full ZPL may use its native QR command');
    assert.equal(workerStarts, 0, 'profile resolution/fallback checks started a worker');
    assert.deepEqual(heavyModules(), [], 'profile resolution loaded heavy printer modules');

    const zplStarted = performance.now();
    for (let index = 0; index < 1000; index += 1) {
        await printerService.generateBuffer(printerConfig, labelDoc, { serial: index }, 'low-resource-doc');
    }
    const zpl1000Ms = performance.now() - zplStarted;
    assert.ok(zpl1000Ms < 1500, `1000 ZPL generations exceeded budget: ${zpl1000Ms.toFixed(1)}ms`);

    // Importing and using the native-only TSPL path also stays free of Canvas/bwip.
    const { TsplGenerator } = require('../dist-electron/main/printer/generator/TsplGenerator.js');
    const tspl = new TsplGenerator();
    const firstTspl = await tspl.generate(labelDoc, { serial: 1 }, { dpi: 203, gapMm: 2 });
    assert.match(firstTspl.toString('utf8'), /^SIZE /);
    assert.doesNotMatch(firstTspl.toString('utf8'), /BITMAP /);
    assert.deepEqual(heavyModules(), [], 'native TSPL generation loaded raster dependencies');

    const tsplStarted = performance.now();
    for (let index = 0; index < 250; index += 1) {
        await tspl.generate(labelDoc, { serial: index }, { dpi: 203, gapMm: 2 });
    }
    const tspl250Ms = performance.now() - tsplStarted;
    assert.ok(tspl250Ms < 1500, `250 native TSPL generations exceeded budget: ${tspl250Ms.toFixed(1)}ms`);

    const report = {
        ok: true,
        serviceImportMs: Number(serviceImportMs.toFixed(1)),
        zpl1000Ms: Number(zpl1000Ms.toFixed(1)),
        nativeTspl250Ms: Number(tspl250Ms.toFixed(1)),
        heapDeltaMb: Number(((process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024).toFixed(2)),
        workerStarts,
        heavyModulesLoaded: heavyModules().length,
        capabilityModuleLoaded: capabilityModuleLoaded(),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`, () => process.exit(0));
}

run().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`, () => process.exit(1));
});
