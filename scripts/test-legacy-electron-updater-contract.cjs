const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const generator = path.join(root, 'scripts', 'new-legacy-electron-manifest.ps1');
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labelpilot-legacy-updater-'));

try {
  const installer = path.join(fixtureDir, 'LabelPilot_2.0.0_x64-setup.exe');
  const manifest = path.join(fixtureDir, 'latest.yml');
  const bytes = Buffer.from('labelpilot-electron-to-tauri-migration-fixture\0', 'utf8');
  fs.writeFileSync(installer, bytes);
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', generator,
    '-InstallerPath', installer, '-Version', '2.0.0', '-OutputPath', manifest,
    '-ReleaseDate', '2026-08-21T20:25:10Z',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /LEGACY_MANIFEST_OK version=2\.0\.0/);
  const yaml = fs.readFileSync(manifest, 'utf8');
  const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
  const escapedHash = sha512.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(yaml, /^version: 2\.0\.0$/m);
  assert.match(yaml, /url: 'LabelPilot_2\.0\.0_x64-setup\.exe'/);
  assert.match(yaml, new RegExp(`sha512: ${escapedHash}`));
  assert.match(yaml, new RegExp(`size: ${bytes.length}`));
  assert.match(yaml, /releaseDate: '2026-08-21T20:25:10\.0000000\+00:00'/);

  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const tauriConfig = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const releaseScript = fs.readFileSync(path.join(root, 'scripts', 'build-tauri-release.ps1'), 'utf8');
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release-tauri.yml'), 'utf8');
  const persisted = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'persisted.rs'), 'utf8');
  assert.equal(tauriConfig.identifier, 'com.labelpilot.electron');
  assert.equal(tauriConfig.version, packageJson.version);
  assert.match(persisted, /LEGACY_APP_DIRECTORY:\s*&str\s*=\s*"electron-labelpilot"/);
  assert.match(releaseScript, /new-legacy-electron-manifest\.ps1/);
  assert.match(releaseScript, /latest\.yml/);
  assert.match(workflow, /new-legacy-electron-manifest\.ps1/);
  assert.match(workflow, /latest\.yml/);
  console.log('legacy-electron-updater-contract: dual latest.yml/latest.json migration channel verified');
} finally {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}
