export type PersistedRecord = Record<string, unknown>;

export const DEFAULT_SCALE_CONFIG: PersistedRecord = {
    type: 'serial',
    protocolId: 'generic',
    path: '',
    baudRate: 9600,
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
    zplCompression: 'none',
    port: 9100,
    baudRate: 115200,
    flowControl: 'hardware',
    parity: 'none',
    dataBits: 8,
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
        if (typeof device.zplCompression === 'string') {
            device.zplCompression = device.zplCompression.trim().toLowerCase();
        } else if (typeof device.z64 === 'boolean') {
            // Preserve the exact behavior selected by the former two-state UI.
            device.zplCompression = device.z64 ? 'z64' : 'ascii-rle';
        } else {
            device.zplCompression = device.compatibilityMode === 'advanced'
                || device.detectedProfileId === 'zpl-full'
                ? 'z64'
                : 'none';
        }
        if (device.connection === 'serial') {
            const rasterProtocol = device.protocol !== 'browser';
            const baudRate = Number(device.baudRate ?? (rasterProtocol ? 115200 : 9600));
            device.baudRate = baudRate;
            device.flowControl = typeof device.flowControl === 'string'
                ? device.flowControl.trim().toLowerCase()
                : (rasterProtocol && baudRate >= 115200 ? 'hardware' : 'none');
            device.parity = typeof device.parity === 'string'
                ? device.parity.trim().toLowerCase()
                : 'none';
            device.dataBits ??= 8;
        }
        if (device.widthMm !== 58 || device.heightMm !== 40) continue;
        delete device.widthMm;
        delete device.heightMm;
    }
    return result;
}
