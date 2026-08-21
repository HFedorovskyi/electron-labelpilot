# Phase 2.2a — Rust network client and UDP discovery

Date: 2026-08-13

## Scope completed

- Replaced Electron ping path for the Tauri runtime with a bounded `reqwest::blocking::Client`.
- Preserved `/api/v1/stations/ping/?station_uuid=...`, strict ping schema, version compatibility and the existing three-second timeout.
- Migrated `/api/v1/license/`; the complete server object is preserved for forward compatibility.
- Added adaptive status polling: 5 seconds while disconnected, 15 seconds while connected, 60 seconds while the window is hidden.
- Added one named background thread, `labelpilot-network`, for polling and UDP discovery; no per-request runtime or unbounded task spawning.
- Added UDP 5555 station/server announcements every 3 seconds to broadcast and loopback.
- The receiver binds UDP 5555 when available and falls back to an ephemeral port for co-located service compatibility.
- Discovery datagrams are bounded to 4 KiB and normalized to the renderer contracts `server-found` / `station-found`.
- Migrated IPC: `sync-data`, `get-server-status`, `get-license-status`, `set-app-mode`, `renderer-ready`.
- Added a diagnostic command `desktop_network_summary` and visible runtime diagnostics.

## Resource profile

- One worker thread shared by HTTP status and UDP discovery.
- One pooled idle connection per host.
- HTTP connect and total request timeout: 3000 ms.
- UDP receive buffer: 4096 bytes.
- Worker tick: 250 ms; no busy loop.
- UI calls use `spawn_blocking`, keeping WebView/Tauri IPC responsive on weak POS hardware.

## Verification

- Six Rust network tests cover ping, version rejection text, missing identity, malformed ping, full license-object preservation, discovery normalization and endpoint construction.
- Static contract test verifies all bounds, intervals, worker count strategy, UDP destinations and five bridge mappings.
- Existing Electron and printer paths remain unchanged and are covered by their regression suites.

## Deliberate next slice

Phase 2.2b will migrate local HTTP ingress on port 5556 only together with the processor handoff and LPI2 validation. Keeping ingress disabled until that complete path is available avoids accepting production requests that cannot yet be committed transactionally.
