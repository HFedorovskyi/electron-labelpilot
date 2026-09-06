# LabelPilot Client 2.0

Промышленный клиент печати и учёта на React/Vite + Tauri 2 + Rust.

## Runtime

- Основной runtime по умолчанию: native Slint без WebView2.
- Tauri/WebView2 сохранён как автоматический fallback и диагностический runtime.
- Native backend обоих runtime: общий Rust core (`src-tauri`).
- `labelpilot-tauri.exe` выбирает runtime; `labelpilot-slint.exe` устанавливается тем же NSIS/updater.
- При отсутствии или ранней ошибке sidecar автоматически запускается Tauri; `--no-ui-fallback` отключает этот механизм для диагностики.
- Electron, Node runtime, preload и native Node modules в production dependency graph отсутствуют.

Идентификатор `com.labelpilot.electron`, каталог `%APPDATA%/electron-labelpilot` и имя GitHub-репозитория сохранены как неизменяемые compatibility identifiers: это обеспечивает обновление существующих станций и чтение накопленной базы/настроек.

## Команды

- `npm run dev` — Vite renderer.
- `npm run tauri:dev` — полное приложение.
- `npm run desktop:run:tauri` — запуск полного Tauri UI.
- `npm run desktop:run:slint` — запуск native Slint UI через production dispatcher.
- `npm run build` — TypeScript + production renderer.
- `npm run tauri:check` — раздельный compile gate для Tauri main и Slint sidecar.
- `npm run test:migration` — Tauri contracts, printing, UI and telemetry regression suite.
- `cargo test --manifest-path src-tauri/Cargo.toml` — полный native test suite.
- `npm run tauri:release` — signed dual-runtime NSIS release, updater signature, `latest.json`, hashes and verification log.
- `npm run benchmark:runtime` — process-tree CPU/RAM/startup measurement for the Tauri runtime.

## Printer coverage

Native ZPL/TSPL generation, raster adapters for EPL/CPCL/DPL/SBPL, TCP/Serial/Windows RAW transport, Windows GDI label printing and ordinary page-sheet printing are selected by the Rust planner. Complex documents use the on-demand renderer bitmap path; `bwip-js` remains isolated in a lazy chunk.

## Resource profile

The main renderer bundle is gated below 160 KiB, operating screens are lazy chunks below 50 KiB each, barcode generation loads on demand, printer queues and telemetry outbox are bounded. Slint defaults to the GPU-backed `winit-skia-opengl` renderer for subpixel text, falls back to Skia software rendering when OpenGL is unavailable, keeps `winit-femtovg` as an explicit low-footprint override, and exits the Tauri dispatcher after sidecar startup.

## Release

Version `2.0.3` is packaged as a current-user NSIS EXE containing both Tauri and Slint runtime binaries with signed updater metadata. Production telemetry persists structured events, retries encrypted delta reports, and writes a final shutdown spool.

## Native updates

- `npm run test:native-updater` checks the native updater, package contract, offline staging and transactional rollback.
- `scripts/new-native-update-package.ps1` creates a stored ZIP package for low-power stations, embeds signed version/platform metadata, signs the whole package with Minisign and emits `native-latest.json`.
- Online updates are downloaded in a bounded 64 KiB stream. The same manifest and package can be copied to USB and selected on the update screen.
- `labelpilot-maintenance.exe` snapshots the database, print outbox and settings, atomically replaces binaries, waits for the new client health marker, then automatically restores binaries and client data if startup confirmation is absent.