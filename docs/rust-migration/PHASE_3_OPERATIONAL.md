# LabelPilot Rust migration — phase 3.1 operational SQLite

Date: 2026-08-14

## Scope

This checkpoint moves the latency-sensitive production accounting path into the Tauri process while preserving the existing Electron database and renderer contracts.

## Implemented

- one process-lifetime SQLite connection guarded by a mutex;
- WAL mode, NORMAL synchronization, foreign keys and bounded busy timeout;
- compatible `pallet`, `boxes`, `pack` and `print_errors` schema upgrades;
- operational indexes for open-box, pallet and nomenclature lookups;
- transactional pack recording with open-box reuse;
- box-number collision resolution followed by barcode regeneration;
- automatic open-pallet creation and box placement;
- box close, pallet close and stray non-empty box rehoming;
- soft pack deletion and transactional weight correction;
- box deletion with closed-state and non-empty guards;
- latest counters, open pallet content and pallet render aggregation;
- operator list and Django PBKDF2-SHA256 credential verification;
- process-memory operator session and atomic last-operator hint;
- logout gate compatible with open pallet/box behavior;
- data-updated and session-changed renderer events;
- diagnostic UI counters using the real Rust SQLite repository.

## Desktop bridge

The following channels now map to Rust commands:

- `record-pack`;
- `close-box`;
- `get-latest-counters`;
- `get-open-pallet-content`;
- `get-pallet-render-data`;
- `close-pallet`;
- `delete-pack`;
- `delete-box`;
- `operators:list`;
- `session:get-current-operator`;
- `session:set-current-operator`;
- `session:logout`.

The Tauri scaffold exposes 32 commands in total; the runtime summary reports 29 migrated desktop channels plus native diagnostics.

## Barcode parity

The Rust generator accepts all 19 current and legacy production field variants, including constants, AI, weight fields, production/expiration dates, article/GTIN-14, batch, pack/box/pallet numbers and extra data. Collision handling uses the resolved box number before persistence.

## Resource model

- no Node worker or second database process;
- no connection open/close on each label;
- no unbounded task queue;
- SQLite writes remain short transactions;
- 1,000 sequential pack records complete in the full Rust test suite while reusing one connection and one open box.

## Verification

- 33 Rust tests pass;
- 1,000-pack persistent-connection scenario passes;
- transaction rollback and closed-state guards pass;
- copied Electron database migration/read/write/delete scenario passes;
- source Electron database hash is unchanged;
- Electron build and migration contracts pass;
- Tauri release runtime exposes the expected command inventory.

## Remaining phase 3 item

Report/outbox delivery remains on the Electron runtime in this checkpoint. Its Rust transport will be connected after the report endpoint, accepted fields, retry ownership and opt-in activation are frozen as an explicit deployment contract.

## Rollback

The release patch applies on top of the verified phase 2.2b artifact. Reverse application restores phase 2.2b source inputs; user SQLite data remains in the same compatible schema and location.

- Windows ingress now switches every accepted socket back to blocking mode before bounded request reads, removing intermittent WSAEWOULDBLOCK failures in release smoke tests.
