'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ui = fs.readFileSync('src-tauri/slint/ui/weighing.slint', 'utf8');
const controls = fs.readFileSync('src-tauri/slint/ui/settings-controls.slint', 'utf8');
const runtime = fs.readFileSync('src-tauri/src/slint_runtime.rs', 'utf8');
const checks = fs.readFileSync('src-tauri/examples/support/settings_checks.rs', 'utf8');
const settings = ui.slice(ui.indexOf('    if root.active-page == 1: Rectangle {'), ui.indexOf('    if root.active-page == 5: Rectangle {'));
assert.equal((settings.match(/SettingsSectionNav \{/g) || []).length, 4);
assert.equal((settings.match(/viewport-width: self.visible-width/g) || []).length, 4);
assert.doesNotMatch(settings, /viewport-width: self.width/);
assert.doesNotMatch(settings, /vertical-scrollbar-policy: ScrollBarPolicy.always-off/);
assert.doesNotMatch(settings, /overflow: elide/);
assert.doesNotMatch(settings, /height:.*settings-connection/);
assert.doesNotMatch(settings, /printer-system-scroll|printer-serial-scroll|scale-protocol-scroll/);
for (const name of ['SettingsCard', 'SettingsField', 'SettingsSelect', 'SettingsToggle', 'SettingsNotice']) {
    assert.match(controls, new RegExp(`export component ${name} inherits Rectangle`));
}
assert.match(controls, /min-height: content.min-height/);
assert.match(controls, /height: 44px/);
assert.match(controls, /accessible-label: root.label/);
assert.match(controls, /settings-keyboard.svg/);
assert.match(controls, /settings-chevron.svg/);
assert.match(controls, /settings-check.svg/);
const fields = ['printer-ip', 'printer-port', 'printer-baud', 'printer-name', 'printer-width', 'printer-height', 'printer-gap', 'printer-darkness', 'printer-speed', 'scale-host', 'scale-port', 'scale-baud', 'scale-polling', 'scale-samples'];
for (const field of fields) {
    assert.ok(settings.includes(`open-settings-input("${field}"`), `${field}: keyboard missing`);
    assert.ok(ui.includes(`settings-input-target == "${field}"`), `${field}: acceptance missing`);
    assert.ok(checks.includes(`"${field}"`), `${field}: callback check missing`);
}
assert.match(ui, /root\.settings-input-keyboard-visible && !root\.settings-busy && !root\.scale-settings-busy/);
assert.match(ui, /clicked => \{ root\.request-settings-page\(3\); \}/);
assert.match(ui, /page == 3 && !root\.settings-dirty/);
assert.match(ui, /page == 4 && !root\.scale-settings-dirty/);
assert.match(ui, /callback cancel-settings-discard/);
assert.match(ui, /root\.open-settings-diagnostic-role\(device\.role\)/);
assert.match(settings, /root\.confirm-print-uncertain = job\.uncertain/);
assert.match(settings, /root\.confirm-print-action-visible = true/);
assert.match(runtime, /initialize_settings_models\(&ui\)/);
assert.match(runtime, /settings_draft_open\(ui\.get_settings_dirty\(\), ui\.get_settings_input_keyboard_visible\(\)\)/);
assert.match(runtime, /settings_draft_open\(ui\.get_scale_settings_dirty\(\), ui\.get_settings_input_keyboard_visible\(\)\)/);
assert.match(runtime, /bounded_text\(value, 4096\)/);
// Existing printer activation policy is unchanged by the UI reorganization.
assert.match(runtime, /active: true,\s*name: ui\.get_settings_name\(\)/);
console.log('Native settings: 4 sections, 14 labeled keyboard fields, bounded scrolling, draft protection and existing print confirmations verified');
