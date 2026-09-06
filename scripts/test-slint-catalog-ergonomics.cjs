const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'src-tauri/slint/ui/weighing.slint'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'src-tauri/src/slint_runtime.rs'), 'utf8');
const nativeUi = fs.readFileSync(path.join(root, 'src-tauri/src/native_ui.rs'), 'utf8');
const operational = fs.readFileSync(path.join(root, 'src-tauri/src/operational.rs'), 'utf8');

const pageStart = ui.indexOf('if root.active-page == 7: Rectangle {');
const pageEnd = ui.indexOf('if root.active-page == 8: Rectangle {', pageStart);
assert.ok(pageStart >= 0 && pageEnd > pageStart, 'catalog page boundaries missing');
const page = ui.slice(pageStart, pageEnd);

for (const property of [
  'catalog-page-title', 'catalog-shown-label', 'catalog-of-label',
  'catalog-products-label', 'catalog-loading-label', 'catalog-refresh-label',
  'catalog-search-placeholder', 'catalog-search-label', 'catalog-list-label',
  'catalog-empty-label', 'catalog-load-more-label', 'catalog-card-title',
  'catalog-article-label', 'catalog-expiration-label', 'catalog-fixed-weight-label',
  'catalog-weight-mode-label', 'catalog-fixed-mode-label', 'catalog-packaging-title',
  'catalog-portion-container-label', 'catalog-portion-tare-label',
  'catalog-box-container-label', 'catalog-box-tare-label', 'catalog-box-limit-label',
  'catalog-templates-title', 'catalog-package-label', 'catalog-box-label-text',
  'catalog-pallet-label-text', 'catalog-extra-title', 'catalog-scroll-hint',
  'catalog-back-to-list-label',
]) {
  const line = ui.split('\n').find((value) => value.includes(`property <string> ${property}:`));
  assert.ok(line, `missing localized catalog property: ${property}`);
  for (const locale of ['"en"', '"de"', '"uk"']) {
    assert.ok(line.includes(locale), `${property} missing locale ${locale}`);
  }
}

for (const fragment of [
  'in-out property <int> catalog-limit: 50;',
  'in-out property <bool> catalog-keyboard-visible: false;',
  'in-out property <bool> catalog-detail-visible: false;',
  'in-out property <length> catalog-list-scroll-y: 0px;',
  'in-out property <length> catalog-detail-scroll-y: 0px;',
  'callback load-more-catalog;',
  'border-radius: 18px;',
]) assert.ok(ui.includes(fragment), 'missing catalog state/layout contract: ' + fragment);

assert.ok(!page.includes('horizontal-stretch: 7;'), 'catalog panels must not use fractional 7/5 sizing');
assert.ok(!page.includes('horizontal-stretch: 5;'), 'catalog panels must not use fractional 7/5 sizing');
assert.ok(page.includes('if !root.catalog-detail-visible: Rectangle {'), 'catalog list must be a dedicated full-width screen');
assert.ok(page.includes('if root.catalog-detail-visible: Rectangle {'), 'product card must be a dedicated full-width screen');
assert.ok(page.includes('width: parent.width;'), 'detail screen must use the full catalog work area');
assert.ok(page.includes('root.catalog-detail-visible = true;'), 'selecting a product must drill into its card');
assert.ok(page.includes('root.catalog-keyboard-visible = false;'), 'opening a product card must close the search keyboard');
assert.ok(page.includes('text: "‹  " + root.catalog-back-to-list-label;'), 'product card needs a localized back control at every resolution');
assert.ok(page.includes('root.catalog-detail-visible = false;'), 'product card back control must restore the list');
assert.ok(!page.includes('if root.narrow: CompactActionButton {'), 'card navigation must not depend on a narrow breakpoint');

assert.match(page, /LineEdit \{[\s\S]*?edited => \{[\s\S]*?root\.search-catalog\(self\.text\);/, 'catalog search must filter while typing');
assert.ok(page.includes('if root.catalog-keyboard-visible: TouchKeyboard {'), 'catalog needs an on-screen touch keyboard');
assert.ok(page.includes('compact: root.short;'), 'catalog keyboard may compact only on short screens');
assert.ok(page.includes('roomy: true;'), 'catalog keyboard must expose glove-sized targets');
assert.ok(page.includes('height: root.short ? 54px : 62px;'), 'catalog search controls need glove-sized height');
assert.ok(page.includes('font-size: root.short ? 16px : 18px;'), 'catalog search text must remain legible');
assert.ok(page.includes('root.touch-keyboard-layout = root.ui-language == "en" || root.ui-language == "de" ? 1 : 0;'), 'keyboard layout must follow the interface locale');
assert.ok(page.includes('root.edit-touch-text(root.catalog-search, key, uppercase)'), 'touch keyboard must update catalog search');

for (const scroll of ['catalog-list-scroll', 'catalog-detail-scroll']) {
  const start = page.indexOf(`${scroll} := ScrollView {`);
  assert.ok(start >= 0, `${scroll} missing`);
  const section = page.slice(start, start + 900);
  assert.ok(section.includes('vertical-scrollbar-policy: ScrollBarPolicy.always-off;'), `${scroll} must hide the mouse scrollbar`);
  assert.ok(section.includes('horizontal-scrollbar-policy: ScrollBarPolicy.always-off;'), `${scroll} must suppress horizontal overflow`);
  assert.ok(section.includes('mouse-drag-pan-enabled: true;'), `${scroll} must support touch dragging`);
}
assert.equal((page.match(/TouchScrollStepButton \{/g) || []).length, 4, 'catalog list and details need independent up/down touch controls');

assert.match(page, /width: 48px;\s*vertical-stretch: 1;\s*background: transparent;[\s\S]*?x: \(parent\.width - self\.width\) \/ 2;\s*y: \(parent\.height - self\.height\) \/ 2;/, 'list icon slot must center its icon on both axes');
assert.match(page, /width: 56px;\s*vertical-stretch: 1;\s*background: transparent;[\s\S]*?x: \(parent\.width - self\.width\) \/ 2;\s*y: \(parent\.height - self\.height\) \/ 2;/, 'detail icon slot must center its icon on both axes');
assert.ok(page.includes('font-size: root.narrow ? 15px : 16px;'), 'product names must remain legible at display scaling');
assert.ok(page.includes('font-size: root.narrow ? 11px : 12px;'), 'product metadata must remain legible at display scaling');
assert.ok(page.includes('height: root.narrow ? 112px : 126px;'), 'detail heading needs reserved multi-line height');
assert.match(page, /catalog-detail-scroll := ScrollView \{[\s\S]*?\n                        HorizontalLayout \{\n                            height: 52px;/, 'detail touch arrows must sit below the card instead of consuming its width');
assert.ok(page.includes('root.catalog-load-more-label + " · " + (root.catalog-total - root.catalog-products.length)'), 'remaining product count must be visible on load-more');
assert.ok(page.includes('clicked => { root.load-more-catalog(); }'), 'load-more control must be wired');

assert.ok(operational.includes('pub fn products_with_limit('), 'operational catalog needs a variable bound');
assert.ok(operational.includes('LIMIT ?1'), 'unfiltered limit must be parameterized');
assert.ok(operational.includes('LIMIT ?2'), 'filtered limit must be parameterized');
assert.ok(nativeUi.includes('const SMALL_CATALOG_EAGER_LIMIT: i64 = 100;'), 'small catalogs must load eagerly');
assert.ok(nativeUi.includes('.catalog_snapshot_with_limit(None, None, 250)'), 'full-page expansion must be covered by Rust tests');
assert.ok(nativeUi.includes('.catalog_snapshot_with_limit(None, Some("Товар 0"), 5)'), 'small eager catalog must be covered by Rust tests');
assert.ok(runtime.includes('const CATALOG_PAGE_SIZE: usize = 50;'), 'runtime batch size missing');
assert.ok(runtime.includes('ui.on_load_more_catalog({'), 'runtime load-more callback missing');
assert.ok(runtime.includes('current.saturating_add(CATALOG_PAGE_SIZE).min(total)'), 'load-more must remain bounded by total matches');
assert.ok(runtime.includes('runtime.catalog_snapshot_with_limit(selected_product_id, search.as_deref(), limit)'), 'worker must use requested page size');

console.log('Slint catalog: full-width list-to-card drill-down, centered clear rows, glove keyboard, touch scrolling and eager-small/progressive-large loading verified');
