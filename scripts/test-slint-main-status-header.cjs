const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'src-tauri/slint/ui/weighing.slint'), 'utf8');
const occurrences = (text, needle) => text.split(needle).length - 1;
const headerStart = ui.indexOf('text: "Весовая станция";', ui.indexOf('width: root.page-width;'));
const headerEnd = ui.indexOf('text: "Поиск товара";', headerStart);
assert.ok(headerStart >= 0 && headerEnd > headerStart, 'main header section missing');
const header = ui.slice(headerStart, headerEnd);

for (const fragment of [
  'colorize: root.icon-color;',
  'height: root.short ? 76px : 82px;',
  'main-device-status-row := HorizontalLayout {',
  'height: root.compact ? 34px : 38px;',
  'text: root.scale-status;',
  'good: root.scale-online;',
  'icon: @image-url("../assets/icons/scale.png");',
  'text: root.printer-status;',
  'good: root.printer-ready;',
  'icon: @image-url("../assets/icons/printer.png");',
  'text: root.auto-print-enabled && root.auto-print-status != "" ? root.auto-print-status : root.auto-print-enabled ? root.jobs-auto-print-on-label : root.jobs-auto-print-off-label;',
  'good: root.auto-print-enabled;',
  'neutral: !root.auto-print-enabled;',
  'icon: @image-url("../assets/icons/refresh-cw.png");',
]) assert.ok(ui.includes(fragment), 'missing status header contract: ' + fragment);

assert.equal(occurrences(header, 'StatusPill {'), 3, 'main header must always render scale, printer and auto-print indicators');
assert.equal(
  occurrences(header, 'horizontal-stretch: 1;'),
  4,
  'title spacer plus all three main indicators must use equal adaptive stretch',
);
assert.ok(!header.includes('if root.auto-print-enabled'), 'disabled auto-print must remain visible as a neutral indicator');
assert.ok(!header.includes('!root.narrow: StatusPill'), 'auto-print indicator must remain visible on compact touch screens');
assert.ok(!header.includes('printer-green.png'), 'printer state must not use an always-green asset');
assert.ok(ui.includes('icon-color: root.neutral ? Palette.n500 : root.good ? Palette.e600 : Palette.r500;'));
assert.ok(ui.includes('in property <bool> neutral: false;'));
assert.ok(ui.includes('overflow: elide;'));

for (const property of ['jobs-auto-print-on-label', 'jobs-auto-print-off-label']) {
  const line = ui.split(String.fromCharCode(10)).find((candidate) => candidate.includes('property <string> ' + property + ':'));
  assert.ok(line, 'missing auto-print locale property: ' + property);
  for (const locale of ['"en"', '"de"', '"uk"']) {
    assert.ok(line.includes('root.ui-language == ' + locale), property + ' must support locale ' + locale);
  }
}

console.log('Slint main status header: three always-visible equal-width adaptive indicators, localized auto-print state and state-colored icons verified');
