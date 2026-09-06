'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const previousLoader = Module._extensions['.ts'];
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

const cases = [
    {
        name: 'zpl-advanced-203',
        config: {
            id: 'golden-zpl', active: true, name: 'Golden ZPL', connection: 'tcp',
            protocol: 'zpl', ip: '127.0.0.1', port: 9100, dpi: 203,
            darkness: 18, printSpeed: 6, compatibilityMode: 'advanced',
        },
        doc: {
            widthMm: 58, heightMm: 40,
            canvas: { width: 400, height: 300 },
            elements: [
                { id: 'title', type: 'text', x: 10, y: 8, w: 180, h: 24, fontSize: 16, textAlign: 'center', text: 'Партия {{ BATCH }}' },
                { id: 'side', type: 'text', x: 205, y: 8, w: 0, h: 20, fontSize: 12, rotation: 90, text: 'SIDE' },
                { id: 'frame', type: 'rect', x: 4, y: 4, w: 392, h: 292, borderWidth: 2, borderRadius: 4 },
                { id: 'fill', type: 'rect', x: 220, y: 10, w: 18, h: 30, rotation: 90, fill: '#000000' },
                { id: 'c128', type: 'barcode', x: 10, y: 55, w: 175, h: 48, barcodeType: '23', value: '{{ code }}', showText: true },
                { id: 'ean', type: 'barcode', x: 10, y: 112, w: 175, h: 48, barcodeType: 'ean13_kz', value: '4820001234567', showText: true },
                { id: 'qr', type: 'barcode', x: 205, y: 55, w: 70, h: 70, barcodeType: 'qr', value: 'https://label.test/A1' },
                { id: 'dm', type: 'barcode', x: 290, y: 55, w: 70, h: 70, barcodeType: 'dm', value: 'DM-A1' },
                { id: 'code39', type: 'barcode', x: 10, y: 175, w: 175, h: 44, barcodeType: 'code-39', value: 'LOT-A1' },
                { id: 'itf', type: 'barcode', x: 205, y: 175, w: 175, h: 44, barcodeType: 'itf14', value: '12345678901231', rotation: 180 },
            ],
        },
        data: { batch: 'A1', code: 'ABC123' },
    },
    {
        name: 'tspl2-native-300',
        config: {
            id: 'golden-tspl', active: true, name: 'Golden TSPL', connection: 'tcp',
            protocol: 'tspl', ip: '127.0.0.1', port: 9100, dpi: 300,
            darkness: 24, printSpeed: 8, gapMm: 3.5, compatibilityMode: 'advanced',
        },
        doc: {
            widthMm: 80, heightMm: 50,
            canvas: { width: 500, height: 320 },
            elements: [
                { id: 'title', type: 'text', x: 10, y: 8, w: 190, h: 24, fontSize: 16, textAlign: 'center', text: 'LOT {{ batch }}' },
                { id: 'side', type: 'text', x: 210, y: 8, w: 80, h: 20, fontSize: 12, rotation: 90, text: 'SIDE' },
                { id: 'frame', type: 'rect', x: 4, y: 4, w: 492, h: 312, borderWidth: 2, borderRadius: 5 },
                { id: 'fill', type: 'rect', x: 300, y: 8, w: 20, h: 30, fill: '#000000' },
                { id: 'c128', type: 'barcode', x: 10, y: 55, w: 210, h: 55, barcodeType: 'code128', value: '{{ code }}', showText: true },
                { id: 'ean8', type: 'barcode', x: 10, y: 125, w: 180, h: 48, barcodeType: '22', value: '12345670', showText: true },
                { id: 'qr', type: 'barcode', x: 250, y: 55, w: 80, h: 80, barcodeType: 'qrcode', value: 'TSPL-A1', moduleWidth: 4 },
                { id: 'dm', type: 'barcode', x: 350, y: 55, w: 80, h: 80, barcodeType: 'datamatrix', value: 'DM-A1', moduleWidth: 5 },
                { id: 'itf', type: 'barcode', x: 210, y: 160, w: 220, h: 50, barcodeType: 'interleaved2of5', value: '12345678901231', rotation: 270 },
            ],
        },
        data: { batch: 'B7', code: 'TSPL123' },
    },
];

(async () => {
    try {
        const { ZplGenerator } = require('../src/main/printer/generator/ZplGenerator.ts');
        const { TsplGenerator } = require('../src/main/printer/generator/TsplGenerator.ts');
        const { resolvePrinterProfile } = require('../src/shared/printerProfiles.ts');
        for (const item of cases) {
            const generator = item.config.protocol === 'zpl' ? new ZplGenerator() : new TsplGenerator();
            const options = {
                dpi: item.config.dpi,
                widthMm: item.config.widthMm,
                heightMm: item.config.heightMm,
                darkness: item.config.darkness,
                printSpeed: item.config.printSpeed,
                gapMm: item.config.gapMm,
                profile: resolvePrinterProfile(item.config),
            };
            const bytes = await generator.generate(item.doc, item.data, options);
            item.expectedBase64 = bytes.toString('base64');
            item.expectedBytes = bytes.length;
        }
        const destination = path.join(root, 'tests', 'fixtures', 'printer-native-golden.json');
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, JSON.stringify({ version: 1, cases }, null, 2) + '\n');
        console.log(`printer native fixture: ${cases.length} cases, ${cases.reduce((sum, item) => sum + item.expectedBytes, 0)} bytes`);
    } finally {
        if (previousLoader) Module._extensions['.ts'] = previousLoader;
        else delete Module._extensions['.ts'];
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});