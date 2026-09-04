const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = (path) => fs.readFileSync(path, 'utf8');
const selector = read('src-tauri/src/runtime_selector.rs');
const dispatcher = read('src-tauri/src/main.rs');
const slintMain = read('src-tauri/src/slint_main.rs');
const cargo = read('src-tauri/Cargo.toml');
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
assert.ok(cargo.includes('"renderer-skia-opengl", "renderer-femtovg"'));
assert.ok(slintMain.includes('const DEFAULT_SLINT_BACKEND: &str = "winit-skia-opengl";'));
assert.ok(slintMain.includes('std::env::var_os("SLINT_BACKEND")'));
assert.ok(slintMain.includes('text=subpixel'));
assert.ok(readme.includes('GPU-backed `winit-skia-opengl` renderer for subpixel text'));
assert.ok(readme.includes('`winit-femtovg` as an explicit low-footprint override'));

console.log('slint-default-runtime-contract: Slint default, Skia subpixel text, FemtoVG override and Tauri fallback verified');
