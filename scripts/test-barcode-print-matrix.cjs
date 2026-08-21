'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const bwip = require('bwip-js/node');

const root = path.resolve(__dirname, '..');
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

function liveTemplates() {
    if (process.platform !== 'win32') return [];
    const dbPath = process.env.LABELPILOT_DB
        || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'electron-labelpilot', 'client_data.db');
    if (!fs.existsSync(dbPath)) return [];
    const python = String.raw`
import json, sqlite3, sys
conn = sqlite3.connect('file:' + sys.argv[1].replace('\\', '/') + '?mode=ro', uri=True)
result = []
try:
    for row in conn.execute('SELECT id, structure FROM labels ORDER BY id'):
        doc = json.loads(row[1])
        canvas = doc.get('canvas') or {}
        for barcode in doc.get('elements') or []:
            if str(barcode.get('type') or '').lower() == 'barcode':
                result.append({'id': row[0], 'labelType': canvas.get('labelType') or 'unknown', 'canvas': canvas, 'barcode': barcode})
finally:
    conn.close()
print(json.dumps(result, ensure_ascii=False))
`;
    const processResult = spawnSync(process.env.PYTHON || 'python', ['-c', python, dbPath], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000,
    });
    if (processResult.status === 0) {
        try { return JSON.parse(processResult.stdout); } catch { /* fixture fallback below */ }
    }
    const reason = processResult.error?.message || processResult.stderr?.trim() || `exit ${processResult.status}`;
    console.warn(`barcode matrix: live DB skipped (${reason})`);
    return [];
}

function assertPlanInsideField(plan) {
    assert.ok(plan.symbolX >= plan.fieldX, `${plan.bcid}: symbol starts before field X`);
    assert.ok(plan.symbolY >= plan.fieldY, `${plan.bcid}: symbol starts before field Y`);
    assert.ok(plan.symbolX + plan.symbolWidth <= plan.fieldX + plan.fieldWidth, `${plan.bcid}: symbol exceeds field width`);
    assert.ok(plan.symbolY + plan.symbolHeight <= plan.fieldY + plan.fieldHeight, `${plan.bcid}: symbol exceeds field height`);
    assert.ok(plan.moduleWidth >= 1 && plan.moduleWidth <= 10);
    assert.equal(plan.symbolWidth === plan.fieldWidth || plan.symbolHeight === plan.fieldHeight, true);
}

try {
    const types = require('../src/shared/barcodeTypes.ts');
    const matrix = require('../src/shared/barcodePrintMatrix.ts');
    const bitmap = require('../src/renderer/platform/tauriBitmapFallback.ts');
    const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'barcode-real-templates.json'), 'utf8'));
    const entries = matrix.BARCODE_PRINT_MATRIX;

    assert.ok(Array.isArray(entries) && entries.length >= 15);
    assert.equal(new Set(entries.map(entry => entry.bcid)).size, entries.length, 'matrix bcid values must be unique');
    assert.deepEqual([...matrix.BARCODE_MATRIX_DPIS], [203, 300, 600]);

    for (const entry of entries) {
        assert.equal(types.normalizeBarcodeType(entry.bcid), entry.bcid);
        for (const alias of entry.aliases) assert.equal(types.normalizeBarcodeType(alias), entry.bcid, `${alias} alias`);
        assert.equal(matrix.isBarcodeMatrixValueValid(entry, entry.sampleValue), true, `${entry.bcid} sample`);
        const raw = bwip.raw({
            bcid: entry.bcid,
            text: entry.sampleValue,
            parse: types.needsGs1Parse(entry.bcid, entry.sampleValue),
        });
        assert.ok(Array.isArray(raw) && raw.length > 0, `${entry.bcid} must render through bwip-js`);
    }

    const serverTypes = entries.filter(entry => entry.serverSupported).map(entry => entry.bcid).sort();
    assert.deepEqual(serverTypes, [...fixture.serverAllowedBarcodeTypes].sort());

    const base = fixture.templates.find(template => template.id === 10);
    assert.ok(base, 'real template 10 snapshot is missing');
    const matrixCases = [];
    for (const dpi of matrix.BARCODE_MATRIX_DPIS) {
        for (const entry of entries) {
            const element = {
                id: `matrix-${entry.bcid}`,
                type: 'barcode',
                x: 80,
                y: 90,
                w: 600,
                h: 240,
                rotation: 0,
                value: '{{ barcode }}',
                barcodeType: entry.bcid,
                showText: entry.dimension === 'linear',
            };
            const request = {
                config: { dpi, protocol: 'image' },
                doc: { canvas: base.canvas, elements: [element] },
                data: { barcode: entry.sampleValue },
            };
            const plans = bitmap.collectNativeZplBarcodePlans(request);
            const expectsNative = entry.portableZplRoute === 'native-linear';
            assert.equal(plans.length, expectsNative ? 1 : 0, `${entry.bcid} at ${dpi} DPI routing`);
            if (plans[0]) {
                assertPlanInsideField(plans[0]);
                assert.equal(plans[0].bcid, entry.bcid);
                assert.match(plans[0].command, /\^FO\d+,\d+\^BY\d+,3\.0,\d+\^B/);
                assert.ok(plans[0].modules * plans[0].moduleWidth <= plans[0].fieldWidth);
            }
            matrixCases.push({ dpi, bcid: entry.bcid, route: plans.length ? 'native-linear' : 'raster' });
        }
    }

    const current = liveTemplates();
    const realTemplates = current.length ? current : fixture.templates;
    const realCases = [];
    for (const template of realTemplates) {
        const normalized = types.normalizeBarcodeType(template.barcode.barcodeType);
        const entry = matrix.barcodePrintMatrixEntry(normalized);
        assert.ok(entry, `template ${template.id}: unsupported ${normalized}`);
        for (const dpi of matrix.BARCODE_MATRIX_DPIS) {
            const request = {
                config: { dpi, protocol: 'image' },
                doc: {
                    canvas: template.canvas,
                    elements: [{ ...template.barcode, type: 'barcode', value: '{{ barcode }}' }],
                },
                data: { barcode: entry.sampleValue },
            };
            const plans = bitmap.collectNativeZplBarcodePlans(request);
            assert.equal(plans.length, 1, `template ${template.id} at ${dpi} DPI must use native ${normalized}`);
            assertPlanInsideField(plans[0]);
            const expectedOrientation = ({ 0: 'N', 90: 'R', 180: 'I', 270: 'B' })[((Math.round(template.barcode.rotation || 0) % 360) + 360) % 360];
            assert.equal(plans[0].orientation, expectedOrientation);
            realCases.push({
                templateId: template.id,
                labelType: template.labelType,
                dpi,
                bcid: normalized,
                field: [plans[0].fieldX, plans[0].fieldY, plans[0].fieldWidth, plans[0].fieldHeight],
                symbol: [plans[0].symbolX, plans[0].symbolY, plans[0].symbolWidth, plans[0].symbolHeight],
                moduleWidth: plans[0].moduleWidth,
                orientation: plans[0].orientation,
            });
        }
    }

    const report = {
        generatedAt: new Date().toISOString(),
        source: current.length ? 'live-readonly-client-db' : 'checked-in-real-template-snapshot',
        summary: {
            symbologies: entries.length,
            serverSupported: serverTypes.length,
            dpiVariants: matrix.BARCODE_MATRIX_DPIS.length,
            matrixCases: matrixCases.length,
            realTemplates: realTemplates.length,
            realTemplateCases: realCases.length,
            portableNative: entries.filter(entry => entry.portableZplRoute === 'native-linear').length,
            portableRaster: entries.filter(entry => entry.portableZplRoute === 'raster').length,
        },
        matrix: entries.map(entry => ({
            bcid: entry.bcid,
            dimension: entry.dimension,
            serverSupported: entry.serverSupported,
            gs1: entry.gs1,
            portableZplRoute: entry.portableZplRoute,
            zplFullNative: entry.zplFullNative,
            tsplFullNative: entry.tsplFullNative,
        })),
        matrixCases,
        realCases,
    };
    const reportPath = process.env.BARCODE_MATRIX_REPORT
        || path.join(root, 'artifacts', 'barcode-matrix-phase', 'barcode-matrix-report.json');
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    console.log(`barcode matrix: ${entries.length} symbologies x 3 DPI = ${matrixCases.length} generation/routing cases`);
    console.log(`barcode matrix: ${serverTypes.length} server types; ${report.summary.portableNative} native-linear; ${report.summary.portableRaster} portable raster`);
    console.log(`real templates: ${realTemplates.length} x 3 DPI = ${realCases.length} exact geometry cases (${report.source})`);
    console.log(`report: ${reportPath}`);
} finally {
    if (previousTsLoader) Module._extensions['.ts'] = previousTsLoader;
    else delete Module._extensions['.ts'];
}