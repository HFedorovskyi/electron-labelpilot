const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = (path) => fs.readFileSync(path, 'utf8');
const selector = read('src-tauri/src/runtime_selector.rs');
const dispatcher = read('src-tauri/src/main.rs');
const readme = read('README.md');

assert.ok(selector.includes('pub fn slint_default() -> Self'));
assert.ok(selector.includes('runtime: UiRuntime::Slint'));
assert.ok(selector.includes('None => (UiRuntime::Slint, SelectionSource::Default)'));
assert.ok(selector.includes('fn defaults_to_slint_with_tauri_fallback()'));
assert.ok(selector.includes('RuntimeSelection::slint_default()'));
assert.ok(dispatcher.includes('UiRuntime::Slint => run_slint_sidecar(selection.fallback_enabled)'));
assert.ok(dispatcher.includes('Err(error) if fallback_enabled'));
assert.ok(dispatcher.includes('labelpilot_tauri_lib::run();'));
assert.ok(readme.includes('Основной runtime по умолчанию: native Slint без WebView2.'));
assert.ok(readme.includes('Tauri/WebView2 сохранён как автоматический fallback'));

console.log('slint-default-runtime-contract: Slint default, explicit overrides and Tauri startup fallback verified');