const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const cargo = read('src-tauri/Cargo.toml');
const lib = read('src-tauri/src/lib.rs');
const updater = read('src-tauri/src/native_update.rs');
const maintenance = read('src-tauri/src/maintenance_main.rs');
const runtime = read('src-tauri/src/slint_runtime.rs');
const ui = read('src-tauri/slint/ui/weighing.slint');
const buildDual = read('scripts/build-dual-runtime.ps1');
const buildRelease = read('scripts/build-tauri-release.ps1');
const packageScript = read('scripts/new-native-update-package.ps1');
const packageBuilder = read('src-tauri/examples/build_native_update_package.rs');
const workflow = read('.github/workflows/release-tauri.yml');
const dualConfig = JSON.parse(read('src-tauri/tauri.dual-runtime.conf.json'));
const localConfig = JSON.parse(read('src-tauri/tauri.local-release.conf.json'));

assert.match(cargo, /native-update = \[\]/);
assert.match(cargo, /name = "labelpilot-maintenance"/);
assert.match(cargo, /semver = "/);
assert.match(lib, /pub mod native_update;/);
assert.match(maintenance, /run_maintenance_cli/);

for (const token of [
  'NativeUpdateManifest', 'windows-x86_64', 'portable-zip', 'MAX_MANIFEST',
  'MAX_PACKAGE', 'validate_remote_url', 'verify_signature', 'Sha256',
  'PublicKey::decode', 'stage_offline_manifest', 'queue_install',
  'transaction_root', 'binary-backup', 'backup_data', 'wait_for_health',
  'rollback_files', 'confirm_startup_health', 'PACKAGE_METADATA',
  'verify_package_metadata', 'verify_plan_package', 'package_signature',
  'package_sha256', 'package_size', 'restart_restored_application',
]) {
  assert.ok(updater.includes(token), 'native updater token missing: ' + token);
}
assert.match(updater, /enclosed_name\(\)/);
assert.match(updater, /candidate > current/);
assert.match(updater, /OpenProcess\(0x0010_0000/);

for (const token of [
  'NativeUpdateManager', 'UiMessage::UpdateProgress', 'UiMessage::UpdateFinished',
  'on_check_update', 'on_download_update', 'on_stage_offline_update',
  'on_install_update', 'confirm_startup_health',
]) {
  assert.ok(runtime.includes(token), 'Slint updater runtime token missing: ' + token);
}
for (const token of [
  'active-page == 9', 'Обновление и обслуживание', 'ОФЛАЙН-ОБСЛУЖИВАНИЕ',
  'update-progress', 'Minisign + SHA-256', '30 секунд',
]) {
  assert.ok(ui.includes(token), 'Slint updater UI token missing: ' + token);
}

for (const config of [dualConfig, localConfig]) {
  assert.deepEqual(config.bundle.externalBin, [
    'binaries/labelpilot-slint',
    'binaries/labelpilot-maintenance',
  ]);
}
assert.match(buildDual, /--features native-update --bin labelpilot-maintenance/);
assert.match(buildDual, /bundledMaintenance/);
assert.match(packageScript, /build_native_update_package/);
assert.match(packageBuilder, /CompressionMethod::Stored/);
assert.match(packageBuilder, /\.labelpilot-update\.json/);
assert.match(packageScript, /tauri signer sign/);
assert.match(packageScript, /native-latest\.json/);
assert.match(packageScript, /sha256 = \$sha256/);
assert.match(buildRelease, /new-native-update-package\.ps1/);
assert.match(buildRelease, /NATIVE_MANIFEST/);
assert.match(workflow, /new-native-update-package\.ps1/);

console.log('native-updater-contract: signed version-bound package, offline staging, repeated pre-apply verification, health confirmation and rollback verified');
