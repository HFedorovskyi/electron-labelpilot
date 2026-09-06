/**
 * barcodeTypes — single source of truth for barcode-symbology classification.
 *
 * Shared by:
 *   - the renderer browser/preview path (LabelRenderer.tsx → bwip-js in the DOM)
 *   - the main-process print path (CanvasBitmapGenerator → hybrid native-ZPL / bwip-js raster)
 *
 * Keeping the mapping here (instead of duplicated inline in each path) guarantees the
 * preview and the printed label agree on which symbology a template's `barcodeType` means.
 *
 * Pure TS — no runtime or DOM imports — so both Vite and contract tests can compile it.
 */

/** A bwip-js barcode id (bcid), e.g. 'ean13', 'code128', 'gs1-128', 'qrcode'. */
export type BcId = string;

/**
 * Normalize a template's `barcodeType` — which may be a legacy numeric code
 * ('21', '22', '23'), a friendly/UI name ('Ean13_KZ', 'QR'), or already a bwip-js
 * bcid — into a canonical bwip-js bcid. Unknown values pass through unchanged so the
 * full bwip-js symbology set stays reachable (defaulting to code128 only when empty).
 */
export function normalizeBarcodeType(raw: unknown): BcId {
    const t = String(raw ?? '').toLowerCase().trim();
    switch (t) {
        case '21':
        case 'ean13':
        case 'ean-13':
        case 'ean13_kz':
        case 'ean13kz':
            return 'ean13';
        case '22':
        case 'ean8':
        case 'ean-8':
            return 'ean8';
        case '23':
        case 'code128':
        case 'code-128':
            return 'code128';
        case 'gs1-128':
        case 'gs1128':
        case 'ean128':
            return 'gs1-128';
        case 'upca':
        case 'upc-a':
        case 'upc':
            return 'upca';
        case 'upce':
        case 'upc-e':
            return 'upce';
        case 'qr':
        case 'qrcode':
            return 'qrcode';
        case 'gs1qr':
        case 'gs1qrcode':
        case 'qrdatabar':
        case 'gs-1':
            return 'gs1qrcode';
        case 'datamatrix':
        case 'dm':
            return 'datamatrix';
        case 'gs1datamatrix':
        case 'gs1dm':
            return 'gs1datamatrix';
        case 'databar':
        case 'gs1databar':
        case 'databarexpandedstacked':
            // bwip-js / BWIPP encoder is 'databarexpandedstacked' — there is NO
            // 'gs1databarexpandedstacked' encoder (that name silently fell back to code128).
            return 'databarexpandedstacked';
        case 'itf':
        case 'itf14':
        case 'itf-14':
        case 'i2of5':
        case 'interleaved2of5':
            return 'interleaved2of5';
        case 'code39':
        case 'code-39':
            return 'code39';
        case 'pdf417':
            return 'pdf417';
        case 'aztec':
        case 'azteccode':
            return 'azteccode';
        default:
            return t || 'code128';
    }
}

/**
 * Symbologies we render with NATIVE ZPL barcode commands (^BC/^BE/^B8/^BU/^B9/^BQ/^BX).
 * Restricted to the universal command set supported across Zebra / TSC / Honeywell ZPL
 * emulation — these print fast and pixel-perfect from the printer firmware. Every other
 * symbology (DataBar, PDF417, Aztec, ITF, Code39, all GS1 variants) is rasterized via
 * bwip-js → ^GFA, which prints identically on any ZPL printer regardless of firmware.
 */
const NATIVE_SAFE: ReadonlySet<BcId> = new Set([
    'code128', 'ean13', 'ean8', 'upca', 'upce', 'qrcode', 'datamatrix',
]);

/** True when the symbology has a native ZPL command in the universal set. */
export function isNativeSafe(bcid: BcId): boolean {
    return NATIVE_SAFE.has(bcid);
}

/**
 * True for GS1 symbology variants that require FNC1 / Application-Identifier parsing.
 * These are always rasterized via bwip-js (parse:true) for correct FNC1 encoding.
 */
export function isGs1Variant(bcid: BcId): boolean {
    // DataBar (all variants) is inherently a GS1 symbology carrying AI data, so it
    // needs FNC1/parse handling and the raster path just like the gs1* encoders.
    return bcid.startsWith('gs1') || bcid.startsWith('databar');
}

/**
 * True when a value carries GS1 Application Identifiers in (NN) paren notation
 * (the value generator emits these for `ai` fields). Native ZPL would encode the
 * parens literally, so such values must go through bwip-js with parse enabled.
 */
export function hasGs1Ai(value: string): boolean {
    return /\(\d{2,4}\)/.test(value);
}

/**
 * Final routing decision: should this barcode be rasterized (bwip-js → ^GFA)
 * rather than emitted as a native ZPL command?
 *   - GS1 variants                → raster (FNC1 correctness)
 *   - values with (NN) AIs        → raster (FNC1 correctness)
 *   - anything not in NATIVE_SAFE → raster (universal printer support)
 *   - otherwise                   → native ZPL command (fast, sharp)
 */
export function shouldRasterizeBarcode(bcid: BcId, value: string): boolean {
    if (isGs1Variant(bcid)) return true;
    if (hasGs1Ai(value)) return true;
    return !isNativeSafe(bcid);
}

/**
 * Whether bwip-js should parse the value (GS1 AI notation / FNC1).
 * Used by the raster path to mirror the browser path's behavior exactly.
 */
export function needsGs1Parse(bcid: BcId, value: string): boolean {
    return isGs1Variant(bcid) || hasGs1Ai(value);
}
