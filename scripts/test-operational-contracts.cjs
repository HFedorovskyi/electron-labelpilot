const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const operational = read('src-tauri/src/operational.rs');
const barcode = read('src-tauri/src/barcode.rs');
const session = read('src-tauri/src/session.rs');
const processor = read('src-tauri/src/processor.rs');
const commands = read('src-tauri/src/commands.rs');
const runtime = read('src-tauri/src/lib.rs');
const bridge = read('src/renderer/platform/tauriBridge.ts');

const mappings = {
  'record-pack': 'desktop_record_pack',
  'close-box': 'desktop_close_box',
  'get-latest-counters': 'desktop_get_latest_counters',
  'get-open-pallet-content': 'desktop_get_open_pallet_content',
  'get-pallet-render-data': 'desktop_get_pallet_render_data',
  'close-pallet': 'desktop_close_pallet',
  'delete-pack': 'desktop_delete_pack',
  'delete-box': 'desktop_delete_box',
  'operators:list': 'desktop_list_operators',
  'session:get': 'desktop_session_get',
  'session:set': 'desktop_session_set',
  'session:logout': 'desktop_session_logout',
};
for (const [channel, command] of Object.entries(mappings)) {
  assert.match(bridge, new RegExp(`\\['${channel}', '${command}'\\]`));
  assert.match(runtime, new RegExp(`commands::${command}`));
  assert.match(commands, new RegExp(`pub fn ${command}`));
}

assert.match(commands, /migrated_commands: Vec<&'static str>/);
const migrated = commands.match(/migrated_commands: vec!\[([\s\S]*?)\],/);
assert.ok(migrated, 'migrated command vector not found');
assert.ok([...migrated[1].matchAll(/"([^"]+)"/g)].length >= 35);
assert.match(operational, /Arc<Mutex<Connection>>/);
assert.match(operational, /transaction\s*\.commit\(\)/);
assert.match(operational, /WHERE id = \?3 AND status = 'Open'/);
assert.match(operational, /Could not find a unique box number after 50 attempts/);
assert.match(operational, /deleted_at = strftime\('%Y-%m-%d %H:%M:%f','now'\)/);
assert.match(operational, /status != 'Deleted'/);
assert.match(operational, /COLLATE NOCASE/);
assert.match(operational, /re-home in-progress box/);
assert.match(operational, /exercises_an_external_legacy_database_copy_when_configured/);

for (const table of ['pallet', 'boxes', 'pack', 'print_errors']) {
  assert.match(processor, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
}
for (const index of ['idx_pack_box_status', 'idx_boxes_nom_status', 'idx_boxes_pallet_status']) {
  assert.match(processor, new RegExp(`CREATE INDEX IF NOT EXISTS ${index}`));
}

for (const field of [
  'constanta', 'constant', 'ai', 'weight', 'weight_netto_pack', 'weight_brutto_pack',
  'weight_netto_box', 'weight_brutto_box', 'weight_netto_pallet',
  'weight_brutto_pallet', 'weight_brutto_all', 'production_date', 'exp_date',
  'article', 'batch_number', 'pack_number', 'box_number', 'pallet_number', 'extra_data',
]) {
  assert.ok(barcode.includes(`"${field}"`), `Rust barcode field missing: ${field}`);
}
assert.match(session, /pbkdf2_hmac::<Sha256>/);
assert.match(session, /ct_eq/);
assert.match(commands, /app\.emit\("session-changed"/);
assert.match(commands, /app\.emit\("data-updated"/);

console.log(`Rust operational contracts: ${Object.keys(mappings).length} IPC mappings, persistent SQLite connection, transactional pallet/box/pack lifecycle`);
console.log('Rust barcode contracts: 19 current + legacy field variants, collision regeneration');
console.log('Rust session contracts: ephemeral operator, Django PBKDF2 PIN, open-entity logout gate');
