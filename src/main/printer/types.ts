import type { PrinterDeviceConfig } from '../config';

export interface IConnectionStrategy {
    connect(config: PrinterDeviceConfig): Promise<void>;
    disconnect(): Promise<void>;
    send(data: Buffer): Promise<void>;
    isConnected(): boolean;
    /**
     * Send a request and read printer response within timeoutMs.
     * Returns null if the strategy has no read channel (e.g. Windows spooler) —
     * callers must treat null as "cannot probe" and fall back accordingly.
     * Returns a Buffer (possibly empty) when the strategy supports reading.
     */
    query?(data: Buffer, timeoutMs: number): Promise<Buffer | null>;
}

export type PrinterStatus = 'connected' | 'disconnected' | 'error';

export interface PrinterState {
    config: PrinterDeviceConfig;
    status: PrinterStatus;
    lastError?: string;
}
