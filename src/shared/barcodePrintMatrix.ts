/**
 * Executable barcode support matrix for the public print path.
 *
 * `portableZplRoute` is intentionally conservative: only firmware commands that are
 * consistent across the inexpensive ZPL emulators in the supported printer park are
 * emitted natively. Every other symbology remains available through bwip-js rasterization.
 */

export type BarcodeDimension = 'linear' | 'matrix' | 'stacked';
export type PortableZplRoute = 'native-linear' | 'raster';
export type NativeZplLinearCommand = 'code128' | 'ean13' | 'ean8' | 'upca' | 'upce';

export interface BarcodePrintMatrixEntry {
    bcid: string;
    aliases: readonly string[];
    dimension: BarcodeDimension;
    sampleValue: string;
    serverSupported: boolean;
    gs1: boolean;
    portableZplRoute: PortableZplRoute;
    zplFullNative: boolean;
    tsplFullNative: boolean;
    nativeCommand?: NativeZplLinearCommand;
    fixedModules?: number;
    valuePattern?: RegExp;
    maximumLength: number;
}

const entries: readonly BarcodePrintMatrixEntry[] = [
    { bcid: 'ean13', aliases: ['21', 'ean-13', 'ean13_kz'], dimension: 'linear', sampleValue: '4870254930134', serverSupported: true, gs1: false, portableZplRoute: 'native-linear', zplFullNative: true, tsplFullNative: true, nativeCommand: 'ean13', fixedModules: 95, valuePattern: /^\d{12,13}$/, maximumLength: 13 },
    { bcid: 'ean8', aliases: ['22', 'ean-8'], dimension: 'linear', sampleValue: '96385074', serverSupported: false, gs1: false, portableZplRoute: 'native-linear', zplFullNative: true, tsplFullNative: true, nativeCommand: 'ean8', fixedModules: 67, valuePattern: /^\d{7,8}$/, maximumLength: 8 },
    { bcid: 'upca', aliases: ['upc', 'upc-a'], dimension: 'linear', sampleValue: '036000291452', serverSupported: false, gs1: false, portableZplRoute: 'native-linear', zplFullNative: true, tsplFullNative: true, nativeCommand: 'upca', fixedModules: 95, valuePattern: /^\d{11,12}$/, maximumLength: 12 },
    { bcid: 'upce', aliases: ['upc-e'], dimension: 'linear', sampleValue: '04252614', serverSupported: false, gs1: false, portableZplRoute: 'native-linear', zplFullNative: true, tsplFullNative: true, nativeCommand: 'upce', fixedModules: 51, valuePattern: /^\d{6,8}$/, maximumLength: 8 },
    { bcid: 'code128', aliases: ['23', 'code-128'], dimension: 'linear', sampleValue: 'LP-2026-000001', serverSupported: true, gs1: false, portableZplRoute: 'native-linear', zplFullNative: true, tsplFullNative: true, nativeCommand: 'code128', maximumLength: 128 },
    { bcid: 'gs1-128', aliases: ['gs1128', 'ean128'], dimension: 'linear', sampleValue: '(01)04870254930134(10)BATCH26', serverSupported: false, gs1: true, portableZplRoute: 'raster', zplFullNative: true, tsplFullNative: false, maximumLength: 512 },
    { bcid: 'qrcode', aliases: ['qr'], dimension: 'matrix', sampleValue: 'https://labelpilot.local/LP-2026-000001', serverSupported: true, gs1: false, portableZplRoute: 'raster', zplFullNative: true, tsplFullNative: true, maximumLength: 4096 },
    { bcid: 'gs1qrcode', aliases: ['gs1qr', 'qrdatabar', 'gs-1'], dimension: 'matrix', sampleValue: '(01)04870254930134(10)BATCH26', serverSupported: true, gs1: true, portableZplRoute: 'raster', zplFullNative: true, tsplFullNative: false, maximumLength: 4096 },
    { bcid: 'datamatrix', aliases: ['dm'], dimension: 'matrix', sampleValue: 'LP:2026:000001', serverSupported: false, gs1: false, portableZplRoute: 'raster', zplFullNative: true, tsplFullNative: true, maximumLength: 3116 },
    { bcid: 'gs1datamatrix', aliases: ['gs1dm'], dimension: 'matrix', sampleValue: '(01)04870254930134(10)BATCH26', serverSupported: false, gs1: true, portableZplRoute: 'raster', zplFullNative: true, tsplFullNative: false, maximumLength: 3116 },
    { bcid: 'pdf417', aliases: [], dimension: 'stacked', sampleValue: 'LP|2026|000001|BATCH26', serverSupported: false, gs1: false, portableZplRoute: 'raster', zplFullNative: false, tsplFullNative: false, maximumLength: 1850 },
    { bcid: 'databarexpandedstacked', aliases: ['databar', 'gs1databar'], dimension: 'stacked', sampleValue: '(01)04870254930134(10)BATCH26', serverSupported: true, gs1: true, portableZplRoute: 'raster', zplFullNative: false, tsplFullNative: false, maximumLength: 74 },
    { bcid: 'code39', aliases: ['code-39'], dimension: 'linear', sampleValue: 'LP2026000001', serverSupported: false, gs1: false, portableZplRoute: 'raster', zplFullNative: true, tsplFullNative: true, maximumLength: 128 },
    { bcid: 'interleaved2of5', aliases: ['itf', 'itf14', 'itf-14', 'i2of5'], dimension: 'linear', sampleValue: '12345678901234', serverSupported: false, gs1: false, portableZplRoute: 'raster', zplFullNative: true, tsplFullNative: true, valuePattern: /^\d+$/, maximumLength: 128 },
    { bcid: 'azteccode', aliases: ['aztec'], dimension: 'matrix', sampleValue: 'LP:2026:000001', serverSupported: false, gs1: false, portableZplRoute: 'raster', zplFullNative: false, tsplFullNative: false, maximumLength: 3067 },
];

export const BARCODE_PRINT_MATRIX: readonly BarcodePrintMatrixEntry[] = Object.freeze(entries);
const byBcid = new Map(entries.map(entry => [entry.bcid, entry]));

export function barcodePrintMatrixEntry(bcid: string): BarcodePrintMatrixEntry | undefined {
    return byBcid.get(String(bcid || '').toLowerCase());
}

export function isBarcodeMatrixValueValid(entry: BarcodePrintMatrixEntry, value: string): boolean {
    if (!value || value.length > entry.maximumLength) return false;
    if (entry.valuePattern && !entry.valuePattern.test(value)) return false;
    return true;
}

export interface PortableNativeLinearSpec {
    bcid: string;
    command: NativeZplLinearCommand;
    modules: number;
}

export function portableNativeLinearSpec(bcid: string, value: string): PortableNativeLinearSpec | null {
    const entry = barcodePrintMatrixEntry(bcid);
    if (!entry || entry.portableZplRoute !== 'native-linear' || !entry.nativeCommand) return null;
    if (!isBarcodeMatrixValueValid(entry, value) || /[\^~\r\n]/.test(value)) return null;
    const modules = entry.fixedModules || Math.max(33, value.length * 11 + 22);
    return { bcid: entry.bcid, command: entry.nativeCommand, modules };
}

export const BARCODE_MATRIX_DPIS = Object.freeze([203, 300, 600] as const);