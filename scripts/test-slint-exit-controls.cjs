const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'src-tauri/slint/ui/weighing.slint'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'src-tauri/src/slint_runtime.rs'), 'utf8');

assert.match(ui, /callback quit-app;/);
assert.match(ui, /operator-exit-button := MainButton \{[\s\S]*?text: root\.exit-label;[\s\S]*?clicked => \{ root\.quit-app\(\); \}/);
assert.match(ui, /property <string> exit-label: root\.ui-language == "en" \? "Exit" : root\.ui-language == "de" \? "Beenden" : root\.ui-language == "uk" \? "Вийти" : "Выйти";/);
assert.match(ui, /SidebarItem \{\s*text: root\.exit-label;[\s\S]*?clicked => \{ root\.quit-app\(\); \}/);
assert.match(runtime, /ui\.set_ui_language\([\s\S]*?persisted_printer_config[\s\S]*?\.get\("language"\)/);
for (const locale of ['ru', 'en', 'de', 'uk']) {
  assert.match(runtime, new RegExp(`normalized_ui_language\\(Some\\("${locale}"\\)\\), "${locale}"`));
}
assert.match(runtime, /ui\.on_quit_app\(\|\| \{\s*let _ = slint::quit_event_loop\(\);\s*\}\);/);
assert.match(runtime, /let result = ui\.run\(\);\s*if let Some\(runtime\) = &runtime \{\s*runtime\.shutdown\(\);/);

console.log('Slint exit controls: operator modal + sidebar, RU/EN/DE/UK, clean runtime shutdown verified');