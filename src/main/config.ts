import { app } from 'electron';
import path from 'path';
import fs from 'fs';

const CONFIG_FILE = 'scale-config.json';
const NUMBERING_CONFIG_FILE = 'numbering-config.json';
const PRINTER_CONFIG_FILE = 'printer-config.json';

export interface ScaleConfig {
    type: 'serial' | 'tcp' | 'simulator';
    protocolId: string;
    path?: string; // Serial path
    baudRate?: number;
    host?: string; // TCP Host
    port?: number; // TCP Port
    pollingInterval?: number; // ms
    stabilityCount?: number;
}

const DEFAULT_CONFIG: ScaleConfig = {
    type: 'simulator',
    protocolId: 'simulator',
    // "Balanced" preset: ~1s perceived stabilization.
    // User can switch to Fast (450ms) or Accurate (2.5s) in Settings.
    pollingInterval: 250,
    stabilityCount: 4
};

export function getConfigPath(): string {
    return path.join(app.getPath('userData'), CONFIG_FILE);
}

// In-memory cache (write-through). All writers go through save*Config in-process, so the
// cache stays in sync; this removes the existsSync+readFileSync+JSON.parse that previously
// ran on EVERY call (e.g. the 5s status poller and i18n.t()). Reads return a clone so
// callers can't mutate the cached object.
let scaleCache: ScaleConfig | null = null;

export function loadScaleConfig(): ScaleConfig {
    if (scaleCache) return structuredClone(scaleCache);
    const configPath = getConfigPath();
    let result: ScaleConfig = DEFAULT_CONFIG;
    try {
        if (fs.existsSync(configPath)) {
            const data = fs.readFileSync(configPath, 'utf-8');
            result = { ...DEFAULT_CONFIG, ...JSON.parse(data) };
        }
    } catch (error) {
        console.error('Failed to load scale config:', error);
    }
    scaleCache = result;
    return structuredClone(result);
}

export function saveScaleConfig(config: ScaleConfig): void {
    const configPath = getConfigPath();
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
        scaleCache = structuredClone(config);
    } catch (error) {
        console.error('Failed to save scale config:', error);
    }
}


export interface NumberingConfig {
    unit: { enabled: boolean; length: number; prefix?: string; };
    box: { enabled: boolean; length: number; prefix?: string; };
    pallet: { enabled: boolean; length: number; prefix?: string; };
}

const DEFAULT_NUMBERING_CONFIG: NumberingConfig = {
    unit: { enabled: false, length: 3, prefix: '' },
    box: { enabled: false, length: 3, prefix: '' },
    pallet: { enabled: false, length: 3, prefix: '' }
};

export function getNumberingConfigPath(): string {
    return path.join(app.getPath('userData'), NUMBERING_CONFIG_FILE);
}

let numberingCache: NumberingConfig | null = null;

export function loadNumberingConfig(): NumberingConfig {
    if (numberingCache) return structuredClone(numberingCache);
    const configPath = getNumberingConfigPath();
    let result: NumberingConfig = DEFAULT_NUMBERING_CONFIG;
    try {
        if (fs.existsSync(configPath)) {
            const data = fs.readFileSync(configPath, 'utf-8');
            result = { ...DEFAULT_NUMBERING_CONFIG, ...JSON.parse(data) };
        }
    } catch (error) {
        console.error('Failed to load numbering config:', error);
    }
    numberingCache = result;
    return structuredClone(result);
}

export function saveNumberingConfig(config: NumberingConfig): void {
    const configPath = getNumberingConfigPath();
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
        numberingCache = structuredClone(config);
    } catch (error) {
        console.error('Failed to save numbering config:', error);
    }
}

// --- Printer Configuration ---

export type ConnectionType = 'tcp' | 'serial' | 'windows_driver';
export type PrinterProtocol = 'zpl' | 'tspl' | 'image' | 'browser';
/**
 * RAM-cache mode for the `image` protocol generator.
 *  'auto'   — probe the printer once after first print; use RAM if it supports ~DG/R:, else inline.
 *  'on'     — always use ~DG + R: + ^XG (fastest on Zebra ZPL II, no fallback).
 *  'off'    — never use ~DG; inline the static layer as ^GFA every time (safest, works on any ZPL-compatible).
 */
export type RamCacheMode = 'auto' | 'on' | 'off';

export interface PrinterDeviceConfig {
    id: string;
    active: boolean;
    name: string;          // User-friendly display name
    connection: ConnectionType;
    protocol: PrinterProtocol;

    // Connection Details
    ip?: string;           // For TCP
    port?: number;         // For TCP (default 9100)

    serialPort?: string;   // For Serial (e.g., COM1)
    baudRate?: number;     // For Serial (default 9600)

    driverName?: string;   // For Windows Driver (exact system printer name)

    // Physical Details
    dpi?: 203 | 300 | 600; // Printer resolution (critical for ZPL)
    widthMm?: number;      // Label width in mm
    heightMm?: number;     // Label height in mm

    darkness?: number;     // Print darkness (0-30)
    printSpeed?: number;   // Print speed (2-12)

    // RAM-cache mode for `image` protocol. Default: 'auto'.
    // Switch to 'off' for non-Zebra ZPL-compatible printers that lack ~DG/R: drive.
    ramCache?: RamCacheMode;

    // Encode the static-layer graphic as :Z64: (zlib+base64) instead of hex RLE.
    // 2-4x smaller payload — decisive on serial links. Off by default: Zebra ZPL II
    // and most modern emulations support it, but not every clone does.
    z64?: boolean;

    // TCP only. Keep the socket open between labels (with keepalive) instead of the
    // default 400ms idle-close. Real printers render on ^XZ and benefit (~10-100ms
    // reconnect saved per label at operator pace); the default close exists only for
    // virtual/Labelary-style receivers that finalize a job on connection close.
    persistentConnection?: boolean;
}

export interface PrinterConfig {
    // Specialized Printer Roles
    packPrinter: PrinterDeviceConfig;
    boxPrinter: PrinterDeviceConfig;
    palletPrinter: PrinterDeviceConfig;

    // Global Settings
    autoPrintOnStable: boolean;
    serverIp: string;
    language: string;
}

const DEFAULT_DEVICE_CONFIG: PrinterDeviceConfig = {
    id: 'default',
    active: false,
    name: 'Not Configured',
    connection: 'windows_driver',
    protocol: 'image',
    port: 9100,
    baudRate: 9600,
    dpi: 203
};

const DEFAULT_PRINTER_CONFIG: PrinterConfig = {
    packPrinter: { ...DEFAULT_DEVICE_CONFIG, id: 'pack_default', name: 'Pack Printer' },
    boxPrinter: { ...DEFAULT_DEVICE_CONFIG, id: 'box_default', name: 'Box Printer' },
    palletPrinter: { ...DEFAULT_DEVICE_CONFIG, id: 'pallet_default', name: 'Pallet Printer' },
    autoPrintOnStable: true,
    serverIp: '',
    language: 'ru'
};

export function getPrinterConfigPath(): string {
    return path.join(app.getPath('userData'), PRINTER_CONFIG_FILE);
}

let printerCache: PrinterConfig | null = null;

export function loadPrinterConfig(): PrinterConfig {
    if (printerCache) return structuredClone(printerCache);
    const configPath = getPrinterConfigPath();
    try {
        if (fs.existsSync(configPath)) {
            const data = fs.readFileSync(configPath, 'utf-8');
            const parsed = JSON.parse(data);

            // Migration: wipe out old default 58x40 limits if they match exactly
            // This prevents legacy configs from shrinking dynamic templates
            if (parsed.packPrinter) {
                if (parsed.packPrinter.widthMm === 58 && parsed.packPrinter.heightMm === 40) {
                    delete parsed.packPrinter.widthMm;
                    delete parsed.packPrinter.heightMm;
                }
            }
            if (parsed.boxPrinter) {
                if (parsed.boxPrinter.widthMm === 58 && parsed.boxPrinter.heightMm === 40) {
                    delete parsed.boxPrinter.widthMm;
                    delete parsed.boxPrinter.heightMm;
                }
            }
            if (parsed.palletPrinter) {
                if (parsed.palletPrinter.widthMm === 58 && parsed.palletPrinter.heightMm === 40) {
                    delete parsed.palletPrinter.widthMm;
                    delete parsed.palletPrinter.heightMm;
                }
            }

            const result: PrinterConfig = { ...DEFAULT_PRINTER_CONFIG, ...parsed };
            printerCache = result;
            return structuredClone(result);
        }
    } catch (error) {
        console.error('Failed to load printer config:', error);
    }
    const fallback: PrinterConfig = { ...DEFAULT_PRINTER_CONFIG };
    printerCache = fallback;
    return structuredClone(fallback);
}

export function savePrinterConfig(config: PrinterConfig): void {
    const configPath = getPrinterConfigPath();
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
        printerCache = structuredClone(config);
    } catch (error) {
        console.error('Failed to save printer config:', error);
    }
}
