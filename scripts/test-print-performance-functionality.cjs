const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const generator = read('src-tauri/src/generator/mod.rs');
const nativePrint = read('src-tauri/src/native_print.rs');
const operational = read('src-tauri/src/operational.rs');
const runtime = read('src-tauri/src/slint_runtime.rs');
const weighingUi = read('src-tauri/slint/ui/weighing.slint');
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

const packBody = read('src-tauri/src/native_print/pack.rs');
assert.match(packBody, /let numbering = persisted\.load_numbering_config\(\);/);
assert.equal((packBody.match(/load_numbering_config\(\)/g) || []).length, 1);
assert.match(packBody, /product_box_tare_kg\(operational, &product\)/);
assert.match(packBody, /next_boxes_in_pallet\(/);
const autoCloseBody = packBody.slice(
  packBody.indexOf('    fn auto_close_pack('),
  packBody.indexOf('    pub(super) fn finish_pack(', packBody.indexOf('    fn auto_close_pack(')),
);
assert.match(autoCloseBody, /after\.units_in_box/);
assert.doesNotMatch(autoCloseBody, /latest_counter/);
assert.match(packBody, /after_counters/);
assert.match(nativePrint, /fn next_boxes_in_pallet\([\s\S]*?i64::from\(current_box_id\.is_none\(\)\)/);

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
  operational.indexOf('fn counter_snapshot('),
  operational.indexOf('\nfn open_pallet_content(', operational.indexOf('fn counter_snapshot(')),
);
assert.match(countersBody, /status = 'Open'[\s\S]*?\?1 IS NULL OR \?1 = 0 OR nomenclature_id = \?1/);
assert.match(countersBody, /idx|COUNT\(\*\)|SUM\(weight_netto\)/);
assert.match(operational, /fn query_json_rows[\s\S]*?\.prepare_cached\(sql\)/);
const finishBranch = runtime.slice(
  runtime.indexOf('Ok(UiMessage::ProductionFinished {'),
  runtime.indexOf('Ok(UiMessage::DeleteFinished', runtime.indexOf('Ok(UiMessage::ProductionFinished {')),
);
assert.match(finishBranch, /if matches!\(action\.as_str\(\), "pack" \| "auto-pack"\) \{\s*auto_print_gate\.borrow_mut\(\)\.mark_failed\(\);/);

assert.match(runtime, /struct UiMessageSender/);
assert.match(runtime, /slint::invoke_from_event_loop/);
assert.match(runtime, /ui\.on_drain_ui_messages/);
assert.doesNotMatch(runtime, /Duration::from_millis\(30\)/);
assert.match(weighingUi, /callback drain-ui-messages;/);
assert.match(runtime, /const UI_WORKER_THREADS: usize = 4;/);
assert.match(runtime, /const UI_WORKER_QUEUE_CAPACITY: usize = 64;/);
assert.match(runtime, /mpsc::sync_channel::<UiTask>/);
assert.match(runtime, /thread::Builder::new\(\)[\s\S]*?labelpilot-ui-worker-/);
assert.match(runtime, /std::panic::catch_unwind/);
assert.doesNotMatch(runtime, /thread::spawn\(/);
assert.match(runtime, /product_search_timer\.start\([\s\S]*?slint::TimerMode::SingleShot/);

assert.match(printer, /set_nodelay\(true\)/);
assert.match(printer, /keep_tcp_connection_open/);
assert.match(printer, /automatic_tcp_job_boundary/);
assert.match(printer, /physical_key/);
assert.match(printer, /mpsc::sync_channel\(PRINTER_QUEUE_CAPACITY\)/);
assert.match(printer, /\.durable\.prepare_with_replay\(/);
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
assert.match(countersBody, /\.prepare_cached\(/);
assert.equal((countersBody.match(/\.query_row\(/g) || []).length, 1);
assert.match(countersBody, /WITH[\s\S]*?open_pallet AS[\s\S]*?open_box AS[\s\S]*?box_totals AS/);
assert.match(countersBody, /totals\.total_units[\s\S]*?totals\.total_boxes/);
assert.match(operational, /fn after_record\([\s\S]*?total_units: self\.total_units\.saturating_add\(1\)/);
assert.match(operational, /Ok\(Some\(\(result, outbox, after\)\)\)/);
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
assert.match(packBody, /enqueue_committed_with_sink/);
assert.match(packBody, /pending\.and_then\(PendingPrintReceipt::wait\)/);
assert.doesNotMatch(packBody, /self\.remember\(stored\)\?/);
assert.match(nativePrint, /close_box_with_outbox/);
assert.match(nativePrint, /fn remember_accepted/);
assert.doesNotMatch(nativePrint, /atomic_write_bytes\(&self\.last_print_path, &bytes\)/);
assert.match(durable, /CREATE TABLE IF NOT EXISTS native_last_print/);
assert.match(durable, /promote accepted last-print replay/);
assert.match(operational, /let outbox = prepare_outbox\(&transaction, &result\)\?;[\s\S]*?\.commit\(\)/);
assert.match(durable, /fn prepare_on_connection/);
assert.match(printer, /fn prepare_generated/);
assert.match(printer, /fn submit_committed_with_sink/);
assert.match(finishBranch, /result\.success_message\(message\)/);
console.log('Atomic pack/box outbox: prepared material, SQLite replay, commit before transport and accepted-only last print');
