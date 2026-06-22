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

    async query(data: Buffer, timeoutMs: number): Promise<Buffer | null> {
        if (!this.socket || !this.connected) return null;
        const socket = this.socket;

        return new Promise<Buffer | null>((resolve) => {
            const chunks: Buffer[] = [];
            let settled = false;

            const finish = (result: Buffer | null) => {
                if (settled) return;
                settled = true;
                socket.removeListener('data', onData);
                socket.removeListener('error', onError);
                clearTimeout(timer);
                resolve(result);
            };

            const onData = (buf: Buffer) => {
                chunks.push(buf);
                // Don't resolve eagerly — let the timeout collect the full reply.
                // Printers may send the response in multiple packets.
            };
            const onError = () => finish(null);

            const timer = setTimeout(() => {
                finish(chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0));
            }, timeoutMs);

            socket.on('data', onData);
            socket.once('error', onError);

            socket.write(data, (err) => {
                if (err) finish(null);
            });
        });
    }
}
