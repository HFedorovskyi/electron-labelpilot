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
    pollingInterval: 500,
    stabilityCount: 5
};

export function getConfigPath(): string {
    return path.join(app.getPath('userData'), CONFIG_FILE);
}

export function loadScaleConfig(): ScaleConfig {
    const configPath = getConfigPath();
    try {
        if (fs.existsSync(configPath)) {
            const data = fs.readFileSync(configPath, 'utf-8');
            return { ...DEFAULT_CONFIG, ...JSON.parse(data) };
        }
    } catch (error) {
        console.error('Failed to load scale config:', error);
    }
    return DEFAULT_CONFIG;
}

export function saveScaleConfig(config: ScaleConfig): void {
    const configPath = getConfigPath();
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
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

export function loadNumberingConfig(): NumberingConfig {
    const configPath = getNumberingConfigPath();
    try {
        if (fs.existsSync(configPath)) {
            const data = fs.readFileSync(configPath, 'utf-8');
            return { ...DEFAULT_NUMBERING_CONFIG, ...JSON.parse(data) };
        }
    } catch (error) {
        console.error('Failed to load numbering config:', error);
    }
    return DEFAULT_NUMBERING_CONFIG;
}

export function saveNumberingConfig(config: NumberingConfig): void {
    const configPath = getNumberingConfigPath();
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    } catch (error) {
        console.error('Failed to save numbering config:', error);
    }
}

// --- Printer Configuration ---

export type ConnectionType = 'tcp' | 'serial' | 'windows_driver';
export type PrinterProtocol = 'zpl' | 'tspl' | 'image' | 'browser';

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
}

export interface PrinterConfig {
    // Specialized Printer Roles
    packPrinter: PrinterDeviceConfig;
    boxPrinter: PrinterDeviceConfig;

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
    dpi: 203,
    widthMm: 58,
    heightMm: 40
};

const DEFAULT_PRINTER_CONFIG: PrinterConfig = {
    packPrinter: { ...DEFAULT_DEVICE_CONFIG, id: 'pack_default', name: 'Pack Printer' },
    boxPrinter: { ...DEFAULT_DEVICE_CONFIG, id: 'box_default', name: 'Box Printer' },
    autoPrintOnStable: false,
    serverIp: '',
    language: 'ru'
};

export function getPrinterConfigPath(): string {
    return path.join(app.getPath('userData'), PRINTER_CONFIG_FILE);
}

export function loadPrinterConfig(): PrinterConfig {
    const configPath = getPrinterConfigPath();
    try {
        if (fs.existsSync(configPath)) {
            const data = fs.readFileSync(configPath, 'utf-8');
            return { ...DEFAULT_PRINTER_CONFIG, ...JSON.parse(data) };
        }
    } catch (error) {
        console.error('Failed to load printer config:', error);
    }
    return DEFAULT_PRINTER_CONFIG;
}

export function savePrinterConfig(config: PrinterConfig): void {
    const configPath = getPrinterConfigPath();
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    } catch (error) {
        console.error('Failed to save printer config:', error);
    }
}
