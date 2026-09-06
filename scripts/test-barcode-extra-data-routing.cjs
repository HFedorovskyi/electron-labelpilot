'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const count = (source, pattern) => [...source.matchAll(pattern)].length;
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

try {
    const weighing = read('src/renderer/components/WeighingStation.tsx');
    const fixed = read('src/renderer/components/FixedWeightStation.tsx');
    const jobs = read('src/renderer/components/PrintJobStation.tsx');
    const packSpread = /\.\.\.predictedData,\s*weight_netto_pack:/g;
    const boxSpread = /\.\.\.baseData,\s*weight_netto_box:/g;

    assert.equal(count(weighing, packSpread), 1, 'weighing pack barcode must retain product extra_data');
    assert.equal(count(fixed, packSpread), 2, 'fixed-weight pack paths must retain product extra_data');
    assert.equal(count(jobs, packSpread), 1, 'print-job pack barcode must retain product extra_data');
    assert.equal(count(weighing, boxSpread), 2, 'weighing box paths must retain product extra_data');
    assert.equal(count(fixed, boxSpread), 1, 'fixed-weight box path must retain product extra_data');
    assert.equal(count(jobs, boxSpread), 1, 'print-job box path must retain product extra_data');

    const { generateBarcode } = require('../src/shared/barcodeGenerator.ts');
    const fields = [{ field_type: 'extra_data', value: 'Код ШК', length: 13 }];
    const productData = { 'Код ШК': '4870254930134' };
    assert.equal(generateBarcode(fields, productData), '4870254930134');

    const config = JSON.parse(read('src-tauri/tauri.conf.json'));
    assert.equal(config.app.windows[0].fullscreen, true);
    console.log('barcode extra_data routing: 4 pack paths and 4 box paths verified');
    console.log('EAN-13 fixture: 4870254930134; Tauri startup: fullscreen');
} finally {
    if (previousTsLoader) Module._extensions['.ts'] = previousTsLoader;
    else delete Module._extensions['.ts'];
}