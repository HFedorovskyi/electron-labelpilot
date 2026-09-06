'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8').replace(/^\uFEFF/, '');
const bridge = read('src/renderer/platform/tauriBridge.ts');
const commands = read('src-tauri/src/commands.rs');
const runtime = read('src-tauri/src/lib.rs');
const lifecycle = read('src-tauri/src/lifecycle.rs');
const transfer = read('src-tauri/src/transfer.rs');
const spooler = read('src-tauri/src/printer/spooler.rs');
const cargo = read('src-tauri/Cargo.toml');
const config = JSON.parse(read('src-tauri/tauri.conf.json'));
const packageJson = JSON.parse(read('package.json'));

const phase6Mappings = new Map([
  ['updater:check', 'desktop_updater_check'],
  ['updater:download', 'desktop_updater_download'],
  ['updater:install', 'desktop_updater_install'],
  ['updater:install-offline', 'desktop_updater_install_offline'],
  ['updater:list-backups', 'desktop_updater_list_backups'],
  ['updater:refresh-server-version', 'desktop_updater_refresh_server_version'],
  ['updater:rollback', 'desktop_updater_rollback'],
  ['import-identity-file', 'desktop_import_identity_file'],
  ['offline-import', 'desktop_offline_import'],
  ['offline-export', 'desktop_offline_export'],
  ['import-print-job-file', 'desktop_import_print_job_file'],
  ['usb-export', 'desktop_usb_export'],
  ['usb-import', 'desktop_usb_import'],
  ['demo:status', 'desktop_demo_status'],
  ['seed-demo-data', 'desktop_seed_demo_data'],
  ['exit-demo', 'desktop_exit_demo'],
  ['reset-database', 'desktop_reset_database'],
]);

for (const [channel, command] of phase6Mappings) {
  assert.match(
    bridge,
    new RegExp(`\\['${channel.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}',\\s*'${command}'\\]`),
    `Tauri bridge does not map ${channel} to ${command}`,
  );
  assert.match(runtime, new RegExp(`commands::${command}\\b`), `${command} is not registered`);
  assert.match(commands, new RegExp(`pub (?:async )?fn ${command}\\b`), `${command} is absent`);
}

assert.equal(config.identifier, 'com.labelpilot.electron');
assert.equal(config.bundle.active, true);
assert.deepEqual(config.bundle.targets, ['nsis']);
assert.equal(config.bundle.createUpdaterArtifacts, true);
assert.equal(config.bundle.windows.nsis.installMode, 'currentUser');
assert.equal(config.bundle.windows.nsis.compression, 'lzma');
assert.equal(config.bundle.windows.webviewInstallMode.type, 'downloadBootstrapper');
assert.deepEqual(config.bundle.resources, { '../resources/fonts/': 'fonts/' });
for (const api of ['OpenPrinterW', 'StartDocPrinterW', 'WritePrinter', 'ClosePrinter']) {
  assert.ok(spooler.includes(api), `native Windows spooler API is missing: ${api}`);
}
assert.ok(config.plugins.updater.pubkey.length > 80, 'updater public key is missing');
assert.ok(config.plugins.updater.endpoints[0].endsWith('/latest/download/latest.json'));

assert.match(cargo, /tauri-plugin-updater\s*=\s*\{\s*version\s*=\s*"2",\s*optional\s*=\s*true\s*\}/);
assert.match(cargo, /tauri-plugin-dialog\s*=\s*\{\s*version\s*=\s*"2",\s*optional\s*=\s*true\s*\}/);
assert.match(cargo, /rustls[^\n]+default-features\s*=\s*false[^\n]+"ring"/);
assert.match(runtime, /tauri_plugin_updater::Builder::new\(\)\.build\(\)/);
assert.match(runtime, /tauri_plugin_dialog::init\(\)/);
assert.match(runtime, /apply_pending_rollback\(persisted\.data_dir\(\)\)/);
assert.match(lifecycle, /\.updater\(\)[\s\S]*?\.check\(\)/);
assert.match(lifecycle, /const MAX_BACKUPS: usize = 3;/);
assert.match(lifecycle, /create_backup\(data_dir,/);
assert.match(lifecycle, /pending-rollback\.json/);
assert.match(lifecycle, /FILES_TO_BACKUP/);
assert.match(lifecycle, /DIRECTORIES_TO_BACKUP/);
assert.match(transfer, /const MAX_USB_BYTES: u64 = 64 \* 1024 \* 1024;/);
assert.match(transfer, /Hmac<Sha256>/);
assert.match(transfer, /write_bytes_atomic/);
assert.match(transfer, /seed_demo_data/);
assert.match(transfer, /exit_demo_data/);

assert.equal(packageJson.scripts['tauri:build'], 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-dual-runtime.ps1 -Bundle nsis');
assert.equal(packageJson.scripts['tauri:release'], 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-tauri-release.ps1');
assert.equal(packageJson.scripts['test:phase6'], 'node scripts/test-phase6-contracts.cjs');

console.log(`phase6-contracts: ${phase6Mappings.size} bridge mappings verified`);
console.log('phase6-contracts: signed updater, bounded backups, offline transfer and NSIS config verified');
