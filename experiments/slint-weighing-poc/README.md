# LabelPilot Slint weighing PoC

Isolated native UI experiment for the production `WeighingStation` screen. The production
Tauri frontend remains the control implementation.

## Build

```powershell
cargo build --release --manifest-path experiments/slint-weighing-poc/Cargo.toml
```

## Visual parity and adaptive layout

The Slint layer now mirrors the production Tauri `WeighingStation` shell: Inter fonts,
Tailwind neutral/emerald/amber/red tokens, 256 px sidebar, Lucide assets, card radii,
touch states, status pills, action tiles, statistics rows and modal hierarchy. The
1366×768 logical viewport is the pixel-reference layout.

Responsive modes are driven from the native window size (DPI-aware):

- `>= 1280 px`: full 256 px sidebar and 8/4 work columns;
- `1120..1279 px`: 72 px icon sidebar and reduced outer padding;
- `1024..1119 px`: compact status text, 72 px sidebar and dense right panel;
- `< 720 px` height: shorter action tiles and statistics rows;
- large displays: centered work area capped at 1500 px.

The executable starts full-screen. For controlled visual tests, use:

```powershell
$env:LABELPILOT_SLINT_WINDOWED=1
$env:LABELPILOT_SLINT_WINDOW_WIDTH=1366
$env:LABELPILOT_SLINT_WINDOW_HEIGHT=768
experiments\slint-weighing-poc\target\release\labelpilot-slint-weighing-poc.exe
```

## UI-only control modes

Idle:

```powershell
experiments\slint-weighing-poc\target\release\labelpilot-slint-weighing-poc.exe
```

Synthetic 120 ms scale updates:

```powershell
$env:LABELPILOT_SLINT_LIVE_WEIGHT=1
experiments\slint-weighing-poc\target\release\labelpilot-slint-weighing-poc.exe
```

## Production Rust core mode

This mode uses the same `ScaleState`, scale protocol parsers, reconnect/watchdog logic,
`PrinterTransportState`, durable/idempotent queue and TCP/serial/Windows spooler backends
as the Tauri application. Tauri commands keep their existing API; Slint receives events
through a callback sink and does not start WebView2.

Default scale is the production simulator. Printing targets a ZPL TCP endpoint on
`127.0.0.1:9100`:

```powershell
$env:LABELPILOT_SLINT_NATIVE_RUNTIME=1
experiments\slint-weighing-poc\target\release\labelpilot-slint-weighing-poc.exe
```

Optional physical or virtual TCP endpoints:

```powershell
$env:LABELPILOT_SLINT_NATIVE_RUNTIME=1
$env:LABELPILOT_SCALE_HOST='127.0.0.1'
$env:LABELPILOT_SCALE_PORT='4001'
$env:LABELPILOT_SCALE_PROTOCOL='generic'
$env:LABELPILOT_PRINTER_HOST='127.0.0.1'
$env:LABELPILOT_PRINTER_PORT='9100'
experiments\slint-weighing-poc\target\release\labelpilot-slint-weighing-poc.exe
```

The screen covers the adaptive 1366×768 shell, product selection, live weight,
print/reprint/close-box/pallet actions, session counters, touch keypad, date picker,
delete confirmation, alerts and feedback. Printing runs off the UI thread.

## Verification

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --features native-ui --lib native_ui::tests::native_runtime_drives_tcp_scale_and_printer_without_tauri_app
$env:LABELPILOT_SLINT_SELF_TEST=1
experiments\slint-weighing-poc\target\release\labelpilot-slint-weighing-poc.exe
```

## Benchmark

```powershell
powershell -ExecutionPolicy Bypass -File experiments\slint-weighing-poc\benchmark.ps1 -SettleSeconds 10 -Samples 20 -SampleIntervalMs 1000
```
