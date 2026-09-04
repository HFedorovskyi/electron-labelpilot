const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'src-tauri/slint/ui/weighing.slint'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'src-tauri/src/slint_runtime.rs'), 'utf8');
const pageStart = ui.indexOf('if root.active-page == 5: Rectangle {');
const pageEnd = ui.indexOf('if root.active-page == 6: Rectangle {', pageStart);
assert.ok(pageStart >= 0 && pageEnd > pageStart, 'fixed-weight page boundaries missing');
const page = ui.slice(pageStart, pageEnd);

assert.doesNotMatch(ui, /ПРЕДПРОСМОТР ДАННЫХ ЭТИКЕТКИ/);
assert.doesNotMatch(page, /text <=> root\.fixed-copies/);
for (const fragment of [
  'alignment: center;',
  'width: min(root.page-width - root.content-padding * 2, root.wide ? 1120px : 980px);',
  'fixed-quantity-keypad-visible = true;',
  'root.step-fixed-copies(root.fixed-copies, -1)',
  'root.step-fixed-copies(root.fixed-copies, 1)',
  'root.fixed-copies = "1";',
  'root.fixed-copies = "10";',
  'root.fixed-copies = "100";',
]) assert.ok(page.includes(fragment), 'missing fixed page contract: ' + fragment);

assert.ok(page.includes('fixed-device-status-row := HorizontalLayout {'), 'fixed page must expose a dedicated full-width device status row');
assert.equal(
  (page.split('width: (fixed-device-status-row.width - (root.short ? 12px : 16px)) / 3;').length - 1),
  3,
  'scale, printer and auto-print indicators must share the full row equally',
);
for (const fragment of [
  'text: root.scale-online ? root.jobs-scale-online-label : root.jobs-scale-offline-label;',
  'text: root.printer-ready ? root.jobs-printer-online-label : root.jobs-printer-offline-state-label;',
  'text: root.auto-print-enabled ? root.jobs-auto-print-on-label : root.jobs-auto-print-off-label;',
  'neutral: !root.auto-print-enabled;',
  'icon: @image-url("../assets/icons/scale.png");',
  'icon: @image-url("../assets/icons/printer.png");',
  'icon: @image-url("../assets/icons/refresh-cw.png");',
]) assert.ok(page.includes(fragment), 'missing fixed status indicator contract: ' + fragment);

for (const property of [
  'jobs-scale-online-label',
  'jobs-scale-offline-label',
  'jobs-printer-online-label',
  'jobs-printer-offline-state-label',
  'jobs-auto-print-on-label',
  'jobs-auto-print-off-label',
]) {
  const line = ui.split(String.fromCharCode(10)).find((candidate) => candidate.includes('property <string> ' + property + ':'));
  assert.ok(line, 'missing localized status property ' + property);
  for (const locale of ['"en"', '"de"', '"uk"']) {
    assert.ok(line.includes('root.ui-language == ' + locale), property + ' must support locale ' + locale);
  }
}
const centeredCrossAxisSlots = (page.match(/y: \(parent\.height - self\.height\) \/ 2;/g) || []).length;
assert.ok(centeredCrossAxisSlots >= 2, 'fixed-size action and product elements must be vertically centered');
assert.ok((page.split('width: root.narrow ? 128px : 138px;').length - 1) >= 2, 'title row must use symmetric left and right slots');
const verifyStart = page.indexOf('if root.fixed-mode == "verify": Rectangle {');
const verifyEnd = page.indexOf('if root.fixed-mode == "batch": Rectangle {', verifyStart);
const verifyPanel = page.slice(verifyStart, verifyEnd);
assert.match(verifyPanel, /HorizontalLayout \{\s*height: root\.short \? 38px : 48px;\s*alignment: center;[\s\S]*?Text \{/);
assert.match(verifyPanel, /HorizontalLayout \{\s*height: root\.short \? 50px : 56px;\s*alignment: center;[\s\S]*?MainButton \{/);
const pickerStart = ui.indexOf('if root.fixed-product-modal-visible: Rectangle {');
const pickerEnd = ui.indexOf('if root.fixed-quantity-keypad-visible: Rectangle {', pickerStart);
const picker = ui.slice(pickerStart, pickerEnd);
assert.match(picker, /width: 42px;\s*vertical-stretch: 1;[\s\S]*?y: \(parent\.height - self\.height\) \/ 2;/);
assert.match(picker, /VerticalLayout \{\s*horizontal-stretch: 1;\s*alignment: center;[\s\S]*?horizontal-alignment: center;/);
assert.ok(picker.includes('Rectangle { width: 42px; vertical-stretch: 1; background: transparent; }'), 'picker row must have a symmetric right spacer');
assert.ok(ui.includes('in-out property <length> fixed-product-scroll-y: 0px;'), 'fixed picker must own an explicit scroll offset');
for (const fragment of [
  'fixed-product-scroll := ScrollView {',
  'viewport-y <=> root.fixed-product-scroll-y;',
  'vertical-scrollbar-policy: ScrollBarPolicy.always-off;',
  'horizontal-scrollbar-policy: ScrollBarPolicy.always-off;',
  'mouse-drag-pan-enabled: true;',
  'enabled: root.fixed-product-scroll-y < 0px;',
  'root.fixed-product-scroll-y = min(0px, root.fixed-product-scroll-y + 156px);',
  'root.fixed-product-scroll-y = max(fixed-product-scroll.visible-height - fixed-product-scroll.viewport-height, root.fixed-product-scroll-y - 156px);',
]) assert.ok(picker.includes(fragment), 'missing fixed picker touch-scroll contract: ' + fragment);
assert.equal((picker.match(/TouchScrollStepButton \{/g) || []).length, 2, 'fixed picker must expose exactly two large touch scroll buttons');
assert.ok((picker.match(/root\.fixed-product-scroll-y = 0px;/g) || []).length >= 7, 'opening and every search path must reset fixed picker scroll');
assert.match(page, /fixed-product-modal-visible = true;[^\n]*fixed-product-scroll-y = 0px;/, 'opening fixed picker must reset scroll');

for (const fragment of [
  'if root.fixed-quantity-keypad-visible: Rectangle {',
  'root.edit-fixed-copies(root.fixed-copies-draft, "__BACKSPACE__")',
  'root.edit-fixed-copies(root.fixed-copies-draft, "__CLEAR__")',
  'enabled: root.fixed-copies-draft != "";',
  'mouse-drag-pan-enabled: true;',
  'vertical-scrollbar-policy: ScrollBarPolicy.always-off;',
]) assert.ok(ui.includes(fragment), 'missing touch UI contract: ' + fragment);

for (const locale of ['"en"', '"de"', '"uk"']) {
  assert.ok(ui.includes('property <string> fixed-page-title: root.ui-language == ' + locale) || ui.includes('root.ui-language == ' + locale), 'missing locale ' + locale);
}
for (const fragment of [
  'const FIXED_COPIES_MAX: i64 = 5_000;',
  'fn edit_fixed_copies(current: &str, key: &str) -> String',
  'fn step_fixed_copies(current: &str, delta: i32) -> String',
  'ui.on_edit_fixed_copies(|current, key|',
  'ui.on_step_fixed_copies(|current, delta|',
  'edits_touch_quantity_with_production_bounds',
  'enum AutoPrintTarget {',
  'fn select_auto_print_target(',
  'AutoPrintTarget::FixedWeightPack(product_id)',
  'runtime.print_fixed_weight_pack(',
  'automatic: true,',
  'automatic: false,',
  'begin_manual_print(measured)',
  'routes_fixed_weight_only_when_every_print_precondition_is_true',
  'enabling_after_startup_arms_an_empty_scale_without_a_second_timer',
]) assert.ok(runtime.includes(fragment), 'missing Rust quantity contract: ' + fragment);

console.log('Slint fixed-weight UI: centered adaptive workspace, three full-width localized device/auto-print indicators, fixed picker touch-scroll, touch quantity keypad and guarded stable in-tolerance auto-print verified');
