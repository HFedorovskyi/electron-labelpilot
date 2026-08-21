'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const component = read('src/renderer/components/PrinterDiagnostics.tsx');
const helper = read('src/renderer/platform/printerDiagnostics.ts');
const bridge = read('src/renderer/platform/tauriBridge.ts');
const app = read('src/renderer/App.tsx');
const sidebar = read('src/renderer/components/Sidebar.tsx');
const translations = read('src/shared/i18n_data.ts');
const rust = read('src-tauri/src/diagnostic.rs');
const commands = read('src-tauri/src/commands.rs');
const runtime = read('src-tauri/src/lib.rs');

assert.match(app, /lazy\(\(\) => import\('\.\/components\/PrinterDiagnostics'\)\)/, 'diagnostics must be lazy');
assert.match(app, /activeTab === 'printerDiagnostics'/);
assert.match(sidebar, /id: 'printerDiagnostics'/);
assert.match(sidebar, /overflow-y-auto overscroll-contain/, 'sidebar must remain usable at 1366x768');
assert.match(component, /data-testid="printer-diagnostics"/);
assert.match(component, /min-h-12/g, 'touch controls must be at least 48px high');
assert.match(component, /xl:grid-cols-3/, 'three role cards should fit the workstation viewport');
assert.doesNotMatch(component + helper, /setInterval\(/, 'diagnostics must not poll printers in background');
assert.match(helper, /queryTauriPrinterStatus/);
assert.match(helper, /Promise\.allSettled/);
assert.match(helper, /printTauriLabel/);
assert.match(helper, /jobIdempotencyKey: `printer-calibration:/);
assert.match(helper, /widthCm: safeWidth \/ 10/);
assert.match(helper, /heightCm: safeHeight \/ 10/);
assert.match(helper, /barcodeType: 'code128'/);
assert.match(helper, /barcodeType: 'qrcode'/);
assert.match(helper, /PUBLIC_CONFIG_KEYS/, 'export must whitelist printer config fields');
assert.match(helper, /kind: 'labelpilot-printer-diagnostic'/);
assert.match(bridge, /desktop_printer_export_diagnostic/);
assert.match(commands, /fn desktop_printer_export_diagnostic/);
assert.match(runtime, /commands::desktop_printer_export_diagnostic/);
assert.match(rust, /MAX_DIAGNOSTIC_REPORT_BYTES: usize = 2 \* 1024 \* 1024/);
assert.match(rust, /MAX_DIAGNOSTIC_BUNDLE_BYTES: usize = 4 \* 1024 \* 1024/);
assert.match(rust, /MoveFileExW/);
assert.match(rust, /CompressionMethod::Stored/);
assert.match(rust, /diagnostic-report\.json/);
assert.match(rust, /manifest\.json/);
for (const key of [
    'sidebar.printerDiagnostics', 'diagnostics.title', 'diagnostics.runAll',
    'diagnostics.calibrate', 'diagnostics.confirmTitle', 'diagnostics.reportExported',
]) {
    const occurrences = [...translations.matchAll(new RegExp(`'${key.replaceAll('.', '\\.')}'`, 'g'))].length;
    assert.equal(occurrences, 4, `${key} must exist in RU/EN/DE/UK`);
}
console.log('printer diagnostics: lazy touch UI, 3 roles, on-demand probe, exact-size calibration');
console.log('diagnostic export: sanitized bounded JSON/ZIP, SHA-256 manifest, atomic replace');
