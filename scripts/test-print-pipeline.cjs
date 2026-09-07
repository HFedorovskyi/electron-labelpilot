const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const batch = read('src-tauri/src/native_print/batch.rs');
const pack = read('src-tauri/src/native_print/pack.rs');
const service = read('src-tauri/src/native_print.rs');
const operational = read('src-tauri/src/operational.rs');
const transport = read('src-tauri/src/printer.rs');
const ui = read('src-tauri/src/native_ui.rs');
const slint = read('src-tauri/src/slint_runtime.rs');
const metrics = read('src-tauri/src/native_print/metrics.rs');
const tests = read('src-tauri/src/native_print/pipeline_tests.rs');

assert.match(batch, /prefetch_capacity: 1/);
assert.match(batch, /prefetch_byte_limit: MAX_RAW_JOB_BYTES/);
assert.match(batch, /peak_prepared_jobs = 1/);
assert.match(batch, /prepared\.timings\.bytes > MAX_RAW_JOB_BYTES/);
assert.doesNotMatch(batch, /thread::spawn|thread::scope|VecDeque|mpsc::channel/);
assert.match(batch, /pending\.is_ok\(\)[\s\S]*?!must_close_box[\s\S]*?!cancelled\(\)/);
const overlap = batch.slice(batch.indexOf('let pending = self.dispatch_pack('), batch.indexOf('let finished = self.finish_pack('));
assert.match(overlap, /let future =/);
assert.match(overlap, /Some\(self\.prepare_batch_pack\(/);
assert.doesNotMatch(overlap, /\?;|return |break;/);
assert.match(batch, /outcome\.completed \+= 1;[\s\S]*?outcome\.last_print = Some\(printed\);/);
assert.match(batch, /outcome\.fail\("transport", error, Some\(job_id\)\)/);
assert.match(batch, /outcome\.fail\("box-close", error, None\)/);
assert.match(batch, /Some\(Err\(error\)\)[\s\S]*?outcome\.fail\("prepare", error, None\)/);
assert.match(batch, /outcome\.failure\.is_none\(\)[\s\S]*?outcome\.completed < copies[\s\S]*?cancelled\(\)/);
assert.match(pack, /const MAX_PREPARATION_ATTEMPTS: usize = 3/);
assert.match(pack, /for retry in 0\.\.MAX_PREPARATION_ATTEMPTS[\s\S]*?if cancelled\(\)/);
assert.match(pack, /record_pack_with_outbox_checked\(\s*Some\(&counters\)/);
assert.match(pack, /prepared\.timings\.add_preparation\(&timings\)/);
assert.match(pack, /pending\.and_then\(PendingPrintReceipt::wait\)/);
assert.match(pack, /remember_accepted/);
assert.match(pack, /box_close_error = Some\(error\.clone\(\)\)/);
assert.match(operational, /transaction_with_behavior\(rusqlite::TransactionBehavior::Immediate\)[\s\S]*?latest_counters\(&transaction, Some\(payload\.nomenclature_id\)\)[\s\S]*?return Ok\(None\)/);
assert.match(operational, /let result = record_pack_transaction[\s\S]*?prepare_outbox\(&transaction, &result\)[\s\S]*?\.commit\(\)/);
assert.match(service, /operation_gate: Arc<Mutex<\(\)>>/);
assert.equal((service.match(/let _operation = self\.lock_production\(\)\?/g) || []).length, 5);
assert.match(batch, /let _operation = self\.lock_production\(\)\?/);
assert.match(ui, /fixed_batch: Arc<Mutex<FixedBatchState>>/);
assert.match(ui, /impl Drop for FixedBatchLease/);
assert.doesNotMatch(ui, /fixed_batch_active\.swap|fixed_batch_cancel\.store/);
assert.equal((ui.match(/\.emit\("fixed-batch-finished"/g) || []).length, 1);
assert.match(ui, /summary\["nativePrint"\]/);
assert.match(slint, /result\.status_message\(\)/);
assert.match(slint, /failure\.stage == "transport"[\s\S]*?ui\.set_printer_ready\(false\)/);
assert.match(metrics, /METRIC_WINDOW_CAPACITY: usize = 512/);
assert.match(metrics, /window\.samples\.pop_front\(\)/);
assert.match(metrics, /p50: at\(50\),[\s\S]*?p95: at\(95\)/);
assert.match(transport, /recv_timeout\(self\.deadline\.saturating_duration_since\(Instant::now\(\)\)\)/);
for (const name of [
  'pipeline_overlaps_without_reserving_future_rows_and_respects_box_barriers',
  'pipeline_transport_failure_discards_prefetch_and_exposes_the_committed_job',
  'pipeline_future_preparation_error_preserves_current_acceptance',
  'pipeline_outbox_error_rolls_back_pack_box_pallet_and_counters',
  'pipeline_box_outbox_error_stops_after_accepted_pack_and_repeat_is_exact',
  'pipeline_stale_counter_snapshot_is_reprepared_before_atomic_commit',
  'pipeline_repeated_counter_conflicts_are_bounded_and_never_create_own_outbox',
  'pipeline_snapshot_freezes_product_templates_devices_numbering_and_operator',
  'pipeline_ui_cancellation_before_commit_during_dispatch_and_prefetch_preserves_receipts',
  'pipeline_ui_preflight_errors_emit_one_terminal_event_and_clear_active_lease',
  'pipeline_ui_active_lease_clears_during_unwind',
]) assert.ok(tests.includes(`fn ${name}(`), name);
console.log('Print pipeline contracts: bounded preparation, mandatory receipt wait, atomic counter revalidation, cancellation lease, partial outcomes and timing window');
