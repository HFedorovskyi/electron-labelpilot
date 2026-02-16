import type { PrinterDeviceConfig } from '../config';

export interface IConnectionStrategy {
    connect(config: PrinterDeviceConfig): Promise<void>;
    disconnect(): Promise<void>;
    send(data: Buffer): Promise<void>;
    isConnected(): boolean;
}

export type PrinterStatus = 'connected' | 'disconnected' | 'error';

export interface PrinterState {
    config: PrinterDeviceConfig;
    status: PrinterStatus;
    lastError?: string;
}
