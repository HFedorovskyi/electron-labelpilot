# LabelPilot Client 2.0

Промышленный клиент печати и учёта на React/Vite + Tauri 2 + Rust.

## Runtime

- Единственная desktop-оболочка: Tauri/WebView2.
- Native backend: Rust (`src-tauri`).
- UI bridge: `window.desktopBridge`.
- Один production entrypoint: `index.html` → `src/main.tsx`.
- Electron, Node runtime, preload и native Node modules в production dependency graph отсутствуют.

Идентификатор `com.labelpilot.electron`, каталог `%APPDATA%/electron-labelpilot` и имя GitHub-репозитория сохранены как неизменяемые compatibility identifiers: это обеспечивает обновление существующих станций и чтение накопленной базы/настроек.

## Команды

- `npm run dev` — Vite renderer.
- `npm run tauri:dev` — полное приложение.
- `npm run build` — TypeScript + production renderer.
- `npm run tauri:check` — Rust compile gate.
- `npm run test:migration` — Tauri contracts, printing, UI and telemetry regression suite.
- `cargo test --manifest-path src-tauri/Cargo.toml` — полный native test suite.
- `npm run tauri:release` — signed NSIS release, updater signature, `latest.json`, hashes and verification log.
- `npm run benchmark:runtime` — process-tree CPU/RAM/startup measurement for the Tauri runtime.

## Printer coverage

Native ZPL/TSPL generation, raster adapters for EPL/CPCL/DPL/SBPL, TCP/Serial/Windows RAW transport, Windows GDI label printing and ordinary page-sheet printing are selected by the Rust planner. Complex documents use the on-demand renderer bitmap path; `bwip-js` remains isolated in a lazy chunk.

## Resource profile

The main renderer bundle is gated below 160 KiB, operating screens are lazy chunks below 50 KiB each, barcode generation loads on demand, printer queues and telemetry outbox are bounded, and the runtime benchmark uses the full process tree at 1366×768.

## Release

Version `2.0.0` is packaged as a current-user NSIS EXE with signed updater metadata. Production telemetry persists structured events, retries encrypted delta reports, and writes a final shutdown spool.
