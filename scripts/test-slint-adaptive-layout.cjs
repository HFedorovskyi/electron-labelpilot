const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'src-tauri/slint/ui/weighing.slint'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'src-tauri/src/slint_runtime.rs'), 'utf8');
const count = (pattern) => [...ui.matchAll(pattern)].length;

assert.match(ui, /min-width: 1024px;\s*min-height: 600px;/);
assert.match(ui, /in-out property <bool> wide: false;\s*in-out property <bool> tall: false;/);
assert.match(ui, /property <length> shell-width: root\.width;/);
assert.match(ui, /property <length> page-width: root\.wide \? min\(root\.work-area-width, 1920px\) : root\.work-area-width;/);
assert.match(ui, /property <length> page-offset: \(root\.work-area-width - root\.page-width\) \/ 2;/);
assert.ok(count(/width: root\.page-width;/g) >= 10, 'all ten root pages must use adaptive page width');
assert.equal(count(/root\.sidebar-width \+ root\.page-offset;/g), 9, 'pages 1-9 must use centered page offset');
assert.match(ui, /ScrollView \{\s*vertical-stretch: 1;\s*viewport-width: self\.width;\s*vertical-scrollbar-policy: ScrollBarPolicy\.always-off;\s*horizontal-scrollbar-policy: ScrollBarPolicy\.always-off;\s*VerticalLayout \{\s*spacing: root\.short \? 4px : 8px;\s*SidebarItem \{\s*text: "Весовая станция";/);
assert.match(ui, /if root\.collapsed: AppIcon \{\s*width: 20px;\s*height: 20px;\s*x: \(parent\.width - self\.width\) \/ 2;\s*y: \(parent\.height - self\.height\) \/ 2;/);
assert.doesNotMatch(ui, /alignment: root\.collapsed \? center : start;/);
assert.match(ui, /property <length> operator-dialog-width:[\s\S]*?property <length> operator-dialog-height:/);
for (const token of ['small-dialog-width', 'medium-dialog-width', 'large-dialog-width', 'operator-dialog-width']) {
  assert.match(ui, new RegExp(`width: root\\.${token};`));
}
assert.doesNotMatch(ui, /property <length> shell-width: min\(root\.width, 1920px\)/);
assert.match(runtime, /wide: logical_width >= 1600\.0,\s*tall: logical_height >= 900\.0,/);
assert.match(runtime, /ui\.set_wide\(layout\.wide\);\s*ui\.set_tall\(layout\.tall\);/);
for (const resolution of ['1024, 600', '1280, 720', '1366, 768', '1600, 900', '1920, 1080', '2560, 1440']) {
  assert.ok(runtime.includes(`(${resolution}, 1.0)`), `missing adaptive case ${resolution}`);
}

console.log('Slint adaptive layout: 1024x600 through 2560x1440, DPI breakpoints, scrollable touch navigation and responsive dialogs verified');