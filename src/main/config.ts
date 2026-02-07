import { app } from 'electron';
import path from 'path';
import fs from 'fs';

const CONFIG_FILE = 'scale-config.json';

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
