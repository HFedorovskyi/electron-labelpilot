'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const rust = read('src-tauri/src/printer.rs');
const backend = read('src-tauri/src/printer/backend.rs');
const spooler = read('src-tauri/src/printer/spooler.rs');
const commands = read('src-tauri/src/commands.rs');
const runtime = read('src-tauri/src/lib.rs');
const bridge = read('src/renderer/platform/tauriBridge.ts');
const screen = read('src/renderer/migration/MigrationRuntimeScreen.tsx');
const css = read('src/renderer/migration/migration.css');

function rustDuration(name, unit) {
    const match = rust.match(new RegExp(`const ${name}: Duration = Duration::from_${unit}\\((\\d+)\\);`));
    assert.ok(match, `Missing Rust duration ${name}`);
    return Number(match[1]);
}

function rustNumber(name) {
    const match = rust.match(new RegExp(`(?:pub )?const ${name}: usize = ([^;]+);`));
    assert.ok(match, `Missing Rust limit ${name}`);
    return Function(`"use strict"; return (${match[1].replaceAll('usize', '')});`)();
}

const rustPort = Number(rust.match(/const DEFAULT_TCP_PORT: u16 = (\d+);/)?.[1]);
assert.equal(rustPort, 9100);
assert.equal(rustDuration('CONNECT_TIMEOUT', 'secs') * 1000, 3000);
assert.equal(rustDuration('WRITE_TIMEOUT', 'secs') * 1000, 3000);
assert.equal(rustDuration('IDLE_CLOSE', 'millis'), 400);
assert.equal(rustDuration('BREAKER_DURATION', 'secs') * 1000, 5000);
assert.equal(rustNumber('PRINTER_QUEUE_CAPACITY'), 16);
assert.equal(rustNumber('MAX_PRINTER_WORKERS'), 12);
assert.equal(rustNumber('MAX_RAW_JOB_BYTES'), 16 * 1024 * 1024);
assert.equal(rustNumber('MAX_IDEMPOTENCY_ENTRIES'), 2048);
assert.match(rust, /IDEMPOTENCY_TTL: Duration = Duration::from_secs\(10 \* 60\)/);

for (const marker of [
    'set_nodelay(true)',
    'try_send(job)',
    'physical_key',
    'persistent_connection',
    'printer-status-update',
    'reconnects.fetch_add',
    'BASE64_STANDARD',
    '.decode(payload.data_base64.as_bytes())',
    'reserve_idempotency',
    'IDEMPOTENCY_OUTCOME_UNCERTAIN',
    'delivery_state',
    'confirmation_mode',
]) {
    assert.ok(rust.includes(marker), `Rust printer transport is missing ${marker}`);
}

for (const command of [
    'desktop_printer_send_raw',
    'desktop_printer_warmup_raw',
    'desktop_printer_transport_summary',
    'desktop_printer_disconnect_all',
]) {
    assert.ok(commands.includes(`fn ${command}`), `${command} implementation is missing`);
    assert.ok(runtime.includes(`commands::${command}`), `${command} is not registered`);
    assert.ok(bridge.includes(command), `${command} is not exposed by the renderer bridge`);
}

assert.match(rust, /driver_page_jobs/);
assert.match(backend, /SUPPORTED_PRINT_TARGETS/);
assert.match(spooler, /GetDeviceCaps/);
assert.match(bridge, /driverPageJobs: number/);
assert.match(bridge, /deduplicatedJobs: number/);
assert.match(bridge, /idempotencyConflicts: number/);
assert.match(bridge, /deliveryState:/);
assert.match(bridge, /confirmationMode:/);

assert.match(bridge, /function bytesToBase64\(data: Uint8Array\)/);
assert.match(bridge, /const chunkSize = 0x8000/);
assert.match(screen, /Принтер TCP Rust/);
assert.match(screen, /getTauriPrinterTransportSummary/);
assert.match(css, /migration-split \{[^}]*repeat\(3,/);
assert.match(css, /migration-printer span/);

console.log('Tauri printer transport contracts: TCP 9100, connect/write 3000 ms, idle close 400 ms');
console.log('Printer transport bounds: 16 jobs/printer, 12 workers, 16 MiB/job, breaker 5000 ms');
console.log('Printer transport bridge: raw queue plus bounded Windows label/page GDI and 10-minute idempotency');
