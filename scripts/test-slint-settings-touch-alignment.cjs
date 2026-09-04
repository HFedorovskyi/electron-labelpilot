const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'src-tauri/slint/ui/weighing.slint'), 'utf8');

function page(number, nextNumber) {
  const start = ui.indexOf(`if root.active-page == ${number}: Rectangle {`);
  const end = ui.indexOf(`if root.active-page == ${nextNumber}: Rectangle {`, start);
  assert.ok(start >= 0 && end > start, `page ${number} missing`);
  return ui.slice(start, end);
}

function assertLocalized(propertyName) {
  const line = ui.split('\n').find((entry) =>
    entry.includes(`property <string> ${propertyName}:`));
  assert.ok(line, `localized property missing: ${propertyName}`);
  for (const locale of ['"en"', '"de"', '"uk"']) {
    assert.ok(line.includes(`root.ui-language == ${locale}`),
      `${propertyName} missing ${locale}`);
  }
}

const queue = page(1, 2);
const printers = page(3, 4);
const scales = page(4, 5);
const keyboard = ui.slice(ui.indexOf('if root.settings-input-keyboard-visible: Rectangle {'));

for (const hidden of [
  'text <=> root.settings-name;',
  'text <=> root.settings-darkness;',
  'text <=> root.settings-print-speed;',
  'text <=> root.settings-gap-mm;',
  'text <=> root.settings-width-mm;',
  'text <=> root.settings-height-mm;',
]) {
  assert.ok(!printers.includes(hidden), `obsolete operator control visible: ${hidden}`);
}

for (const fragment of [
  'ContextHelpButton {',
  'text: root.settings-language-help-text;',
  'text: root.settings-compatibility-help-text;',
  'root.settings-language-help-visible',
  'root.settings-compatibility-help-visible',
]) {
  assert.ok(printers.includes(fragment), `context help missing: ${fragment}`);
}

for (const fragment of [
  'viewport-y <=> root.settings-system-printer-scroll-y;',
  'viewport-y <=> root.settings-serial-port-scroll-y;',
  'printer-system-scroll := ScrollView {',
  'printer-serial-scroll := ScrollView {',
  'mouse-drag-pan-enabled: true;',
  'TouchScrollStepButton { glyph: "▲";',
  'TouchScrollStepButton { glyph: "▼";',
  'root.settings-input-target = "printer-ip";',
  'root.settings-input-target = "printer-port";',
  'root.settings-input-target = "printer-baud";',
]) {
  assert.ok(printers.includes(fragment), `printer touch contract missing: ${fragment}`);
}

for (const fragment of [
  'scale-page-scroll := ScrollView {',
  'viewport-y <=> root.scale-settings-page-scroll-y;',
  'scale-serial-scroll := ScrollView {',
  'viewport-y <=> root.scale-settings-serial-scroll-y;',
  'scale-protocol-scroll := ScrollView {',
  'viewport-y <=> root.scale-settings-protocol-scroll-y;',
  'root.settings-input-target = "scale-host";',
  'root.settings-input-target = "scale-port";',
  'root.settings-input-target = "scale-baud";',
  'horizontal-alignment: center;',
  'alignment: center;',
]) {
  assert.ok(scales.includes(fragment), `scale touch/alignment contract missing: ${fragment}`);
}
assert.ok(!scales.includes('text <=> root.scale-settings-polling;'),
  'manual polling field should not clutter the touchscreen page');
assert.ok(!scales.includes('text <=> root.scale-settings-stability-count;'),
  'manual stability field should not clutter the touchscreen page');

for (const fragment of [
  'TouchKeyboard {',
  'roomy: true;',
  'root.settings-input-draft = root.edit-touch-text',
  'root.settings-ip = root.settings-input-draft;',
  'root.scale-settings-host = root.settings-input-draft;',
  'root.scale-settings-port = root.settings-input-draft;',
]) {
  assert.ok(keyboard.includes(fragment), `shared touch keyboard contract missing: ${fragment}`);
}

const summaryStart = ui.indexOf('component QueueSummaryCard inherits Rectangle {');
const summaryEnd = ui.indexOf('component ProductionJobMetricCard', summaryStart);
const summary = ui.slice(summaryStart, summaryEnd);
assert.ok(summary.includes('horizontal-alignment: center;'));
assert.ok(queue.includes('y: (parent.height - self.height) / 2;'));
assert.ok(queue.includes('alignment: center;'));
assert.ok(queue.includes('vertical-scrollbar-policy: ScrollBarPolicy.always-off;'));
assert.ok(queue.includes('mouse-drag-pan-enabled: true;'));

for (const propertyName of [
  'settings-language-help-text',
  'settings-compatibility-help-text',
  'settings-input-dialog-title',
  'settings-printer-address-label',
  'settings-scale-address-label',
  'scale-page-title-label',
  'scale-connection-label',
  'scale-stability-label',
  'scale-protocols-label',
  'scale-save-label',
]) assertLocalized(propertyName);

console.log('Slint touch settings: simplified printer controls, contextual help, centered queue/scales, on-screen TCP input and arrow-assisted device lists verified');
