'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const config = JSON.parse(read('src-tauri/tauri.conf.json'));
const capability = JSON.parse(read('src-tauri/capabilities/default.json'));
const cargo = read('src-tauri/Cargo.toml');
const commands = read('src-tauri/src/commands.rs');
const runtime = read('src-tauri/src/lib.rs');
const adapter = read('src/renderer/platform/tauriBridge.ts');
const printOrchestrator = read('src/renderer/platform/tauriPrintOrchestrator.ts');
const uiCompatibility = read('src/renderer/platform/tauriUiCompatibility.ts');
const tauriEntry = read('src/main.tsx');
const printerSurface = adapter + printOrchestrator + uiCompatibility;
const vite = read('vite.config.ts');
const packageJson = JSON.parse(read('package.json'));

assert.equal(config.build.devUrl, 'http://127.0.0.1:5173');
assert.equal(config.build.frontendDist, '../dist');
assert.equal(config.app.windows[0].url, 'index.html');
assert.equal(config.app.windows[0].fullscreen, true, 'Production workstation UI must start in fullscreen mode');
assert.match(config.app.windows[0].additionalBrowserArgs, /--disable-background-networking/);
assert.match(config.app.windows[0].additionalBrowserArgs, /msSmartScreenProtection/);
assert.equal(config.bundle.active, true, 'Release packaging must emit the configured Windows installer');
assert.deepEqual(capability.windows, ['main']);
assert.ok(capability.permissions.includes('core:default'));
assert.match(cargo, /tauri = \{ version = "2\.11\.5"/);
assert.match(cargo, /labelpilot-contracts = \{ path = "\.\.\/native\/labelpilot-contracts" \}/);
assert.match(cargo, /reqwest = \{ version = "0\.13\.4"/);
assert.match(cargo, /ed25519-dalek = "2\.2\.0"/);
assert.match(cargo, /rusqlite = \{ version = "0\.40\.2"/);
assert.match(cargo, /serialport = \{ version = "4"/);

const commandNames = [...commands.matchAll(/pub (?:async )?fn (desktop_[a-z_]+)/g)].map(match => match[1]).sort();
assert.equal(commandNames.length, 87, 'Unexpected Tauri command count');
assert.equal(new Set(commandNames).size, commandNames.length, 'Tauri command names must be unique');
for (const command of commandNames) {
    assert.match(runtime, new RegExp(`commands::${command}`), `${command} is not registered`);
}
for (const channel of [
    'updater:get-version', 'open-logs-folder', 'log-to-main', 'quit-app',
    'get-scale-config', 'save-scale-config', 'connect-scale', 'disconnect-scale',
    'get-scale-status', 'get-serial-ports', 'get-protocols', 'get-numbering-config', 'save-numbering-config',
    'get-printer-config', 'save-printer-config', 'get-identity', 'get-next-sequence',
    'sync-data', 'get-server-status', 'get-license-status', 'set-app-mode', 'renderer-ready',
    'get-station-info', 'get-products', 'get-fixed-weight-products', 'get-containers',
    'get-label', 'get-all-labels', 'get-barcode-template', 'get-printers',
    'get-print-jobs', 'update-print-job-progress', 'complete-print-job', 'delete-print-job',
    'record-pack', 'record-and-print', 'close-box', 'get-latest-counters', 'get-open-pallet-content',
    'get-pallet-render-data', 'close-pallet', 'delete-pack', 'delete-box',
    'operators:list', 'session:get', 'session:set', 'session:logout', 'print-label',
    'detect-printer-capabilities', 'test-print', 'printer:warmup', 'printer:warmup-bg', 'demo:status',
]) {
    assert.ok(adapter.includes(`'${channel}'`), `${channel} is not mapped in the Tauri adapter`);
}
for (const marker of [
    'desktop_telemetry_summary',
    'desktop_telemetry_flush',
    'getTauriTelemetrySummary',
    'flushTauriTelemetry',
    'desktop_printer_send_driver_bitmap',
    'desktop_printer_send_driver_page',
    'desktop_printer_plan_backend',
    'desktop_printer_send_fallback_raw',
    'desktop_printer_send_raw',
    'desktop_printer_warmup_raw',
    'desktop_printer_transport_summary',
    'desktop_printer_disconnect_all',
    'desktop_printer_query_status',
    'desktop_printer_export_diagnostic',
    'desktop_printer_durable_jobs',
    'desktop_printer_durable_summary',
    'desktop_printer_retry_durable',
    'desktop_printer_cancel_durable',
    'getTauriDurablePrintJobs',
    'getTauriDurableQueueSummary',
    'retryTauriDurablePrintJob',
    'cancelTauriDurablePrintJob',
    'listenTauriDurablePrintJobs',
    'sendTauriRawPrint',
    'getTauriPrinterTransportSummary',
    'generateAndSendTauriNativeLabel',
    'generateTauriNativeLabel',
    'getTauriPrinterGeneratorSummary',
    'planTauriPrinterGeneration',
    'planTauriPrinterBackend',
    'printTauriLabel',
    'recordAndPrintTauri',
    'detectTauriPrinterCapabilities',
    'testTauriPrinter',
    'warmupConfiguredTauriPrinters',
]) {
    assert.ok(printerSurface.includes(marker), `${marker} is absent from the Tauri printer bridge`);
}
assert.match(vite, /main:\s*'index\.html'/);
assert.doesNotMatch(vite, /print:\s*|tauri:\s*/, 'Vite must expose one production entrypoint');
assert.match(tauriEntry, /import App from '\.\/renderer\/App'/);
assert.match(tauriEntry, /diagnostics \? <MigrationRuntimeScreen bridge=\{bridge\} \/> : <App \/>/);
assert.equal(packageJson.scripts['tauri:build'], 'tauri build --bundles nsis');
assert.equal(packageJson.scripts['tauri:build:binary'], 'tauri build --no-bundle');
assert.equal(packageJson.scripts['tauri:check'], 'cargo check --tests --manifest-path src-tauri/Cargo.toml');
assert.match(commands, /name\("labelpilot-shutdown"\.to_owned\(\)\)/, 'Shutdown must run outside the Tauri event-loop thread');
assert.match(commands, /shutdown stage complete: network/, 'Shutdown must log the network join boundary');
assert.match(commands, /compare_exchange\(false, true/, 'Repeated quit requests must be idempotent');

const tauriHtml = read('dist/index.html');
const jsMatch = tauriHtml.match(/src="\.\/assets\/(main-[^"]+\.js)"/);
const cssMatch = tauriHtml.match(/href="\.\/assets\/(main-[^"]+\.css)"/);
assert.ok(jsMatch, 'Tauri main JavaScript was not emitted');
assert.ok(cssMatch, 'Tauri main CSS was not emitted');
const jsBytes = fs.statSync(path.join(root, 'dist', 'assets', jsMatch[1])).size;
const cssBytes = fs.statSync(path.join(root, 'dist', 'assets', cssMatch[1])).size;
assert.ok(jsBytes < 160 * 1024, `Tauri entry JavaScript is unexpectedly large: ${jsBytes}`);
assert.ok(cssBytes < 120 * 1024, `Tauri entry CSS is unexpectedly large: ${cssBytes}`);

console.log(`Tauri full UI runtime: ${commandNames.length} Rust commands registered`);
console.log(`Tauri entry assets: JS ${jsBytes} bytes, CSS ${cssBytes} bytes`);
console.log('Tauri packaging mode: full UI runtime, NSIS release plus standalone binary');
