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

export interface PrinterConfig {
    packPrinter: string;   // printer name for pack/unit labels
    boxPrinter: string;    // printer name for box labels
    autoPrintOnStable: boolean; // auto-print when weight stabilizes
    serverIp: string;      // Manual server IP override
}

const DEFAULT_PRINTER_CONFIG: PrinterConfig = {
    packPrinter: '',
    boxPrinter: '',
    autoPrintOnStable: false,
    serverIp: ''
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
