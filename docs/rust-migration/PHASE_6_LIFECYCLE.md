# Phase 6: lifecycle, offline transfer and Tauri packaging

Status: implemented on 2026-08-14. The React/Vite UI and its current layout are unchanged.

## Runtime behavior

- Online updates use `tauri-plugin-updater` and a signed `latest.json` manifest.
- Download progress is emitted through the existing `updater:progress` event.
- Before online or offline installation, the runtime creates an atomic backup of the database, identity, settings, counters, report state and outbox.
- Three newest backups are retained. Rollback is queued and applied before SQLite opens on the next application start.
- Offline installers accept `.exe` and `.msi`; the app creates a backup, launches a passive/silent installer and exits.
- Identity, full-sync, print-job and report files use native Tauri file dialogs.
- USB payloads are size-bounded, versioned and authenticated with HMAC-SHA256 before import.
- Demo seed, demo exit and database reset now execute in Rust and keep the existing desktop bridge channels.

## Compatibility with Electron installations

The Tauri bundle uses identifier `com.labelpilot.electron` and `currentUser` NSIS mode. Runtime data continues to resolve through the existing LabelPilot data directory contract, so `client_data.db`, identity and JSON settings are reused instead of creating a second profile. Backups remain under `<data-dir>/backups` and do not move the live data directory.

## Local signed release

```powershell
npm run test:phase6
npm run tauri:release
```

The default private updater key is read from `$HOME/.tauri/labelpilot-updater.key`; only its public key is stored in `src-tauri/tauri.conf.json`. CI reads `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` from GitHub Actions secrets.

Output: `artifacts/rust-migration-phase-6-release` containing the NSIS EXE, detached signature, `latest.json`, SHA-256 list and verification log.

## Release gates

1. TypeScript/Vite production build passes without UI changes.
2. All Rust tests pass, including backup retention, pending rollback, outbox merge, traversal rejection and USB tamper rejection.
3. `scripts/test-phase6-contracts.cjs` verifies every migrated channel, command registration, updater key/endpoint and bundle settings.
4. Tauri creates a signed NSIS installer plus `.sig`; the detached signature is verified with the public key.
5. The generated updater manifest points at the exact signed installer asset.
