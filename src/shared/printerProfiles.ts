export type PrinterCompatibilityMode = 'auto' | 'compatible' | 'advanced';
export type PrinterProfileLanguage = 'zpl' | 'tspl' | 'epl' | 'cpcl' | 'dpl' | 'sbpl' | 'driver';
export type ZplGraphicEncoding = 'none' | 'ascii-rle' | 'z64';
export type PrinterProfileId =
    | 'generic-zpl-safe'
    | 'zpl-full'
    | 'generic-tspl-safe'
    | 'tspl2-full'
    | 'generic-epl-raster'
    | 'generic-cpcl-raster'
    | 'generic-dpl-raster'
    | 'generic-sbpl-raster'
    | 'windows-driver';

export interface PrinterProfileFeatures {
    nativeText: boolean;
    nativeUtf8Text: boolean;
    nativeBarcodeTypes: readonly string[];
    bitmap: boolean;
    z64: boolean;
    ramGraphics: boolean;
    roundedBoxes: boolean;
    bidirectionalStatus: boolean;
}

export interface PrinterCompatibilityProfile {
    id: PrinterProfileId;
    language: PrinterProfileLanguage;
    tier: 'compatible' | 'advanced' | 'driver';
    features: PrinterProfileFeatures;
    commandTerminator: '' | '\n' | '\r' | '\r\n';
    zplGraphicEncoding: ZplGraphicEncoding;
}

const ZPL_1D = ['code128', 'gs1-128', 'ean13', 'ean8', 'upca', 'upce', 'code39', 'interleaved2of5'] as const;
const ZPL_2D = ['qrcode', 'gs1qrcode', 'datamatrix', 'gs1datamatrix'] as const;
const TSPL_1D = ['code128', 'ean13', 'ean8', 'upca', 'upce', 'code39', 'interleaved2of5'] as const;
const TSPL_2D = ['qrcode', 'datamatrix'] as const;

export const PRINTER_COMPATIBILITY_PROFILES: Readonly<Record<PrinterProfileId, PrinterCompatibilityProfile>> = {
    'generic-zpl-safe': {
        id: 'generic-zpl-safe',
        language: 'zpl',
        tier: 'compatible',
        features: {
            nativeText: true,
            nativeUtf8Text: false,
            nativeBarcodeTypes: ZPL_1D,
            bitmap: true,
            z64: false,
            ramGraphics: false,
            roundedBoxes: false,
            bidirectionalStatus: false,
        },
        commandTerminator: '\n',
        zplGraphicEncoding: 'none',
    },
    'zpl-full': {
        id: 'zpl-full',
        language: 'zpl',
        tier: 'advanced',
        features: {
            nativeText: true,
            nativeUtf8Text: true,
            nativeBarcodeTypes: [...ZPL_1D, ...ZPL_2D],
            bitmap: true,
            z64: true,
            ramGraphics: true,
            roundedBoxes: true,
            bidirectionalStatus: true,
        },
        commandTerminator: '\n',
        zplGraphicEncoding: 'z64',
    },
    'generic-tspl-safe': {
        id: 'generic-tspl-safe',
        language: 'tspl',
        tier: 'compatible',
        features: {
            nativeText: true,
            nativeUtf8Text: false,
            nativeBarcodeTypes: TSPL_1D,
            bitmap: true,
            z64: false,
            ramGraphics: false,
            roundedBoxes: false,
            bidirectionalStatus: false,
        },
        commandTerminator: '\r\n',
        zplGraphicEncoding: 'none',
    },
    'tspl2-full': {
        id: 'tspl2-full',
        language: 'tspl',
        tier: 'advanced',
        features: {
            nativeText: true,
            nativeUtf8Text: false,
            nativeBarcodeTypes: [...TSPL_1D, ...TSPL_2D],
            bitmap: true,
            z64: false,
            ramGraphics: false,
            roundedBoxes: true,
            bidirectionalStatus: true,
        },
        commandTerminator: '\r\n',
        zplGraphicEncoding: 'none',
    },
    'generic-epl-raster': {
        id: 'generic-epl-raster',
        language: 'epl',
        tier: 'compatible',
        features: {
            nativeText: false,
            nativeUtf8Text: false,
            nativeBarcodeTypes: [],
            bitmap: true,
            z64: false,
            ramGraphics: false,
            roundedBoxes: false,
            bidirectionalStatus: false,
        },
        commandTerminator: '\n',
        zplGraphicEncoding: 'none',
    },
    'generic-cpcl-raster': {
        id: 'generic-cpcl-raster',
        language: 'cpcl',
        tier: 'compatible',
        features: {
            nativeText: false,
            nativeUtf8Text: false,
            nativeBarcodeTypes: [],
            bitmap: true,
            z64: false,
            ramGraphics: false,
            roundedBoxes: false,
            bidirectionalStatus: false,
        },
        commandTerminator: '\r\n',
        zplGraphicEncoding: 'none',
    },
    'generic-dpl-raster': {
        id: 'generic-dpl-raster',
        language: 'dpl',
        tier: 'compatible',
        features: {
            nativeText: false,
            nativeUtf8Text: false,
            nativeBarcodeTypes: [],
            bitmap: true,
            z64: false,
            ramGraphics: false,
            roundedBoxes: false,
            bidirectionalStatus: false,
        },
        commandTerminator: '\r',
        zplGraphicEncoding: 'none',
    },
    'generic-sbpl-raster': {
        id: 'generic-sbpl-raster',
        language: 'sbpl',
        tier: 'compatible',
        features: {
            nativeText: false,
            nativeUtf8Text: false,
            nativeBarcodeTypes: [],
            bitmap: true,
            z64: false,
            ramGraphics: false,
            roundedBoxes: false,
            bidirectionalStatus: false,
        },
        commandTerminator: '',
        zplGraphicEncoding: 'none',
    },
    'windows-driver': {
        id: 'windows-driver',
        language: 'driver',
        tier: 'driver',
        features: {
            nativeText: false,
            nativeUtf8Text: false,
            nativeBarcodeTypes: [],
            bitmap: true,
            z64: false,
            ramGraphics: false,
            roundedBoxes: false,
            bidirectionalStatus: false,
        },
        commandTerminator: '\n',
        zplGraphicEncoding: 'none',
    },
};

export interface PrinterProfileSelection {
    protocol: 'zpl' | 'tspl' | 'epl' | 'cpcl' | 'dpl' | 'sbpl' | 'image' | 'browser';
    connection: 'tcp' | 'serial' | 'windows_driver';
    compatibilityMode?: PrinterCompatibilityMode;
    detectedProfileId?: PrinterProfileId;
    detectedEndpointKey?: string;
    ip?: string;
    port?: number;
    serialPort?: string;
    baudRate?: number;
    flowControl?: 'none' | 'hardware' | 'software';
    parity?: 'none' | 'even' | 'odd';
    dataBits?: 5 | 6 | 7 | 8;
    zplCompression?: ZplGraphicEncoding;
    /** Legacy graphics switch retained while persisted profiles migrate. */
    z64?: boolean;
    driverName?: string;
}

export function usesRasterSerialDefaults(protocol: PrinterProfileSelection['protocol']): boolean {
    return protocol !== 'browser';
}

export function effectiveSerialBaudRate(selection: PrinterProfileSelection): number {
    return selection.baudRate ?? (usesRasterSerialDefaults(selection.protocol) ? 115200 : 9600);
}

export function effectiveSerialFlowControl(selection: PrinterProfileSelection): 'none' | 'hardware' | 'software' {
    if (selection.flowControl) return selection.flowControl;
    return usesRasterSerialDefaults(selection.protocol) && effectiveSerialBaudRate(selection) >= 115200
        ? 'hardware'
        : 'none';
}

export function printerProfileEndpointKey(selection: PrinterProfileSelection): string {
    if (selection.connection === 'tcp') return `tcp:${selection.ip || ''}:${selection.port || 9100}`;
    if (selection.connection === 'serial') {
        return [
            'serial',
            (selection.serialPort || '').toUpperCase(),
            effectiveSerialBaudRate(selection),
            selection.dataBits ?? 8,
            selection.parity ?? 'none',
            effectiveSerialFlowControl(selection),
            1,
        ].join(':');
    }
    return `spooler:${selection.driverName || ''}`;
}

export function profileLanguageForSelection(selection: PrinterProfileSelection): PrinterProfileLanguage {
    // Transport and language are independent: a Windows RAW queue may still receive
    // ZPL/TSPL. Only browser/GDI rendering uses the driver profile.
    if (selection.protocol === 'browser') return 'driver';
    if (selection.protocol === 'image') return 'zpl';
    return selection.protocol;
}

export function compatibleProfileId(language: PrinterProfileLanguage): PrinterProfileId {
    if (language === 'zpl') return 'generic-zpl-safe';
    if (language === 'tspl') return 'generic-tspl-safe';
    if (language === 'epl') return 'generic-epl-raster';
    if (language === 'cpcl') return 'generic-cpcl-raster';
    if (language === 'dpl') return 'generic-dpl-raster';
    if (language === 'sbpl') return 'generic-sbpl-raster';
    return 'windows-driver';
}

export function advancedProfileId(language: PrinterProfileLanguage): PrinterProfileId {
    if (language === 'zpl') return 'zpl-full';
    if (language === 'tspl') return 'tspl2-full';
    return compatibleProfileId(language);
}

export function resolvePrinterProfile(selection: PrinterProfileSelection): PrinterCompatibilityProfile {
    const language = profileLanguageForSelection(selection);
    if (language === 'driver') return PRINTER_COMPATIBILITY_PROFILES['windows-driver'];

    const mode = selection.compatibilityMode || 'auto';
    if (mode === 'compatible') return PRINTER_COMPATIBILITY_PROFILES[compatibleProfileId(language)];
    if (mode === 'advanced') return PRINTER_COMPATIBILITY_PROFILES[advancedProfileId(language)];

    const detected = selection.detectedProfileId
        && selection.detectedEndpointKey === printerProfileEndpointKey(selection)
        ? PRINTER_COMPATIBILITY_PROFILES[selection.detectedProfileId]
        : undefined;
    return detected?.language === language
        ? detected
        : PRINTER_COMPATIBILITY_PROFILES[compatibleProfileId(language)];
}

export function effectiveZplGraphicEncoding(selection: PrinterProfileSelection): ZplGraphicEncoding {
    if (selection.zplCompression === 'none'
        || selection.zplCompression === 'ascii-rle'
        || selection.zplCompression === 'z64') {
        return selection.zplCompression;
    }
    if (selection.z64 === true) return 'z64';
    if (selection.z64 === false) return 'ascii-rle';
    return resolvePrinterProfile(selection).zplGraphicEncoding;
}
