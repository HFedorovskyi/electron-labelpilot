# Rust migration phase 2.1: persisted storage

Implemented on 2026-08-13 as the first slice of migration phase 2.

## Migrated desktop contracts

- `get-scale-config` / `save-scale-config`
- `get-numbering-config` / `save-numbering-config`
- `get-printer-config` / `save-printer-config`
- `get-identity`
- `get-next-sequence`

The Tauri adapter exposes the original channel names. Existing React callers do not need a channel rename.

## Data compatibility

Rust resolves the same Windows data directory used by Electron: `%APPDATA%\electron-labelpilot`. `LABELPILOT_DATA_DIR` is a test-only/runtime override. File names and JSON field names are unchanged:

- `scale-config.json`
- `numbering-config.json`
- `printer-config.json`
- `identity.json`
- `sequence-store.json`
- `client_data.db`

Scale, numbering and printer configuration keep root-level merge behavior and preserve unknown fields. The legacy 58x40 printer-size migration remains identical. Identity remains SQLite-first with JSON fallback. SQLite is opened read-only for this slice.

## Reliability and resource behavior

- JSON writes use a same-directory temporary file, `sync_all`, and atomic replacement.
- Windows replacement uses `MoveFileExW` with replace-existing and write-through flags.
- Sequence read/increment/write is serialized by one process-local mutex and returns only after durable persistence.
- Configuration reads are synchronous native file reads with no Node runtime or background worker.
- The Tauri diagnostic entry remains below 10 KB JavaScript and performs read-only smoke calls on startup.

## Verification

- Shared Electron/Rust synthetic fixtures cover defaults, root merging, unknown fields and legacy printer dimensions.
- Rust tests cover SQLite-first identity, JSON fallback, validation, atomic replacement cleanup and 32 concurrent unique sequences.
- Existing printer regression covers ZPL, TSPL, profile routing, capability detection and low-resource generation.
- Release EXE smoke runs against an isolated synthetic data directory and records successful WebView-to-Rust reads.

## Deferred side effects

This slice migrates persisted state only. Scale reconnect after `save-scale-config` remains in phase 4. Printer-service reload and transport reconfiguration after `save-printer-config` remain in phase 5. The parallel Electron runtime stays available until those services are migrated and soak-tested.

## Next slice

Phase 2.2 moves server ping, discovery, license/status polling and the bounded local HTTP listener while keeping the current server envelopes.
