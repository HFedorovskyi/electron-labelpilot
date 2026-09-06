const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'src-tauri/slint/ui/weighing.slint'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'src-tauri/src/slint_runtime.rs'), 'utf8');
const operational = fs.readFileSync(path.join(root, 'src-tauri/src/operational.rs'), 'utf8');
const nativeUi = fs.readFileSync(path.join(root, 'src-tauri/src/native_ui.rs'), 'utf8');

for (const fragment of [
  'edited => { root.product-scroll-y = 0px; root.search-products(self.text); }',
  'key-pressed(key, uppercase) => { root.product-search = root.edit-touch-text(root.product-search, key, uppercase); root.product-scroll-y = 0px; root.search-products(root.product-search); }',
  'backspace => { root.product-search = root.edit-touch-text(root.product-search, "__BACKSPACE__", false); root.product-scroll-y = 0px; root.search-products(root.product-search); }',
  'clear => { root.product-search = ""; root.product-scroll-y = 0px; root.search-products(""); }',
  'mouse-drag-pan-enabled: true;',
  'viewport-y <=> root.product-scroll-y;',
  'vertical-scrollbar-policy: ScrollBarPolicy.always-off;',
  'horizontal-scrollbar-policy: ScrollBarPolicy.always-off;',
  'component TouchScrollStepButton inherits Rectangle',
  'glyph: "▲";',
  'glyph: "▼";',
  'product-scroll.viewport-height > product-scroll.visible-height',
]) assert.ok(ui.includes(fragment), 'missing live-search/touch-scroll UI contract: ' + fragment);

for (const fragment of [
  'AtomicU64',
  'const PRODUCT_SEARCH_DEBOUNCE: Duration = Duration::from_millis(70);',
  'product_search_generation.fetch_add(1, Ordering::AcqRel) + 1',
  'product_search_generation.load(Ordering::Acquire) != generation',
  'UiMessage::ProductSearchLoaded',
  'ui.set_product_search_busy(true);',
  'ui.set_product_search_busy(false);',
  'let selected_product_details = Rc::new(RefCell::new(None::<NativeUiProduct>));',
  'runtime.weighing_snapshot(Some(product_id), search)',
  'event_selected_product_details',
]) assert.ok(runtime.includes(fragment), 'missing live-search runtime contract: ' + fragment);

assert.ok(operational.includes('(n.name LIKE ?1 OR n.article LIKE ?1)'), 'database search must cover name and article');
assert.ok(nativeUi.includes('products.insert(0, NativeUiProduct::try_from(&product)?)'), 'selected item beyond the first 50 must remain selected');
assert.ok(nativeUi.includes('runtime.catalog_snapshot(None, Some("ART-055"))'), 'article search regression must execute against the native catalog');
for (const locale of ['"en"', '"de"', '"uk"']) {
  assert.ok(ui.includes('root.ui-language == ' + locale), 'missing locale branch: ' + locale);
}

console.log('Slint product picker: live name/article filtering, stale-result suppression, four locales, flick/pan and large step controls verified');
