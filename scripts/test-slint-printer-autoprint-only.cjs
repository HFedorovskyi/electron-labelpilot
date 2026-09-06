const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'src-tauri/slint/ui/weighing.slint'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'src-tauri/src/slint_runtime.rs'), 'utf8');

const start = ui.indexOf('if root.active-page == 3: Rectangle {');
const end = ui.indexOf('if root.active-page == 4: Rectangle {', start);
assert.ok(start >= 0 && end > start, 'printer settings page missing');
const page = ui.slice(start, end);

for (const removed of [
  'settings-main-title',
  'settings-use-printer-label',
  'settings-disable-printer-label',
  'Использование принтера',
  'Printer use',
  'Drucker verwenden',
  'Використання принтера',
]) assert.ok(!ui.includes(removed), 'obsolete printer-use control remains: ' + removed);

assert.match(page, /if root\.settings-selected-role == "packPrinter": Rectangle \{[\s\S]*?height: 96px;[\s\S]*?height: 68px;\s*text: root\.settings-auto-print-label/);
assert.match(page, /clicked => \{ root\.settings-auto-print = !root\.settings-auto-print; root\.settings-dirty = true; \}/);
assert.match(ui, /settings-auto-print-label:[^\n]+root\.ui-language == "en"[^\n]+root\.ui-language == "de"[^\n]+root\.ui-language == "uk"/);
assert.match(ui, /settings-auto-print-hint:[^\n]+root\.ui-language == "en"[^\n]+root\.ui-language == "de"[^\n]+root\.ui-language == "uk"/);
assert.match(runtime, /NativePrinterRoleSettingsInput \{[\s\S]*?role: ui\.get_settings_selected_role\(\)\.to_string\(\),\s*\/\/ A configured printer is always enabled\.[\s\S]*?active: true,/);
assert.doesNotMatch(runtime, /active: ui\.get_settings_active\(\),/);

console.log('Slint printer settings: printer-use switch removed, configured printer always enabled, localized auto-print control retained');
