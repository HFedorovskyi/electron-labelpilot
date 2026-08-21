# Phase 7.3 — weak-device UI loading and runtime optimization

Date: 2026-08-21

## Objective

Reduce renderer startup work without changing the printing, scale, sync, operator, or station contracts. The production comparison uses the same final React UI in Tauri and Electron and forces both windows to 1366×768 before sampling.

## Confirmed bottleneck

Process-role profiling showed that the residual desktop memory is dominated by the fixed WebView2 process tree rather than the Rust host or the application JavaScript heap. The Tauri host was approximately 11.5 MiB private, while the WebView2 GPU process alone was approximately 178.7 MiB private in the original full-screen profile.

Disabling GPU acceleration was tested rather than assumed. At 1366×768 it reduced private bytes but increased working set from 390.8 MiB to 516.9 MiB and selected the WARP software renderer. The production build therefore keeps normal GPU acceleration.

## Implemented changes

- The three operating stations are separate lazy chunks.
- Only the weighing station mounts during initial startup.
- A station mounts on first selection and remains mounted while hidden, preserving the active production session.
- Date picker, product selection, item deletion, and numeric keypad implementations load on first use.
- `bwip-js` remains isolated from the startup graph.
- The runtime benchmark now positions each runtime at 1366×768 and records the target viewport.
- Source contracts assert chunk bounds and the initial mount graph.
- A release-EXE CDP smoke test verifies real loaded chunks, tab transitions, retained mounts, and the renderer heap.

## Bundle result

| Asset | Result |
|---|---:|
| Main App chunk before | 252.81 KiB |
| Main App chunk after | 127.65 KiB |
| Main App reduction | 49.5% |
| Weighing station | 31.14 KiB |
| Fixed-weight station | 32.99 KiB |
| Print-job station | 32.73 KiB |
| `bwip-js` lazy chunk | 863.80 KiB |

The release smoke observed only the weighing station implementation at startup. After visiting all stations, all three remained mounted and the post-GC JavaScript heap was 2,618,300 bytes used.

## Runtime benchmark at 1366×768

| Metric | Tauri | Electron | Change |
|---|---:|---:|---:|
| Cold start | 242.6 ms | 983.2 ms | 75.3% faster |
| Main executable | 20,469,248 B | 232,336,896 B | 91.2% smaller |
| Median process-tree working set | 404,807,680 B | 442,486,784 B | 8.5% lower |
| Median process-tree private bytes | 281,735,168 B | 337,412,096 B | 16.5% lower |
| Peak sampled private bytes | 281,927,680 B | 338,657,280 B | 16.8% lower |
| Normalized idle CPU | 2.27% | 2.56% | 0.29 pp lower |

The 2.5 s cold-start and 5% idle-CPU gates pass. The strict full-process-tree targets of 120 MiB working set and 200 MiB peak private remain open because they are below the observed WebView2 baseline. The application-level JavaScript startup graph is now bounded independently.

## Operational verification

The final release EXE completed the 30-second mixed workload:

- 120/120 native ZPL jobs delivered;
- 12 printer connections and reconnect cycles observed;
- 117 scale polls over 12 scale connections;
- 15/15 full-sync requests completed;
- print command p50/p95/max: 4.35/6.28/9.85 ms;
- private trend: -25,755,648 bytes;
- working-set trend: +2,904,064 bytes;
- all 16 workload and resource gates passed.

The migration regression suite passes and all 89 Rust tests pass. Printing, scale, sync, barcode, durable-queue, Windows RAW/GDI, and industrial protocol routing contracts are unchanged.

## Next qualification gate

Run the existing eight-hour soak on a representative 4 GB / 1366×768 workstation, then populate the physical printer and scale matrix before canary activation.
