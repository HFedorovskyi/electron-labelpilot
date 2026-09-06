# Phase 2.2b — Rust HTTP ingress, LPI2 and sync processor

Date: 2026-08-13

## Scope completed

- Added the local Rust HTTP ingress on 0.0.0.0:5556.
- Preserved OPTIONS, loopback-only GET /api/full_sync, and POST routes /api/sync_db, /api/full_sync, /api/print_job.
- Preserved CORS headers and response/status shapes used by the current server.
- Added exact LPI2 framing: magic line, signed token, IV and AES-256-CBC ciphertext.
- Added Ed25519 verification with the production public key, HKDF-SHA256 key derivation and PKCS#7 validation.
- Plain JSON remains available only before a station has a license token.
- Added strict unified sync-envelope validation and the existing minimum-client-version check.
- Added identity locking, server-IP persistence, SQLite station update and server-owned master-data replacement.
- Added online print-job validation and progress/completed-state preservation.
- Added renderer events: sync-complete, data-updated, print-jobs-updated, printer-config-updated.
- Added desktop_ingress_summary, graceful stop and runtime diagnostics.

## Weak-device bounds

- One named worker: labelpilot-ingress.
- Header limit: 16 KiB.
- Sync body limit: 64 MiB.
- Print-job body limit: 1 MiB.
- Header timeout: 30 seconds.
- Request/body timeout: 60 seconds.
- One request buffer at a time; unknown routes are rejected without reading or allocating their bodies.
- SQLite busy timeout: 5 seconds, WAL and synchronous=NORMAL.
- No Tokio runtime, Hyper stack or per-request thread/task allocation was added.

## Data consistency

- Full sync runs in one SQLite transaction.
- Foreign keys are suspended before the transaction and restored on every success/error path, matching the current Electron import when operational rows reference master data.
- Nomenclature, containers, barcodes, labels and operators are replaced; pack/box/pallet operational data remains intact.
- Identity and printer configuration are persisted only after the database transaction commits.
- A repeated print job preserves printed_qty and a completed status.

## Verification

- Node/Rust binary fixture proves Ed25519, HKDF and AES-CBC byte compatibility.
- Rust tests cover signature/ciphertext tampering, plaintext rejection after binding, sync validation, minimum-version rejection, identity lock, foreign-key references, print-job progress preservation, HTTP route caps, CORS and connection close.
- Release EXE smoke verified OPTIONS, sync import, print job, 413 limit, loopback snapshot and SQLite/identity rows.
- The locally persisted deployment token is from an older signing key; the release smoke verified that the production key rejects it. A current server-signed production push remains the deployment handshake test.
