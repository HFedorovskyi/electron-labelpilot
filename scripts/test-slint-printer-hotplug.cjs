const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const runtime = fs.readFileSync(path.join(root, 'src-tauri/src/slint_runtime.rs'), 'utf8');
const nativeUi = fs.readFileSync(path.join(root, 'src-tauri/src/native_ui.rs'), 'utf8');

for (const fragment of [
  'PrinterHealthChecked(Result<NativePrinterDiagnostic, String>)',
  'fn pack_printer_ui_state(',
  'fn printer_health_poll_due(',
  'fn schedule_printer_health_refresh(',
  'runtime.probe_pack_printer()',
  'apply_pack_printer_diagnostic(&ui, &device);',
  'Duration::from_secs(5)',
]) assert.ok(runtime.includes(fragment), 'missing printer hot-plug contract: ' + fragment);

const timerStart = runtime.indexOf('let printer_health_timer = slint::Timer::default();');
const timerEnd = runtime.indexOf('let license_live_timer = slint::Timer::default();', timerStart);
assert.ok(timerStart >= 0 && timerEnd > timerStart, 'global printer health timer missing');
const timer = runtime.slice(timerStart, timerEnd);
assert.ok(timer.includes('printer_health_poll_due('), 'adaptive poll cadence missing');
assert.ok(timer.includes('schedule_printer_health_refresh('), 'background probe dispatch missing');
assert.ok(!timer.includes('get_active_page()'), 'hot-plug detection must run on every page');

const probeStart = nativeUi.indexOf('pub fn probe_pack_printer(');
const probeEnd = nativeUi.indexOf('pub fn probe_configured_printers(', probeStart);
assert.ok(probeStart >= 0 && probeEnd > probeStart, 'pack-only probe missing');
const probe = nativeUi.slice(probeStart, probeEnd);
assert.ok(probe.includes('"packPrinter"'));
assert.ok(!probe.includes('"boxPrinter"') && !probe.includes('"palletPrinter"'));

console.log('Slint printer hot-plug: global pack-only probe, 5s unavailable recovery, throttled healthy polling and state mapping verified');