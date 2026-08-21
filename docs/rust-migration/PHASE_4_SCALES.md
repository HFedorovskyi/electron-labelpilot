# Phase 4.1 — Rust scale runtime

Date: 2026-08-14

## Delivered

The Tauri runtime now owns scale discovery, connection lifecycle, polling, decoding, stability filtering and renderer events. Electron `ScaleManager` remains available as the rollback runtime and its public IPC contract is unchanged.

### Transports

- Serial discovery and open through the Rust `serialport` backend.
- Per-protocol baud rate, parity, data bits and stop bits; an explicit configured baud rate overrides the profile default.
- TCP connect/read/write timeouts with `TCP_NODELAY`.
- Simulator mode with a minimum 700 ms interval.
- One worker per active scale, generation fencing and synchronous shutdown.
- Bounded reconnect delay: 250 ms, 500 ms, 1 s, then 2 s maximum.
- 64 KiB maximum frame decoder buffer and 4 KiB read chunks.

### Protocol catalog

The Rust catalog has byte/parser parity fixtures for all 20 Electron profiles:

`cas_simple`, `mettler_sics`, `massak_100`, `massak_p1`, `massak_astb`, `massak_astbp`, `massak_j`, `massak_cont`, `massak_lite`, `shtrih_m`, `mertech`, `and_standard`, `dibal_delta`, `ohaus`, `sartorius_sbi`, `radwag`, `kern`, `dini_argeo`, `simulator`, `generic`.

The catalog covers line protocols plus Massa-K 100 and J binary framing. Generic ASCII remains the fallback for devices that output stable numeric text without a dedicated profile.

### Desktop contract

The existing channels are mapped to Rust:

- send: `connect-scale`, `disconnect-scale`, `save-scale-config`;
- invoke: `get-scale-config`, `get-scale-status`, `get-serial-ports`, `get-protocols`;
- events: `scale-reading`, `scale-status`, `scale-error`.

The release runtime also exposes `desktop_scale_summary` for worker/frame/drop/reconnect diagnostics. There are 38 registered Rust commands in total and 34 migrated user-facing desktop operations.

### Filtering and resource limits

- Configurable stability window bounded to 2–32 samples.
- 5 g stability delta in kilogram-normalized parsers.
- 120 ms UI throttle and 0.5 g dedup epsilon.
- Stability transitions bypass normal weight throttling.
- Error events are deduplicated while reconnect attempts continue.
- No async runtime is required for the continuous serial/TCP read path; one named native thread blocks on bounded I/O.

## Verification

- Shared replay corpus: 20/20 Electron and Rust protocol results match.
- Rust scale tests: 11/11, including binary framing, partial/coalesced lines, configuration bounds and renderer error codes.
- TCP loopback: poll command, fragmented response, EOF detection and reconnect.
- Decoder soak: 20,000 frames, buffer remains below 64 KiB and returns empty after every complete frame.
- Release EXE smoke: two connections, two polls, fragmented frame parsed and reconnect passed.
- Full Tauri contract: TypeScript/Vite build, Cargo check and 38-command registration test passed.

## Hardware qualification

Software protocol parity is complete. Physical model certification is tracked separately because USB/RS-232 converters, firmware variants, cable wiring and flow-control behavior require the actual devices. The Electron scale runtime is retained unchanged until that matrix has representative devices for each protocol family.

## Commands

```text
npm run test:scale
npm run test:tauri
npm run tauri:build
npm run smoke:scale
```