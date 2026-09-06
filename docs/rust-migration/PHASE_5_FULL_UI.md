# Phase 5.4: full React UI in Tauri

Date: 2026-08-14

## Result

The release `labelpilot-tauri.exe` now starts the production React application instead of the migration diagnostics screen. Diagnostics remain available with `?diagnostics=true`.

## Native UI contract activated

- station identity and station number;
- products and fixed-weight products with container tare weight;
- containers, label documents and barcode templates;
- print-job list, progress, completion and deletion;
- installed Windows printer enumeration;
- printer warmup and conservative capability probing;
- settings test print through the same Rust planner/generator/transport path;
- merged record-and-print with the actual box number and regenerated barcode;
- unchanged `window.electron` compatibility surface for the React renderer.

The Tauri runtime registers 60 Rust commands. The desktop contract remains 59 invoke, 11 send and 19 event channels; migrated renderer operations are reported independently by diagnostics.

## Low-resource behavior

- the Tauri entry chunk is 14,570 bytes and loads the existing app chunks;
- `bwip-js` remains a separate lazy chunk and is not parsed at cold startup;
- SQLite uses one process-lifetime connection and bounded result sets (50 products);
- printer generation and transport remain off the UI thread;
- one native Windows spooler enumeration replaces a subprocess-based lookup;
- the default window is maximized and designed around 1366x768, with a 1024x640 minimum.

## Verification

- production TypeScript/Vite build passes;
- 60 Rust commands are registered and checked for handler drift;
- all 59 Rust tests pass;
- a dedicated catalog/station/template/print-job integration test passes;
- release CDP smoke confirms the production App is mounted rather than diagnostics;
- release smoke enumerates four Windows printer queues on the test workstation;
- one native ZPL and two bitmap fallback jobs deliver 14,377 bytes over one reused TCP connection;
- capability probe and the Settings test-print route succeed against the TCP ZPL receiver, reaching 14,571 total bytes with zero failed jobs.

## Remaining phase 6 work

Updater, offline installer, USB import/export, identity-file import, database reset/demo seeding and print-job file dialogs still use the Electron implementation. They are isolated from station startup and normal catalog/weigh/record/print operation.