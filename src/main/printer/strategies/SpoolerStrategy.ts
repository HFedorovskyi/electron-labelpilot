import type { IConnectionStrategy } from '../types';
import type { PrinterDeviceConfig } from '../../config';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';

export class SpoolerStrategy implements IConnectionStrategy {
    private connected: boolean = false;
    private config: PrinterDeviceConfig | null = null;
    private helperPath: string = '';

    constructor() {
        this.resolveHelperPath();
    }

    private resolveHelperPath() {
        // Handle both dev (relative to cwd) and prod (resourcesPath)
        const possiblePaths = [
            path.join(process.cwd(), 'resources', 'printer', 'RawPrint.exe'),
            path.join(process.resourcesPath, 'printer', 'RawPrint.exe'),
            // Fallback for some dev environments where resources might be copied differently
            path.join(app.getAppPath(), '..', 'resources', 'printer', 'RawPrint.exe')
        ];

        for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
                this.helperPath = p;
                break;
            }
        }

        if (!this.helperPath) {
            console.warn('RawPrint.exe not found in:', possiblePaths);
        } else {
            console.log('SpoolerStrategy using helper:', this.helperPath);
        }
    }

    async connect(config: PrinterDeviceConfig): Promise<void> {
        this.config = config;
        this.connected = true;
        // No real persistent connection for spooler, just validation
        if (!config.driverName) {
            throw new Error('Driver name missing for Windows Spooler printer');
        }
        if (!this.helperPath) {
            throw new Error('RawPrint.exe helper not found. Cannot print to Spooler.');
        }
    }

    async disconnect(): Promise<void> {
        this.connected = false;
    }

    async send(data: Buffer): Promise<void> {
        if (!this.connected || !this.config || !this.config.driverName) {
            throw new Error('Printer not connected or configured');
        }

        // 1. Write data to temp file
        const tempId = Math.random().toString(36).substring(7);
        const tempPath = path.join(os.tmpdir(), `labelpilot_${tempId}.bin`);
        await fs.promises.writeFile(tempPath, data);

        try {
            // 2. Invoke Helper
            await this.invokeHelper(this.config.driverName, tempPath);
        } finally {
            // 3. Cleanup
            fs.unlink(tempPath, (err) => { if (err) console.error('Failed to cleanup temp print file:', err); });
        }
    }

    private invokeHelper(printerName: string, filePath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            console.log(`Spawning: ${this.helperPath} "${printerName}" "${filePath}"`);

            const child = spawn(this.helperPath, [printerName, filePath]);

            let stderr = '';

            child.stderr.on('data', (d) => stderr += d.toString());

            child.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`RawPrint failed with code ${code}: ${stderr}`));
                }
            });

            child.on('error', (err) => {
                reject(err);
            });
        });
    }

    isConnected(): boolean {
        return this.connected; // Virtual connection
    }
}
