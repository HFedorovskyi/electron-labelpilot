'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const component = read('src/renderer/components/PrintQueueMonitor.tsx');
const app = read('src/renderer/App.tsx');
const sidebar = read('src/renderer/components/Sidebar.tsx');
const bridge = read('src/renderer/platform/tauriBridge.ts');
const compatibility = read('src/renderer/platform/tauriUiCompatibility.ts');
const status = read('src-tauri/src/printer/status.rs');
const spooler = read('src-tauri/src/printer/spooler.rs');
const commands = read('src-tauri/src/commands.rs');
const printer = read('src-tauri/src/printer.rs');
const runtime = read('src-tauri/src/lib.rs');
const i18n = read('src/shared/i18n_data.ts');

assert.match(app, /lazy\(\(\) => import\('\.\/components\/PrintQueueMonitor'\)\)/);
assert.match(app, /activeTab === 'printQueue'/);
assert.match(sidebar, /id: 'printQueue'/);
assert.match(sidebar, /labelKey: 'sidebar\.printQueue'/);
assert.match(component, /data-testid="print-queue-monitor"/);
assert.match(component, /getTauriDurablePrintJobs\(undefined, 200\)/);
assert.match(component, /document\.visibilityState === 'visible'/);
assert.match(component, /}, 5_000\)/);
assert.match(component, /listenTauriDurablePrintJobs\(scheduleRefresh\)/);
assert.match(component, /ATTENTION_STATES.*uncertain.*failed/s);
assert.match(component, /job\.state === 'uncertain'.*setConfirmRetry/s);
assert.match(i18n, /A retry can print a duplicate/);
assert.match(i18n, /Повтор может напечатать дубликат/);
assert.match(component, /min-h-12/);
assert.match(component, /lg:grid-cols-3/);
assert.match(component, /queryTauriPrinterStatus\(config\)/);
assert.doesNotMatch(component, /setInterval\([^)]*queryTauriPrinterStatus/s);

for (const marker of [
    'desktop_printer_query_status',
    'TauriPrinterStatusReport',
    'queryTauriPrinterStatus',
]) {
    assert.ok(bridge.includes(marker), `Renderer status bridge marker missing: ${marker}`);
}
assert.match(compatibility, /const statusReport = await queryTauriPrinterStatus\(config\)/);
assert.match(compatibility, /supportsBidirectionalStatus: statusReport\.supportsBidirectionalStatus/);
assert.match(commands, /pub async fn desktop_printer_query_status/);
assert.match(commands, /query_printer_status_routed\(RuntimeEventSink::tauri\(app\), &printer, payload\)/);
assert.match(printer, /query_printer_status_with_sink/);
assert.match(printer, /worker_holds_serial/);
assert.match(runtime, /commands::desktop_printer_query_status/);

assert.match(status, /STATUS_CONNECT_TIMEOUT: Duration = Duration::from_millis\(1_500\)/);
assert.match(status, /STATUS_IO_TIMEOUT: Duration = Duration::from_millis\(700\)/);
assert.match(status, /MAX_STATUS_RESPONSE_BYTES: usize = 4 \* 1024/);
assert.match(status, /MAX_STATUS_PREVIEW_BYTES: usize = 256/);
assert.match(status, /Some\(b"~HS\\r\\n"\)/);
assert.match(status, /Some\(b"\\x1b!\?"\)/);
assert.match(status, /"epl"/);
assert.match(status, /"cpcl"/);
assert.match(status, /"dpl"/);
assert.match(status, /"sbpl"/);
assert.match(status, /response\s*\.iter\(\)\s*\.take\(128\)/);
assert.match(status, /spooler::query_status\(config\)/);
assert.match(spooler, /GetPrinterW/);
assert.match(spooler, /PRINTER_INFO_6/);
assert.match(spooler, /\s6,\s/);

const translationKeys = [
    'sidebar.printQueue',
    'queue.title',
    'queue.filterAttention',
    'queue.checkPrinters',
    'queue.retryUncertainTitle',
    'queue.retryUncertainText',
    'queue.state.queued',
    'queue.state.rendering',
    'queue.state.sending',
    'queue.state.accepted',
    'queue.state.uncertain',
    'queue.state.failed',
    'queue.state.cancelled',
];
for (const key of translationKeys) {
    const count = [...i18n.matchAll(new RegExp(`'${key.replaceAll('.', '\\.')}'`, 'g'))].length;
    assert.equal(count, 4, `${key} must exist exactly once in RU/EN/DE/UK`);
}

console.log('Operator print queue: lazy touch UI, 200-row bound, event refresh + visible-only 5s reconciliation');
console.log('Recovery controls: failed retry/cancel and explicit duplicate warning for uncertain jobs');
console.log('Status queries: bounded ZPL/TSPL bidirectional probes, generic transport reachability, Win32 spooler flags');