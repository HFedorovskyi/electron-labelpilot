# LabelPilot Rust migration - phase 5.3 public print routing

Phase 5.3 activates the existing public print-label contract in the Tauri runtime and completes the first native transport matrix for industrial label printers.

## Runtime routing

1. Every public print request is normalized once in the renderer and submitted to the Rust planner.
2. Native-compatible ZPL or TSPL labels are generated and sent entirely in Rust without a bitmap or renderer Base64 round trip.
3. Complex labels lazily load the Canvas fallback:
   - ZPL/image outputs bounded GFA;
   - TSPL outputs a binary BITMAP command;
   - browser/Windows-driver output sends a 1-bit bitmap to the Rust GDI adapter.
4. bwip-js is imported only when a fallback label contains a barcode.

## Printer transports

- TCP 9100: existing endpoint-keyed FIFO, optional persistent socket and one reconnect retry.
- Serial: persistent 8N1 port, no flow control, configurable 300..4,000,000 baud, write timeout and one reconnect retry.
- Windows RAW: OpenPrinter/StartDocPrinter/WritePrinter for printer-language byte streams.
- Windows GDI: CreateDC/StartDoc/StretchDIBits for 1-bit bitmap labels.
- Windows queue selection accepts an explicit driverName or the system default printer via GetDefaultPrinterW.

All transports retain the process-wide limits of 12 workers, 16 queued jobs per physical printer and 16 MiB per job.

## Weak-device behavior

The production Tauri entry is approximately 12.6 KiB. Public orchestration is approximately 2.1 KiB and the Canvas fallback approximately 9.6 KiB. The approximately 884 KiB bwip-js module is a separate lazy chunk, so native print jobs do not load it.

Canvas work is capped at 1,024 elements and 8,000,000 pixels. Encoded output is capped at 16 MiB.

## Verification

- 58 Rust tests pass.
- Migration, low-resource printer, generator parity and public-routing contracts pass.
- Missing Windows queue probe fails before a print job is created.
- Release raw TCP, scale, native generator and HTTP ingress regressions pass.
- Public release smoke sends three ordered jobs through window.electron.invoke('print-label'):
  - one exact native ZPL golden stream;
  - one ZPL GFA bitmap fallback;
  - one TSPL binary BITMAP fallback.
- Observed result: 14,377 total bytes, 13,921 fallback bytes, one reused TCP connection and zero failed jobs.

Physical certification remains to be executed on representative low-cost and industrial TCP, Serial, Windows RAW and Windows GDI printer families.