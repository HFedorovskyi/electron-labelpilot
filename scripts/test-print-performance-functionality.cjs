const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const generator = read('src-tauri/src/generator/mod.rs');
const nativePrint = read('src-tauri/src/native_print.rs');
const operational = read('src-tauri/src/operational.rs');
const runtime = read('src-tauri/src/slint_runtime.rs');
const printer = read('src-tauri/src/printer.rs');
const persisted = read('src-tauri/src/persisted.rs');

assert.match(generator, /pub fn generate_if_native\([\s\S]*?parse_tracked\(payload\)\?/);
assert.match(generator, /fn generate_parsed\([\s\S]*?input: ParsedInput/);
const prepareBody = nativePrint.slice(
  nativePrint.indexOf('    fn prepare(&self,'),
  nativePrint.indexOf('    fn send_prepared(', nativePrint.indexOf('    fn prepare(&self,')),
);
assert.match(prepareBody, /generate_if_native\(&payload\)/);
assert.doesNotMatch(prepareBody, /\.plan\(&payload\)/);
assert.match(prepareBody, /if raster_only_protocol\(&protocol\)/);
assert.match(nativePrint, /fn raster_only_protocol\([\s\S]*?"image" \| "browser" \| "epl" \| "cpcl" \| "dpl" \| "sbpl"/);
assert.match(prepareBody, /record_renderer_fallback\(bitmap\.mono\.len\(\)\)/);

const packBody = nativePrint.slice(
  nativePrint.indexOf('    pub fn record_and_print_pack('),
  nativePrint.indexOf('    pub fn close_box(', nativePrint.indexOf('    pub fn record_and_print_pack(')),
);
assert.match(packBody, /let numbering = persisted\.load_numbering_config\(\);/);
assert.equal((packBody.match(/load_numbering_config\(\)/g) || []).length, 1);
assert.match(packBody, /product_box_tare_kg\(operational, &product\)/);
assert.match(packBody, /next_boxes_in_pallet\(&counters\)/);
assert.match(nativePrint, /fn next_boxes_in_pallet\([\s\S]*?i64::from\(integer\(counters\.get\("currentBoxId"\)\)\.is_none\(\)\)/);

const tareBody = nativePrint.slice(
  nativePrint.indexOf('    fn product_box_tare_kg('),
  nativePrint.indexOf('    fn prepare(', nativePrint.indexOf('    fn product_box_tare_kg(')),
);
assert.match(tareBody, /number\(product\.get\("box_weight"\)\)/);
assert.match(tareBody, /self\.container_tare_kg/);
assert.match(nativePrint, /station_number_cache: Arc<OnceLock<String>>/);
assert.match(nativePrint, /fn cached_station_number\(/);
assert.match(persisted, /printer_cache: RwLock<Option<Value>>/);
assert.match(persisted, /numbering_cache: RwLock<Option<Value>>/);
assert.match(persisted, /save_printer_config[\s\S]*?store_cached\(&self\.printer_cache/);
assert.match(persisted, /save_numbering_config[\s\S]*?store_cached\(&self\.numbering_cache/);

const countersBody = operational.slice(
  operational.indexOf('fn latest_counters(connection:'),
  operational.indexOf('\nfn open_pallet_content(', operational.indexOf('fn latest_counters(connection:')),
);
assert.match(countersBody, /status = 'Open' AND nomenclature_id = \?1/);
assert.match(countersBody, /idx|COUNT\(\*\)|SUM\(weight_netto\)/);
assert.match(operational, /fn query_json_rows[\s\S]*?\.prepare_cached\(sql\)/);
const finishBranch = runtime.slice(
  runtime.indexOf('Ok(UiMessage::ProductionFinished {'),
  runtime.indexOf('Ok(UiMessage::DeleteFinished', runtime.indexOf('Ok(UiMessage::ProductionFinished {')),
);
assert.match(finishBranch, /if matches!\(action\.as_str\(\), "pack" \| "auto-pack"\) \{\s*auto_print_gate\.borrow_mut\(\)\.mark_failed\(\);/);

assert.match(printer, /set_nodelay\(true\)/);
assert.match(printer, /keep_tcp_connection_open/);
assert.match(printer, /automatic_tcp_job_boundary/);
assert.match(printer, /physical_key/);
assert.match(printer, /mpsc::sync_channel\(PRINTER_QUEUE_CAPACITY\)/);
assert.match(printer, /\.durable\s*\.prepare\(/);
assert.match(printer, /BREAKER_DURATION/);

const serial = read('src-tauri/src/printer/serial.rs');
const write = read('src-tauri/src/printer/write.rs');
const schema = read('src-tauri/src/operational_counters.sql');
const processor = read('src-tauri/src/processor.rs');
const nativeUi = read('src-tauri/src/native_ui.rs');
assert.match(printer, /write_job_once\(/);
assert.match(serial, /write_job_once\(/);
assert.match(printer, /error\.can_retry\(attempts\)/);
assert.match(serial, /error\.can_retry\(attempts\)/);
assert.match(write, /self\.bytes_written == 0/);
assert.match(write, /!self\.flushing/);
assert.match(write, /DELIVERY_UNCERTAIN/);
assert.match(printer, /min_by_key\(\|\(_, entry\)\| entry\.last_used_at\)/);
assert.match(printer, /!matches!\(entry\.outcome, IdempotencyOutcome::Pending\)/);
assert.match(countersBody, /SELECT total_units, total_boxes FROM operational_totals WHERE id = 1/);
assert.doesNotMatch(countersBody, /SELECT COUNT\(\*\) FROM (?:pack|boxes) WHERE status/);
assert.match(processor, /include_str!\("operational_counters\.sql"\)/);
assert.equal((schema.match(/CREATE TRIGGER IF NOT EXISTS operational_totals_/g) || []).length, 6);
assert.match(schema, /BEGIN IMMEDIATE;/);
assert.match(schema, /COMMIT;/);
assert.match(schema, /WHERE NOT EXISTS \(SELECT 1 FROM operational_totals WHERE id = 1\)/);
assert.match(finishBranch, /apply_print_counters/);
assert.doesNotMatch(finishBranch, /apply_snapshot\(/);
assert.equal((runtime.match(/runtime\s*\.production_delta\(/g) || []).length, 5);
const deltaBody = nativeUi.slice(nativeUi.indexOf('    pub fn production_delta('), nativeUi.indexOf('    pub fn weighing_snapshot('));
assert.match(deltaBody, /latest_counters/);
assert.doesNotMatch(deltaBody, /self\.products|containers\(\)|list_operators\(\)|station_snapshot/);
assert.match(finishBranch, /delta\.matches_selection\(selected_product\.get\(\)\)/);
console.log('Print performance/functionality: single-pass generation, cached settings, byte-aware replay, bounded terminal LRU, transactional totals and post-print deltas');

const durable = read('src-tauri/src/printer/durable.rs');
assert.match(packBody, /record_pack_with_outbox/);
assert.match(packBody, /with_idempotency_key[\s\S]*?persist\(transaction\)/);
assert.match(packBody, /submit_committed_with_sink/);
assert.doesNotMatch(packBody, /self\.remember\(stored\)\?/);
assert.match(nativePrint, /close_box_with_outbox/);
assert.match(nativePrint, /fn remember_accepted/);
assert.match(nativePrint, /atomic_write_bytes\(&self\.last_print_path, &bytes\)/);
assert.match(operational, /let outbox = prepare_outbox\(&transaction, &result\)\?;[\s\S]*?\.commit\(\)/);
assert.match(durable, /fn prepare_on_connection/);
assert.match(printer, /fn prepare_generated/);
assert.match(printer, /fn submit_committed_with_sink/);
assert.match(finishBranch, /result\.success_message\(message\)/);
console.log('Atomic pack/box outbox: prepared material, commit before transport, accepted receipts survive repeat-cache persistence errors');
