# Phase 7.4 — production telemetry and logging

Date: 2026-08-21

## Implemented runtime path

- Local support logs remain bounded to current + previous 2 MiB rolling files.
- Structured `labelpilot.telemetry.v1` events are persisted in SQLite with UUID event IDs and sent through the existing server `StationLog` contract.
- The native worker emits startup, shutdown and periodic/reconnect/manual heartbeats containing network, ingress, scale, printer transport, durable print queue and native generator counters.
- Printer, scale and ingress warnings/errors enter the same structured sink; renderer `error` and `unhandledrejection` events are captured with bounded messages.
- Reports use the Electron-compatible compound delta cursor: pack id, error id and `(deleted_at, pack id)` for late deletions.
- The server upload uses the existing encrypted `.lpr` multipart endpoint. A cursor advances only after a confirmed upload or atomic local spool.
- The outbox retries at startup, every interval and on reconnect; shutdown performs a network-free final spool.
- Missing identity/license leaves rows behind the cursor for later delivery and increments a visible deferral counter.

## Resource and failure bounds

| Boundary | Value |
|---|---:|
| Report interval | 5 minutes; environment override is clamped to 1–60 minutes |
| Packs per delta | 2,000 |
| Late deletions per delta | 2,000 |
| Logs per delta | 500 |
| Encrypted report | 64 MiB |
| Outbox | 256 files / 256 MiB |
| Retry batch | 32 files |
| Structured event | 16 KiB |
| Reported SQLite log retention | latest 10,000 rows |

When an outbox boundary is reached, the watermark stays unchanged: source rows remain in SQLite rather than being acknowledged or discarded.

## Verification

- Rust tests cover late deletion cursor behavior, structured-event bounds and atomic outbox accounting.
- Contract tests assert multipart upload, endpoint, cursor, retention limits, subsystem sinks, shutdown spool, renderer exception capture and both diagnostic commands.
- Tauri exposes `desktop_telemetry_summary` and `desktop_telemetry_flush` for diagnostics and rollout checks.
