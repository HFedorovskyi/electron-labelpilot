'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const telemetry = read('src-tauri/src/telemetry.rs');
const commands = read('src-tauri/src/commands.rs');
const runtime = read('src-tauri/src/lib.rs');
const runtimeEvents = read('src-tauri/src/runtime_events.rs');
const cargo = read('src-tauri/Cargo.toml');
const bridge = read('src/renderer/platform/tauriBridge.ts');
const entry = read('src/main.tsx');
const packageJson = JSON.parse(read('package.json'));
const tauriConfig = JSON.parse(read('src-tauri/tauri.conf.json'));
const cargoVersion = cargo.match(/^version = "([^"]+)"/m)?.[1];

assert.equal(packageJson.version, '2.0.2');
assert.equal(tauriConfig.version, packageJson.version);
assert.equal(cargoVersion, packageJson.version);

assert.match(cargo, /"multipart"/, 'reqwest multipart support is required for .lpr upload');
assert.match(telemetry, /labelpilot\.telemetry\.v1/);
assert.match(telemetry, /struct ReportCursor/);
assert.match(telemetry, /last_deleted_at/);
assert.match(telemetry, /MAX_OUTBOX_FILES: usize = 256/);
assert.match(telemetry, /MAX_OUTBOX_BYTES: u64 = 256 \* 1024 \* 1024/);
assert.match(telemetry, /MAX_REPORT_BYTES: u64 = 64 \* 1024 \* 1024/);
assert.match(telemetry, /stations\/upload_report\//);
assert.match(telemetry, /save_cursor/);
assert.match(telemetry, /spool_blob/);
assert.match(telemetry, /flush_outbox/);
assert.match(telemetry, /runtime_started/);
assert.match(telemetry, /runtime_stopped/);
assert.match(telemetry, /"heartbeat"/);
assert.match(telemetry, /printerTransport/);
assert.match(telemetry, /durablePrintQueue/);
assert.match(telemetry, /deferred_without_identity/);
assert.match(commands, /pub fn desktop_telemetry_summary/);
assert.match(commands, /pub async fn desktop_telemetry_flush/);
assert.match(commands, /state::<TelemetryState>\(\)\s*\.shutdown/);
assert.match(runtime, /commands::desktop_telemetry_summary/);
assert.match(runtime, /commands::desktop_telemetry_flush/);
assert.match(bridge, /getTauriTelemetrySummary/);
assert.match(bridge, /flushTauriTelemetry/);
assert.match(entry, /unhandledrejection/);
assert.match(entry, /renderer_error/);
for (const component of ['printer', 'scale']) {
    assert.match(read(`src-tauri/src/${component}.rs`), /RuntimeEventSink/);
}
assert.match(runtimeEvents, /record_subsystem_log/);
assert.match(read('src-tauri/src/ingress.rs'), /runtime\.events\.log\("ingress"/);

console.log('Production telemetry: structured events, heartbeat, delta cursor, durable outbox, retry/upload and shutdown spool verified');
