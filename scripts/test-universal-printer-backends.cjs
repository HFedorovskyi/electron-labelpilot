'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const backend = read('src-tauri/src/printer/backend.rs');
const printer = read('src-tauri/src/printer.rs');
const spooler = read('src-tauri/src/printer/spooler.rs');
const commands = read('src-tauri/src/commands.rs');
const runtime = read('src-tauri/src/lib.rs');
const orchestrator = read('src/renderer/platform/tauriPrintOrchestrator.ts');
const bitmap = read('src/renderer/platform/tauriBitmapFallback.ts');
const pallet = read('src/renderer/utils/palletPrint.ts');
const bridge = read('src/renderer/platform/tauriBridge.ts');

for (const target of ['label-roll', 'page-sheet']) assert.ok(backend.includes(`"${target}"`));
for (const name of ['zpl-hybrid', 'tspl-hybrid', 'zpl-bitmap', 'epl-raster', 'cpcl-raster', 'dpl-raster', 'sbpl-raster', 'windows-gdi-label', 'windows-gdi-page']) {
    assert.ok(backend.includes(`"${name}"`), `${name} backend is missing`);
}
for (const language of ['epl', 'cpcl', 'dpl', 'sbpl']) {
    assert.ok(backend.includes(`"${language}"`), `${language} extension slot is missing`);
}
assert.match(backend, /PAGE_RASTER_DPI_CAP: u16 = 300/);
assert.match(backend, /dpi\.min\(PAGE_RASTER_DPI_CAP\)/);
assert.match(backend, /page-sheet:windows-driver-required/);
assert.match(backend, /labelType/);

for (const command of ['desktop_printer_plan_backend', 'desktop_printer_send_driver_page']) {
    assert.ok(commands.includes(`fn ${command}`), `${command} implementation is missing`);
    assert.ok(runtime.includes(`commands::${command}`), `${command} registration is missing`);
    assert.ok(orchestrator.includes(`'${command}'`), `${command} renderer route is missing`);
}
assert.ok(
    orchestrator.indexOf("'desktop_printer_plan_backend'") < orchestrator.indexOf("'desktop_printer_plan_generation'"),
    'backend/target planning must happen before language generation planning',
);
assert.match(orchestrator, /backendPlan\.printTarget === 'page-sheet'/);
assert.match(orchestrator, /dpi: backendPlan\.rasterDpi/);
assert.match(orchestrator, /pageWidthMm: backendPlan\.pageWidthMm/);
assert.match(orchestrator, /fitMode: backendPlan\.fitMode/);
assert.match(pallet, /palletPrinter\.connection === 'windows_driver'/);
assert.match(pallet, /printTarget: 'page-sheet'/);
assert.match(pallet, /printTarget: palletPrinter\.printTarget \|\| 'label-roll'/);

for (const api of ['GetDeviceCaps', 'StretchDIBits', 'StartDocW', 'StartPage', 'EndPage', 'EndDoc']) {
    assert.ok(spooler.includes(api), `${api} is missing from page-sheet GDI backend`);
}
for (const metric of ['HORZRES', 'VERTRES', 'LOGPIXELSX', 'LOGPIXELSY']) {
    assert.ok(spooler.includes(metric), `${metric} page metric is missing`);
}
assert.match(spooler, /fn page_destination\(/);
assert.match(spooler, /page\.margins_mm\.left/);
assert.match(spooler, /page\.fit_mode == "actual-size"/);
assert.match(printer, /JobAction::DriverPage/);
assert.match(printer, /driver_page_jobs/);
assert.match(bridge, /driverPageJobs: number/);
assert.match(bridge, /supportedPrintTargets: string\[\]/);

const maxPixels = Number(bitmap.match(/MAX_BITMAP_PIXELS = ([\d_]+)/)?.[1].replaceAll('_', ''));
const a4Width300 = Math.round(210 * 300 / 25.4);
const a4Height300 = Math.round(297 * 300 / 25.4);
const rgbaBytes = a4Width300 * a4Height300 * 4;
const monoBytes = Math.ceil(a4Width300 / 8) * a4Height300;
assert.equal(a4Width300, 2480);
assert.equal(a4Height300, 3508);
assert.ok(a4Width300 * a4Height300 <= maxPixels, 'A4 at 300 DPI must fit the bounded canvas');
assert.ok(rgbaBytes < 36 * 1024 * 1024, 'A4 transient RGBA buffer must stay below 36 MiB');
assert.ok(monoBytes < 2 * 1024 * 1024, 'A4 queued mono page must stay below 2 MiB');
assert.equal(maxPixels, 9_000_000);

console.log('universal printer targets: label-roll + page-sheet');
console.log('active backends: ZPL/TSPL hybrid, ZPL/EPL/CPCL/DPL/SBPL raster, Windows GDI label/page');
console.log(`A4 bounded raster: ${a4Width300}x${a4Height300}, RGBA ${(rgbaBytes / 1048576).toFixed(2)} MiB, mono ${(monoBytes / 1048576).toFixed(2)} MiB`);
console.log('pallet routes: Windows driver -> page-sheet; industrial TCP/Serial -> label-roll');