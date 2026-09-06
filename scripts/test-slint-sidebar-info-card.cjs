const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'src-tauri/slint/ui/weighing.slint'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'src-tauri/src/slint_runtime.rs'), 'utf8');

const footerStart = ui.indexOf('height: root.short ? (root.effective-collapsed ? 100px : 128px)');
const footerEnd = ui.indexOf('horizontal-stretch: 1;\n            background: Palette.n50;', footerStart);
assert.ok(footerStart >= 0 && footerEnd > footerStart, 'sidebar information footer missing');
const footer = ui.slice(footerStart, footerEnd);

for (const fragment of [
  'sidebar-server-label: root.ui-language == "en" ? "SERVER"',
  'sidebar-online-label: root.ui-language == "en" ? "ONLINE"',
  'sidebar-offline-label: root.ui-language == "en" ? "OFFLINE"',
  'root.ui-language == "de" ? "OFFLINE"',
  'root.ui-language == "uk" ? "ОФЛАЙН"',
  'sidebar-station-label: root.ui-language == "en" ? "STATION"',
  'sidebar-version-label: root.ui-language == "en" ? "CLIENT VERSION"',
  'sidebar-operator-label: root.ui-language == "en" ? "OPERATOR"',
]) assert.ok(ui.includes(fragment), `missing four-locale sidebar contract: ${fragment}`);

for (const fragment of [
  'text: root.server-online ? root.sidebar-online-label : root.sidebar-offline-label;',
  'dot-color: root.server-online ? Palette.e500 : Palette.r500;',
  'border-color: root.server-online ? Palette.e300 : Palette.r300;',
  'background: root.server-online ? Palette.e50 : Palette.r50;',
  'sidebar-info-card := Rectangle {',
  'visible: !root.effective-collapsed;',
  'text: root.sidebar-server-label;',
  'text: root.sidebar-station-label;',
  'text: root.sidebar-version-label;',
  'text: root.sidebar-operator-label;',
  'text: root.update-current-version;',
  'text: root.station-number;',
  'text: root.operator-name;',
  'horizontal-alignment: right;',
  'if root.effective-collapsed: Rectangle {',
]) assert.ok(footer.includes(fragment), `missing centered sidebar footer contract: ${fragment}`);
assert.ok((footer.split('Rectangle { height: 1px; horizontal-stretch: 1; background: Palette.n200; }').length - 1) >= 3, 'four labeled rows must have three dividers');
assert.ok(!footer.includes('text: root.server-status;'), 'sidebar must show exact online/offline state, not sync text');
assert.ok(!footer.includes('Palette.a500'), 'offline server state must be red rather than warning amber');

assert.ok(!runtime.includes('ui.set_server_online(snapshot.station.provisioned);'), 'provisioning must not masquerade as server connectivity');
assert.ok(runtime.includes('if !snapshot.station.provisioned {\n        ui.set_server_online(false);'), 'unprovisioned stations must stay offline');
assert.ok(runtime.includes('ui.set_server_online(snapshot.server_online);'), 'ping snapshot must own the visible connectivity state');
assert.ok(runtime.includes('LABELPILOT_SLINT_SIDEBAR_INFO_TEST'), 'deterministic sidebar visual hook missing');
assert.ok(runtime.includes('LABELPILOT_SLINT_SIDEBAR_INFO_OFFLINE'), 'offline visual hook missing');

const gate = runtime.indexOf('let server_license_refresh_gate = Rc::new');
const warmup = runtime.indexOf('if let Some(warmup_runtime)', gate);
const initialRefresh = runtime.indexOf('schedule_server_license_refresh(', gate);
assert.ok(gate >= 0 && initialRefresh > gate && initialRefresh < warmup, 'real server ping must run at startup');
const timer = runtime.indexOf('let license_live_timer = slint::Timer::default();');
const timerEnd = runtime.indexOf('let refresh_timer = slint::Timer::default();', timer);
const timerBlock = runtime.slice(timer, timerEnd);
assert.ok(timerBlock.includes('Duration::from_secs(60)'), 'connectivity refresh interval changed');
assert.ok(timerBlock.indexOf('schedule_server_license_refresh(') > timerBlock.indexOf('if ui.get_active_page() == 8'), 'periodic ping must run outside the license-page condition');

console.log('Slint sidebar info card: four explicit rows, four locales, startup/60s real ping, and online/offline colors verified');