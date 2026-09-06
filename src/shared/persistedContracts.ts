export type PersistedRecord = Record<string, unknown>;

export const DEFAULT_SCALE_CONFIG: PersistedRecord = {
    type: 'simulator',
    protocolId: 'simulator',
    pollingInterval: 250,
    stabilityCount: 4,
};

export const DEFAULT_NUMBERING_CONFIG: PersistedRecord = {
    unit: { enabled: false, length: 3, prefix: '' },
    box: { enabled: false, length: 3, prefix: '' },
    pallet: { enabled: false, length: 3, prefix: '' },
};

const DEFAULT_DEVICE_CONFIG: PersistedRecord = {
    id: 'default',
    active: false,
    name: 'Not Configured',
    connection: 'windows_driver',
    protocol: 'image',
    compatibilityMode: 'auto',
    port: 9100,
    baudRate: 9600,
    dpi: 203,
};

export const DEFAULT_PRINTER_CONFIG: PersistedRecord = {
    packPrinter: { ...DEFAULT_DEVICE_CONFIG, id: 'pack_default', name: 'Pack Printer' },
    boxPrinter: { ...DEFAULT_DEVICE_CONFIG, id: 'box_default', name: 'Box Printer' },
    palletPrinter: { ...DEFAULT_DEVICE_CONFIG, id: 'pallet_default', name: 'Pallet Printer' },
    autoPrintOnStable: true,
    serverIp: '',
    language: 'ru',
};

function isRecord(value: unknown): value is PersistedRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeRoot(defaultValue: PersistedRecord, value: unknown): PersistedRecord {
    const result = structuredClone(defaultValue);
    if (!isRecord(value)) return result;
    return { ...result, ...structuredClone(value) };
}

export function normalizeScaleConfig(value: unknown): PersistedRecord {
    return mergeRoot(DEFAULT_SCALE_CONFIG, value);
}

export function normalizeNumberingConfig(value: unknown): PersistedRecord {
    return mergeRoot(DEFAULT_NUMBERING_CONFIG, value);
}

export function normalizePrinterConfig(value: unknown): PersistedRecord {
    const result = mergeRoot(DEFAULT_PRINTER_CONFIG, value);
    for (const role of ['packPrinter', 'boxPrinter', 'palletPrinter']) {
        const device = result[role];
        if (!isRecord(device)) continue;
        delete device.persistentConnection;
        if (device.widthMm !== 58 || device.heightMm !== 40) continue;
        delete device.widthMm;
        delete device.heightMm;
    }
    return result;
}
