// The barcode generator moved to src/shared: recordPack (main process) regenerates the
// barcode inside its transaction once the ACTUAL box number is known — a colliding
// predicted box number used to leave the stale number encoded in the barcode while the
// label text got patched. Re-exported here so existing renderer imports keep working.
export * from '../../shared/barcodeGenerator';
