import type { IConnectionStrategy } from '../types';
import type { PrinterDeviceConfig } from '../../config';
import { SerialPort } from 'serialport';

export class SerialStrategy implements IConnectionStrategy {
    private port: SerialPort | null = null;
    private connected: boolean = false;

    async connect(config: PrinterDeviceConfig): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.port && this.port.isOpen) {
                return resolve();
            }

            if (!config.serialPort) {
                return reject(new Error('Serial port name missing'));
            }

            this.port = new SerialPort({
                path: config.serialPort,
                baudRate: config.baudRate || 9600,
                autoOpen: false
            });

            this.port.open((err) => {
                if (err) {
                    this.connected = false;
                    reject(err);
                } else {
                    this.connected = true;
                    resolve();
                }
            });
        });
    }

    async disconnect(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.port && this.port.isOpen) {
                this.port.close((err) => {
                    this.port = null;
                    this.connected = false;
                    if (err) reject(err);
                    else resolve();
                });
            } else {
                this.connected = false;
                resolve();
            }
        });
    }

    async send(data: Buffer): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.port || !this.port.isOpen) {
                return reject(new Error('Serial port not open'));
            }
            this.port.write(data, (err) => {
                if (err) reject(err);
                else {
                    this.port!.drain((drainErr) => {
                        if (drainErr) reject(drainErr);
                        else resolve();
                    });
                }
            });
        });
    }

    isConnected(): boolean {
        return this.connected && !!this.port && this.port.isOpen;
    }

    async query(data: Buffer, timeoutMs: number, doneWhen?: (accumulated: Buffer) => boolean): Promise<Buffer | null> {
        if (!this.port || !this.port.isOpen) return null;
        const port = this.port;

        return new Promise<Buffer | null>((resolve) => {
            const chunks: Buffer[] = [];
            let settled = false;

            const finish = (result: Buffer | null) => {
                if (settled) return;
                settled = true;
                port.removeListener('data', onData);
                port.removeListener('error', onError);
                clearTimeout(timer);
                resolve(result);
            };

            const onData = (buf: Buffer) => {
                chunks.push(buf);
                if (doneWhen) {
                    const acc = Buffer.concat(chunks);
                    if (doneWhen(acc)) finish(acc);
                }
            };
            const onError = () => finish(null);

            const timer = setTimeout(() => {
                finish(chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0));
            }, timeoutMs);

            port.on('data', onData);
            port.once('error', onError);

            port.write(data, (err) => {
                if (err) return finish(null);
                port.drain((drainErr) => {
                    if (drainErr) finish(null);
                });
            });
        });
    }
}
