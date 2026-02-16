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
}
