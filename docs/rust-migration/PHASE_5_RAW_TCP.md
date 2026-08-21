# LabelPilot Rust migration — phase 5.1 raw TCP printer transport

## Scope

This slice moves raw TCP 9100 delivery into Rust while leaving label generation and the public legacy print IPC on the existing Electron path. The next slice can therefore port ZPL/TSPL generation against a verified native transport without changing printer behavior at the same time.

## Implemented

- one bounded worker queue per physical TCP endpoint, shared by pack/box roles that target the same printer;
- 16 queued jobs per printer, at most 12 active printer workers and 16 MiB per raw job;
- 3 s connect and write timeouts, TCP_NODELAY, one retry for non-timeout I/O failures and a 5 s circuit breaker;
- persistent socket reuse and the existing 400 ms idle close for non-persistent/emulator connections;
- default raw port 9100, current printer configuration schema and unchanged printer status event payload;
- renderer helpers for raw send, warmup, transport diagnostics and deterministic disconnect;
- compact six-card diagnostics grid for 1366x768 and touch layouts.

## Verified behavior

1. Rust loopback tests verify byte order, one persistent connection, idle close, endpoint validation, refused connection handling and explicit weak-device bounds.
2. The release EXE sends two ZPL jobs for different logical printer roles through one physical queue and one TCP connection; the receiver observes the exact 62 bytes in order.
3. The second release job reports socket reuse; diagnostics report two completed jobs, zero failures, queue capacity 16, maximum 12 workers and a 16 MiB payload cap.
4. All 50 Rust tests pass together with the migration, printer and Tauri contract suites.

## Rollback and next slice

The Electron TCP strategy and all generators remain present. The patch reverses to the verified phase 4.1 archive. Phase 5.2 will port generator orchestration and golden byte/geometric fixtures, then bind the public print-label route to this transport.
