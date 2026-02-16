import type { IConnectionStrategy } from '../types';
import type { PrinterDeviceConfig } from '../../config';
import * as net from 'net';

export class TcpStrategy implements IConnectionStrategy {
    private socket: net.Socket | null = null;
    private connected: boolean = false;
    // private config: PrinterDeviceConfig | null = null;

    async connect(config: PrinterDeviceConfig): Promise<void> {
        // this.config = config;
        return new Promise((resolve, reject) => {
            if (this.socket) {
                this.disconnect();
            }

            if (!config.ip) {
                return reject(new Error('IP address missing for TCP printer'));
            }

            const socket = new net.Socket();
            socket.setTimeout(3000); // 3s connection timeout

            socket.once('connect', () => {
                this.socket = socket;
                this.connected = true;
                // Remove timeout listener/setup for long-lived connection if needed
                socket.setTimeout(0);
                resolve();
            });

            socket.once('error', (err) => {
                this.connected = false;
                reject(err);
            });

            socket.once('timeout', () => {
                socket.destroy();
                this.connected = false;
                reject(new Error('Connection timed out'));
            });

            socket.connect(config.port || 9100, config.ip);
        });
    }

    async disconnect(): Promise<void> {
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        this.connected = false;
    }

    async send(data: Buffer): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.socket || !this.connected) {
                // Auto-reconnect attempt could go here, but let's fail fast for now
                return reject(new Error('Printer not connected'));
            }

            this.socket.write(data, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    isConnected(): boolean {
        // We might want to check if socket is actually writable
        return this.connected && !!this.socket && !this.socket.destroyed;
    }
}
