# LabelPilot Rust migration — phase 5.2 native ZPL/TSPL generation

## Scope

This slice ports deterministic native ZPL and TSPL/TSPL2 stream generation into Rust and connects it directly to the verified phase 5.1 TCP transport. The existing Electron bitmap generator remains the explicit path for content that cannot be represented by the selected printer profile.

## Implemented

- native ZPL and TSPL generation for text, rectangles and supported 1D/2D printer barcode commands;
- printer-profile and compatibility-mode routing with explicit `rust-native` or `electron-bitmap` plans and reason lists;
- case-insensitive template interpolation plus legacy barcode-name normalization;
- 203, 300 and 600 DPI geometry using the same document/canvas scaling contract as Electron;
- direct Rust generation-to-transport handoff without a renderer Base64 round trip;
- bounded work for weak POS hardware: 1,024 elements, 8 MiB input and 16 MiB output, with blocking generation kept off the UI thread;
- renderer diagnostics for generated, fallback and failed job counts;
- four staging commands for plan, native preview, native generate-and-send and generator diagnostics.

## Compatibility behavior

Native output is selected only when every element is supported by the resolved printer profile. Tables, TSPL Unicode/styled text, pre-rendered barcode images and unsupported symbologies produce a deterministic bitmap-fallback plan. No content is silently dropped or substituted. The production Electron bitmap path remains available while the public `print-label` route is still unchanged.

## Verified behavior

1. Two shared TypeScript golden fixtures cover advanced ZPL at 203 DPI and native TSPL2 at 300 DPI; Rust matches all 889 bytes exactly.
2. Seven generator tests cover golden parity, 203/300/600 DPI geometry, legacy barcode names, fallback routing and resource limits.
3. The release EXE generated ZPL and TSPL, sent both exact streams through one reused TCP connection and reported two successful native jobs with zero fallbacks and failures.
4. All 57 Rust tests, migration contracts, printer regressions, Tauri runtime checks and scale/printer release smokes pass.

## Next slice

Phase 5.3 binds the public print-label orchestration to the Rust planner, calls the retained bitmap backend for explicit fallback plans, and adds serial and Windows spooler printer transports before physical model certification.
