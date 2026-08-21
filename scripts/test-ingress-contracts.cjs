'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const ingress = read('src-tauri/src/ingress.rs');
const crypto = read('src-tauri/src/crypto.rs');
const processor = read('src-tauri/src/processor.rs');
const runtime = read('src-tauri/src/lib.rs');
const commands = read('src-tauri/src/commands.rs');
const cargo = read('src-tauri/Cargo.toml');

assert.match(ingress, /const INGRESS_ADDRESS: &str = "0\.0\.0\.0:5556"/);
assert.match(ingress, /const MAX_HEADER_BYTES: usize = 16 \* 1024/);
assert.match(ingress, /const MAX_BODY_SYNC: usize = 64 \* 1024 \* 1024/);
assert.match(ingress, /const MAX_BODY_PRINT_JOB: usize = 1024 \* 1024/);
assert.match(ingress, /Duration::from_secs\(30\)/);
assert.match(ingress, /Duration::from_secs\(60\)/);
assert.match(ingress, /"\/api\/sync_db" \| "\/api\/full_sync"/);
assert.match(ingress, /"\/api\/print_job"/);
assert.match(ingress, /peer\.is_loopback\(\)/);
assert.match(ingress, /Access-Control-Allow-Origin: \*/);
assert.match(ingress, /"labelpilot-ingress"/);
assert.match(ingress, /app\.emit\("data-updated"/);
assert.match(ingress, /app\.emit\("print-jobs-updated"/);

assert.match(crypto, /const LPI2_MAGIC: &\[u8\] = b"LPI2\\n"/);
assert.match(crypto, /LICENSE_PUBLIC_KEY: \[u8; 32\]/);
assert.match(crypto, /Hkdf::<Sha256>/);
assert.match(crypto, /Aes256CbcDecryptor/);
assert.match(crypto, /verify_strict/);
assert.match(processor, /transaction\(\)/);
assert.match(processor, /DELETE FROM nomenclature/);
assert.match(processor, /INSERT OR REPLACE INTO print_jobs/);
assert.match(processor, /COALESCE\(\(SELECT printed_qty/);
assert.match(processor, /Идентификация станции заблокирована/);

for (const dependency of ['aes', 'base64', 'cbc', 'ed25519-dalek', 'hkdf', 'sha2']) {
    assert.match(cargo, new RegExp('^' + dependency.replace('-', '\\-') + ' =', 'm'));
}
assert.match(runtime, /app\.manage\(IngressState::new\(\)\)/);
assert.match(runtime, /commands::desktop_ingress_summary/);
assert.match(commands, /name\("labelpilot-shutdown"\.to_owned\(\)\)[\s\S]*state::<IngressState>\(\)\.stop\(\);[\s\S]*state::<NetworkState>\(\)\.stop\(\);/);

const nodeContract = spawnSync(process.execPath, [path.join(root, 'scripts', 'test-lpi2-contract.cjs')], {
    cwd: root,
    encoding: 'utf8',
});
assert.equal(nodeContract.status, 0, nodeContract.stderr || nodeContract.stdout);

console.log('Rust ingress contract: bounded :5556 listener, CORS, route caps and lifecycle verified');
console.log('Rust processor contract: transactional sync + progress-preserving print jobs verified');
process.stdout.write(nodeContract.stdout);
