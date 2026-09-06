const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'src-tauri/slint/ui/weighing.slint'), 'utf8');
const collapseIcon = fs.readFileSync(path.join(root, 'src-tauri/slint/assets/icons/sidebar-collapse.svg'), 'utf8');
const expandIcon = fs.readFileSync(path.join(root, 'src-tauri/slint/assets/icons/sidebar-expand.svg'), 'utf8');
const sidebarLogo = fs.readFileSync(path.join(root, 'src-tauri/slint/assets/sidebar-logo.svg'), 'utf8');
const originalSidebarLogo = fs.readFileSync(path.join(root, 'public/sidebar-logo.svg'), 'utf8');

const sidebarStart = ui.indexOf('header := Rectangle {');
const sidebarEnd = ui.indexOf('sidebar-info-card := Rectangle {', sidebarStart);
assert.ok(sidebarStart >= 0 && sidebarEnd > sidebarStart, 'sidebar block missing');
const sidebar = ui.slice(sidebarStart, sidebarEnd);

for (const fragment of [
  'source: @image-url("../assets/sidebar-logo.svg");',
  'image-fit: contain;',
  'text: "LabelPilot";',

  '@image-url("../assets/icons/sidebar-collapse.svg")',
  '@image-url("../assets/icons/sidebar-expand.svg")',
  'component SidebarToggleButton inherits Rectangle',
  'vertical-scrollbar-policy: ScrollBarPolicy.always-off;',
  'horizontal-scrollbar-policy: ScrollBarPolicy.always-off;',
  'active: root.active-page == 1 || root.active-page == 2 || root.active-page == 3 || root.active-page == 4;',
]) assert.ok(ui.includes(fragment), `missing navigation cleanup contract: ${fragment}`);

assert.ok(!sidebar.includes('text: "Очередь печати";'), 'print queue must not be a top-level sidebar item');
assert.ok(!sidebar.includes('text: "Диагностика";'), 'diagnostics must not be a top-level sidebar item');
assert.ok(!sidebar.includes('icons/printer-white.png'), 'replacement monochrome printer badge must not be used');
assert.ok(!sidebar.includes('icon-color: white;'), 'original logo colors must not be colorized');
assert.equal(sidebarLogo, originalSidebarLogo, 'Slint logo must exactly match the original public asset');
assert.ok(sidebarLogo.includes('stop-color="#eb595a"') && sidebarLogo.includes('stop-color="#629ad3"'), 'original red/blue gradients are missing');
assert.ok(!sidebar.includes('icons/menu.png'), 'generic menu icon must not be used for sidebar state');
assert.ok(!sidebar.includes('header-touch := TouchArea'), 'the whole logo header must not toggle the sidebar');

for (const fragment of [
  'height: root.danger ? 48px : 44px;',
  'border-color: root.danger ? Palette.r300',
  'touch.has-hover ? Palette.r100 : Palette.r50',
  'drop-shadow-color: root.danger ? #dc262622',
  'font-weight: root.danger ? 700 : 500;',
]) assert.ok(ui.includes(fragment), `exit emphasis missing: ${fragment}`);

const settingsNavStart = ui.indexOf('component SettingsSectionNav inherits Rectangle');
const settingsNavEnd = ui.indexOf('component QueueSummaryCard inherits Rectangle', settingsNavStart);
assert.ok(settingsNavStart >= 0 && settingsNavEnd > settingsNavStart, 'settings category component missing');
const settingsNav = ui.slice(settingsNavStart, settingsNavEnd);
for (const fragment of [
  'text: root.printers-label;',
  'subtext: root.print-category;',
  'selected: root.active-page == 3;',
  'text: root.queue-label;',
  'selected: root.active-page == 1;',
  'text: root.scales-label;',
  'subtext: root.equipment-category;',
  'selected: root.active-page == 4;',
  'text: root.diagnostics-label;',
  'subtext: root.system-category;',
  'selected: root.active-page == 2;',
]) assert.ok(settingsNav.includes(fragment), `settings category mapping missing: ${fragment}`);

assert.equal(ui.split('SettingsSectionNav {').length - 1, 4, 'all four settings pages must share the category navigation');
assert.ok(!ui.includes('SettingsChoiceButton { width: 118px; height: 44px; text: "ПРИНТЕРЫ";'), 'legacy printer/scale header tabs remain');
assert.ok(!ui.includes('SettingsChoiceButton { width: 104px; height: 44px; text: "ВЕСЫ";'), 'legacy printer/scale header tabs remain');

for (const fragment of [

  'settings-nav-printers-label: root.ui-language == "en"',
  'settings-nav-queue-label: root.ui-language == "en"',
  'settings-nav-scales-label: root.ui-language == "en"',
  'settings-nav-diagnostics-label: root.ui-language == "en"',
  'settings-nav-print-category: root.ui-language == "en"',
  'settings-nav-equipment-category: root.ui-language == "en"',
  'settings-nav-system-category: root.ui-language == "en"',
  'root.ui-language == "de"',
  'root.ui-language == "uk"',
]) assert.ok(ui.includes(fragment), `four-locale settings navigation missing: ${fragment}`);

for (const [name, svg, direction] of [
  ['collapse', collapseIcon, 'm16 9-3 3 3 3'],
  ['expand', expandIcon, 'm13 9 3 3-3 3'],
]) {
  assert.ok(svg.includes('viewBox="0 0 24 24"'), `${name} icon viewBox missing`);
  assert.ok(svg.includes('<rect x="3" y="4" width="18" height="16" rx="2"/>'), `${name} icon panel missing`);
  assert.ok(svg.includes(direction), `${name} icon direction is wrong`);
}

console.log('Slint navigation cleanup: original color logo, explicit collapse control, settings categories, hidden scrollbar, and emphasized exit verified');