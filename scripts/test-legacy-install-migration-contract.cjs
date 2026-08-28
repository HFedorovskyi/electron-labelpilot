const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'src-tauri', 'tauri.conf.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const hookRelative = config.bundle?.windows?.nsis?.installerHooks;

assert.equal(hookRelative, 'windows/legacy-migration.nsh');
const hookPath = path.resolve(path.dirname(configPath), hookRelative);
assert.equal(fs.existsSync(hookPath), true, `missing installer hook: ${hookPath}`);

const hook = fs.readFileSync(hookPath, 'utf8');
assert.match(hook, /!macro NSIS_HOOK_PREINSTALL/);
assert.match(hook, /CheckIfAppIsRunning "LabelPilot\.exe" "LabelPilot Electron"/);
assert.match(hook, /Uninstall LabelPilot\.exe/);
assert.match(hook, /\/currentuser \/S/);
assert.match(hook, /706f3450-5e57-5456-9cf1-987811731881/);
assert.match(hook, /RMDir \/r \/REBOOTOK "\$\{LEGACY_ELECTRON_INSTALL_DIR\}"/);
assert.match(hook, /LegacyMigrationFrom/);
assert.match(hook, /LegacyMigrationStatus/);
assert.doesNotMatch(hook, /\$APPDATA|electron-labelpilot|client_data\.db|printer-config\.json/);

console.log('legacy-install-migration-contract: Electron runtime cleanup, data preservation boundary and migration markers verified');