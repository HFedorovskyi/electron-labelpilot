const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'src-tauri/slint/ui/weighing.slint'), 'utf8');

const pageStart = ui.indexOf('if root.active-page == 3: Rectangle {');
const pageEnd = ui.indexOf('if root.active-page == 4: Rectangle {', pageStart);
assert.ok(pageStart >= 0 && pageEnd > pageStart, 'printer settings page missing');
const page = ui.slice(pageStart, pageEnd);

for (const fragment of [
  'text: root.settings-page-title;',
  'text: root.settings-page-hint;',
  'text: root.settings-selected-role-display;',
  'text: root.settings-connection-title;',
  'text: root.settings-advanced-title;',
  'height: root.settings-advanced-visible',
  'vertical-scrollbar-policy: ScrollBarPolicy.always-off;',
  'horizontal-scrollbar-policy: ScrollBarPolicy.always-off;',
  'text: root.settings-test-label;',
  'text: root.settings-detect-label;',
  'text: root.settings-busy ? root.settings-saving-label : root.settings-save-label;',
]) assert.ok(page.includes(fragment), 'missing settings ergonomics contract: ' + fragment);

for (const fragment of [
  'text: root.settings-windows-label;',
  'subtext: root.settings-windows-hint;',
  'text: root.settings-network-label;',
  'subtext: root.settings-network-hint;',
  'text: root.settings-serial-label;',
  'subtext: root.settings-serial-hint;',
  'placeholder-text: root.settings-address-placeholder;',
  'text: root.settings-selected-device-label;',
  'viewport-y <=> root.settings-system-printer-scroll-y;',
  'viewport-y <=> root.settings-serial-port-scroll-y;',
  'root.settings-input-target = "printer-ip";',
  'root.settings-input-target = "printer-port";',
  'root.settings-input-target = "printer-baud";',
]) assert.ok(page.includes(fragment), 'missing friendly connection control: ' + fragment);

assert.match(page, /height: 68px;\s*text: root\.settings-auto-print-label \+ ": " \+ \(root\.settings-auto-print \? root\.settings-on-label : root\.settings-off-label\);\s*subtext: root\.settings-auto-print-hint;/);
assert.match(ui, /settings-auto-print-hint:[^\n]+"Печатать этикетку упаковки после стабилизации веса в пределах допуска"/);
assert.doesNotMatch(page, /settings-main-title|settings-use-printer-label|settings-disable-printer-label/);
assert.doesNotMatch(ui, /Использование принтера|Printer use|Drucker verwenden|Використання принтера/);

const roleCardsEnd = page.indexOf('ScrollView {');
const roleCards = page.slice(0, roleCardsEnd);
assert.ok(roleCards.includes('role.role == "packPrinter"'));
assert.ok(roleCards.includes('role.role == "boxPrinter"'));
assert.ok(!roleCards.includes('role.endpoint'), 'endpoint leaked into ordinary role card');
assert.ok(!roleCards.includes('role.protocol'), 'protocol leaked into ordinary role card');
assert.ok(!roleCards.includes('role.dpi'), 'DPI leaked into ordinary role card');

const advancedStart = page.indexOf('height: root.settings-advanced-visible');
assert.ok(advancedStart > 0, 'advanced settings card missing');
const ordinary = page.slice(0, advancedStart);
for (const technical of ['text: "ZPL";', 'text: "TSPL";', 'root.settings-preview-profile']) {
  assert.ok(!ordinary.includes(technical), technical + ' must remain behind advanced settings');
}
assert.ok(page.indexOf('text: "ZPL";') > advancedStart, 'printer language controls must remain available in advanced settings');
assert.match(ui, /in-out property <bool> settings-advanced-visible: false;/);

for (const prop of [
  'settings-page-title',
  'settings-page-hint',
  'settings-pack-role-label',
  'settings-auto-print-hint',
  'settings-connection-title',
  'settings-windows-label',
  'settings-network-label',
  'settings-serial-label',
  'settings-advanced-title',
  'settings-test-label',
  'settings-detect-label',
  'settings-save-label',
]) {
  const line = ui.split('\n').find((entry) => entry.includes('property <string> ' + prop + ':'));
  assert.ok(line, 'localized property missing: ' + prop);
  for (const locale of ['"en"', '"de"', '"uk"']) {
    assert.ok(line.includes('root.ui-language == ' + locale), prop + ' missing ' + locale + ' locale');
  }
}

assert.equal((ui.match(/queue-category: root\.settings-nav-queue-category;/g) || []).length, 4);
assert.match(ui, /property <string> settings-nav-diagnostics-label:[^\n]+"Проверка системы"/);
assert.doesNotMatch(page, /text: "DRIVER"|text: "ETHERNET"|text: "SERIAL"/);
assert.doesNotMatch(page, /ЯЗЫК И ПРОФИЛЬ|КАЧЕСТВО И ГРАФИКА|ОПРЕДЕЛИТЬ И ПРИМЕНИТЬ/);

for (const removedControl of [
  'text <=> root.settings-name;',
  'text <=> root.settings-darkness;',
  'text <=> root.settings-print-speed;',
  'text <=> root.settings-gap-mm;',
  'text <=> root.settings-width-mm;',
  'text <=> root.settings-height-mm;',
]) assert.ok(!page.includes(removedControl), 'operator-facing control must be removed: ' + removedControl);

for (const helpContract of [
  'ContextHelpButton {',
  'text: root.settings-language-help-text;',
  'text: root.settings-compatibility-help-text;',
  'root.settings-language-help-visible',
  'root.settings-compatibility-help-visible',
]) assert.ok(page.includes(helpContract), 'missing contextual help: ' + helpContract);

console.log('Slint settings ergonomics: device selection, contextual help, touch keyboard, touch scrolling and simplified printer controls verified');
