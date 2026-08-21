'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const durable = read('src-tauri/src/printer/durable.rs');
const printer = read('src-tauri/src/printer.rs');
const processor = read('src-tauri/src/processor.rs');
const operational = read('src-tauri/src/operational.rs');
const commands = read('src-tauri/src/commands.rs');
const runtime = read('src-tauri/src/lib.rs');
const bridge = read('src/renderer/platform/tauriBridge.ts');
const build = read('src-tauri/build.rs');

for (const state of ['queued', 'rendering', 'sending', 'accepted', 'uncertain', 'failed', 'cancelled']) {
    assert.ok(durable.includes(`"${state}"`), `Durable state is absent: ${state}`);
}

for (const marker of [
    'CREATE TABLE IF NOT EXISTS printer_delivery_jobs',
    'payload BLOB NOT NULL',
    'idempotency_key TEXT',
    'receipt_json TEXT',
    'idx_printer_delivery_state_created',
    'idx_printer_delivery_idempotency',
]) {
    assert.ok(processor.includes(marker), `Main SQLite schema is missing ${marker}`);
    assert.ok(durable.includes(marker), `Durable store schema is missing ${marker}`);
}

assert.match(durable, /WHERE state IN \('rendering', 'sending'\)/);
assert.match(durable, /process stopped while delivery was in progress/);
assert.match(durable, /DURABLE_IDEMPOTENCY_CONFLICT/);
assert.match(durable, /DURABLE_JOB_IN_PROGRESS/);
assert.match(durable, /DURABLE_RETRY_REQUIRED/);
assert.match(durable, /WHERE job_id = \?3 AND state = 'sending'/);
assert.match(durable, /RETENTION_MS: i64 = 30 \* 24 \* 60 \* 60 \* 1_000/);
assert.match(durable, /MAX_RECOVERY_JOBS: usize = 512/);
assert.match(durable, /PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL/);
assert.match(durable, /did not transition from \{from\} to \{to\}/);

assert.match(printer, /DurablePrintStore::open\(path\)/);
assert.match(printer, /durable\.mark_sending\(job_id\)/);
assert.match(printer, /durable\.mark_accepted\(job_id, receipt\)/);
assert.match(printer, /durable\.mark_uncertain\(job_id, error\)/);
assert.match(printer, /labelpilot-durable-recovery/);
assert.match(printer, /printer-durable-job-update/);
assert.match(runtime, /recover_pending\(app\.handle\(\)\.clone\(\)\)/);
assert.match(operational, /DELETE FROM printer_delivery_jobs/);
assert.match(build, /Microsoft\.Windows\.Common-Controls/);

const commandNames = [
    'desktop_printer_durable_jobs',
    'desktop_printer_durable_summary',
    'desktop_printer_retry_durable',
    'desktop_printer_cancel_durable',
];
for (const name of commandNames) {
    assert.ok(commands.includes(`fn ${name}`), `Rust command is missing: ${name}`);
    assert.ok(runtime.includes(`commands::${name}`), `Rust command is not registered: ${name}`);
    assert.ok(bridge.includes(`'${name}'`), `Renderer command is not exposed: ${name}`);
}

for (const api of [
    'getTauriDurablePrintJobs',
    'getTauriDurableQueueSummary',
    'retryTauriDurablePrintJob',
    'cancelTauriDurablePrintJob',
    'listenTauriDurablePrintJobs',
]) {
    assert.ok(bridge.includes(`function ${api}`), `Renderer durable API is missing: ${api}`);
}
assert.match(bridge, /durableJobId\?: string/);
assert.match(bridge, /durableState\?: TauriDurablePrintState/);
assert.match(bridge, /printer-durable-job-update/);

console.log('Durable print queue: 7 explicit states, SQLite BLOB payloads, 30-day terminal retention');
console.log('Restart policy: queued jobs recover, rendering/sending jobs become uncertain, accepted keys deduplicate');
console.log('Durable IPC: list, summary, explicit retry/cancel, live update event');
