# Phase 8 — Electron runtime retirement

Date: 2026-08-21
Version: 2.0.0

## Result

The active client source, renderer entrypoint, package dependencies, build scripts and release CI now target Tauri only.

Removed production surfaces:

- `src/main/**` Node desktop backend;
- `src/preload/**` and context bridge;
- Electron renderer/print-worker entrypoints;
- `tsconfig.electron.json` and `dist-electron` build path;
- Electron Builder configuration and development/release commands;
- Electron, Electron Builder, updater/logger packages and Node native SQLite/serial dependencies;
- `window.electron` compatibility alias;
- dual-runtime release and resource benchmark paths.

The application now has one renderer page, `index.html`, and one bridge, `window.desktopBridge`. Fallback label rasterization runs inside the Tauri renderer and is named `renderer-bitmap`.

## One-time Electron update bridge

Release packaging publishes two manifests for the same NSIS installer. Deployed 1.3.x clients read `latest.yml` through `electron-updater`; Tauri 2.x clients read the signed `latest.json` through `tauri-plugin-updater`. Both channels verify the exact installer bytes (`SHA-512` for Electron and the detached Tauri updater signature for Tauri). The Windows identifier and `%APPDATA%/electron-labelpilot` data directory remain unchanged, so the transition reuses the existing database, identity, license, printer profiles and outbox.

## Compatibility identifiers retained

The following strings remain intentionally unchanged and do not load Electron code:

- Windows application identifier `com.labelpilot.electron`;
- persisted data directory `%APPDATA%/electron-labelpilot`;
- repository/update URL containing `electron-labelpilot`.

Changing them would split the installed application identity or disconnect deployed stations from their database, settings and updater endpoint.

## Verification gates

- TypeScript/Vite production build;
- desktop bridge inventory and Rust/TypeScript channel parity;
- printer transport/generator/raster/public-routing contracts;
- full Rust test suite;
- production telemetry contract and runtime smoke;
- signed NSIS build and signature verification;
- source/dependency audit for production Electron imports and binaries.

The 1.3.x installer remains a standalone rollback artifact; it is not compiled or bundled by the 2.0.0 repository pipeline.
