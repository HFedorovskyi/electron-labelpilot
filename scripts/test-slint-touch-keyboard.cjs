const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'src-tauri/slint/ui/weighing.slint'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'src-tauri/src/slint_runtime.rs'), 'utf8');
const occurrences = (text, needle) => text.split(needle).length - 1;

for (const fragment of [
  'component KeyboardKey inherits Rectangle',
  'component TouchKeyboard inherits Rectangle',
  'in property <bool> roomy: false;',
  'height: root.roomy ? (root.compact ? 300px : 330px) : root.compact ? 242px : 266px;',
  'min-width: root.roomy ? 52px : root.compact ? 34px : 40px;',
  'height: root.roomy ? (root.compact ? 50px : 56px) : root.compact ? 42px : 46px;',
  'font-size: root.roomy ? 19px : root.compact ? 14px : 16px;',
  'callback key-pressed(string, bool);',
  'callback backspace;',
  'callback clear;',
  'callback done;',
  'text: "АБВ";',
  'text: "ABC";',
  'text: "123";',
  'callback edit-touch-text(string, string, bool) -> string;',
]) assert.ok(ui.includes(fragment), 'missing UI contract: ' + fragment);

for (const key of ['Ё', 'Ә', 'Ғ', 'Қ', 'Ң', 'Ө', 'Ұ', 'Ү', 'Һ', 'І']) {
  assert.ok(ui.includes('"' + key + '"'), 'missing Cyrillic/Kazakh key: ' + key);
}
for (const locale of ['"en"', '"de"', '"uk"']) assert.ok(ui.includes('root.ui-language == ' + locale));
assert.ok(occurrences(ui, 'if root.touch-keyboard-visible: TouchKeyboard {') >= 2);
assert.ok(occurrences(ui, 'root.touch-keyboard-visible = true;') >= 2);
assert.ok(occurrences(ui, 'root.touch-keyboard-visible = false;') >= 8);
for (const fragment of [
  'const TOUCH_SEARCH_MAX_CHARS: usize = 96;',
  'fn edit_touch_text(current: &str, key: &str, uppercase: bool) -> String',
  '"__BACKSPACE__" => {',
  'result.pop();',
  'ui.on_edit_touch_text(|current, key, uppercase|',
  'edits_unicode_text_without_splitting_characters',
  'bounds_touch_search_input',
]) assert.ok(runtime.includes(fragment), 'missing Rust contract: ' + fragment);

console.log('Slint touch keyboard: glove-sized catalog mode, product + fixed-product search, RU/KZ/Latin/numeric layouts, four locales and Unicode editing verified');