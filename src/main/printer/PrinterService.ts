import log from '../logger';
import { loadPrinterConfig, type PrinterDeviceConfig } from '../config';
import type { IConnectionStrategy, PrinterState } from './types';
import { BrowserWindow } from 'electron';
import { TcpStrategy, SerialStrategy, SpoolerStrategy } from './strategies';
import { ZplGenerator, CanvasBitmapGenerator, type LabelDoc, type ILabelGenerator } from './generator';
import { ramCacheCoordinator } from './ramCacheCoordinator';

class PrinterService {
    private strategies: Map<string, IConnectionStrategy> = new Map();
    private states: Map<string, PrinterState> = new Map();
    private mainWindow: BrowserWindow | null = null;

    // Singleton generators — avoids re-creating per print (and keeps any per-instance caches alive).
    private zplGenerator: ILabelGenerator = new ZplGenerator();
    private canvasGenerator: ILabelGenerator = new CanvasBitmapGenerator();

    constructor() {
        // Defer initialization to ensure app is ready if needed, 
        // or just init here.
        setTimeout(() => this.initializeStrategies(), 1000);
    }

    public setMainWindow(window: BrowserWindow) {
        this.mainWindow = window;
    }

    public reloadConfig() {
        this.initializeStrategies();
    }

    private initializeStrategies() {
        const startTime = Date.now();
        console.log('[PrinterService] initializeStrategies started');
        const config = loadPrinterConfig();

        this.initDevice(config.packPrinter);
        this.initDevice(config.boxPrinter);
        console.log(`[PrinterService] initializeStrategies finished in ${Date.now() - startTime}ms`);
    }

    private initDevice(config: PrinterDeviceConfig) {
        const expectedCtor =
            config.connection === 'tcp' ? TcpStrategy :
            config.connection === 'serial' ? SerialStrategy :
            config.connection === 'windows_driver' ? SpoolerStrategy : null;

        const existing = this.strategies.get(config.id) || null;
        const sameType = !!existing && !!expectedCtor && existing instanceof expectedCtor;

        // Tear down only when the connection TYPE changes (e.g. user switched TCP → Serial).
        // Same-type changes (IP/port/baud) will be picked up by the next connect(),
        // and any stale open socket will be replaced by the retry-on-error in sendBuffer.
        if (existing && !sameType) {
            existing.disconnect().catch(console.error);
            this.strategies.delete(config.id);
        }

        if (!sameType && expectedCtor) {
            this.strategies.set(config.id, new expectedCtor());
        }

        const status = sameType && existing!.isConnected() ? 'connected' : 'disconnected';
        this.updateDeviceState(config.id, { config, status });
    }

    private updateDeviceState(id: string, state: PrinterState) {
        this.states.set(id, state);
        if (this.mainWindow) {
            this.mainWindow.webContents.send('printer-status-update', { id, status: state.status });
        }
    }

    public async print(printerId: string, data: Buffer): Promise<void> {
        const strategy = this.strategies.get(printerId);
        const state = this.states.get(printerId);

        if (!strategy || !state) {
            throw new Error(`Printer ${printerId} not found or not configured`);
        }

        try {
            if (!strategy.isConnected()) {
                console.log(`Connecting to ${state.config.name} (${state.config.connection})...`);
                await strategy.connect(state.config);
                this.updateDeviceState(printerId, { ...state, status: 'connected' });
            }

            console.log(`Sending ${data.length} bytes to ${state.config.name}...`);
            await strategy.send(data);
            console.log('Print success');

        } catch (error) {
            console.error(`Print failed for ${printerId}: `, error);
            this.updateDeviceState(printerId, { ...state, status: 'error', lastError: String(error) });
            // Try to disconnect to reset state
            try { await strategy.disconnect(); } catch (e) { /* ignore */ }
            throw error;
        }
    }
    public async testPrint(config: PrinterDeviceConfig): Promise<void> {
        let strategy: IConnectionStrategy | null = null;

        switch (config.connection) {
            case 'tcp': strategy = new TcpStrategy(); break;
            case 'serial': strategy = new SerialStrategy(); break;
            case 'windows_driver': strategy = new SpoolerStrategy(); break;
        }

        if (!strategy) throw new Error('Invalid connection type');

        try {
            await strategy.connect(config);

            // Generate Test ZPL
            // Simple ZPL for now, just to test connection
            const zpl = `
    ^ XA
    ^ FO50, 50 ^ A0N, 50, 50 ^ FDTest Print ^ FS
        ^ FO50, 120 ^ A0N, 30, 30 ^ FD${config.name}^ FS
            ^ FO50, 160 ^ A0N, 30, 30 ^ FD${config.connection}^ FS
                ^ FO50, 220 ^ BY3, 3, 100 ^ BCN, 100, Y, N, N ^ FDTEST123456 ^ FS
                ^ XZ`;

            await strategy.send(Buffer.from(zpl));

        } finally {
            try {
                await strategy.disconnect();
            } catch (e) {
                console.error('Error disconnecting test strategy', e);
            }
        }
    }

    /**
     * Eagerly open the connection to a printer. Call when entering a station so the first
     * label doesn't pay the handshake. No-op if connection is already open or the protocol
     * is connectionless (Windows spooler).
     */
    public async warmupConnection(config: PrinterDeviceConfig): Promise<void> {
        const strategy = this.getOrCreateStrategy(config);
        if (!strategy) return;
        if (strategy.isConnected()) return;
        try {
            await strategy.connect(config);
            this.updateDeviceState(config.id, { config, status: 'connected' });
        } catch (e) {
            this.updateDeviceState(config.id, { config, status: 'error', lastError: String(e) });
            // Don't throw — warmup is best-effort; first real print will retry.
            log.warn(`PrinterService: warmupConnection failed for ${config.name}: ${e}`);
        }
    }

    /**
     * Pre-upload the static background for a label template (~DG command only).
     * Does NOT include ^XA…^XZ — the printer just stores the bitmap, no label is printed.
     * The next real print of this template will hit the BG cache.
     *
     * Only meaningful for the 'image' (canvas-bitmap) protocol; no-op otherwise.
     */
    public async warmupBackground(config: PrinterDeviceConfig, doc: LabelDoc): Promise<void> {
        if (config.protocol !== 'image') return; // ZPL/TSPL/browser don't use ~DG caching
        const cacheMode = ramCacheCoordinator.getDecision(config);
        // Inline path travels the bitmap in every job — pre-upload is meaningless.
        if (cacheMode === 'inline') return;

        const gen = this.canvasGenerator as CanvasBitmapGenerator;
        const dgBuffer = await gen.generateBackgroundUpload(doc, {
            dpi: config.dpi || 203,
            darkness: config.darkness,
            printSpeed: config.printSpeed,
            widthMm: config.widthMm,
            heightMm: config.heightMm,
            printerId: config.id,
            cacheMode,
        });
        if (!dgBuffer || dgBuffer.length === 0) return; // Already cached on this printer.
        await this.sendBuffer(config, dgBuffer);
    }

    /**
     * Generate the printer byte stream for a label. CPU-only — does not touch the printer.
     * Safe to run in parallel with sendBuffer for the previous label (pipelining).
     */
    public async generateBuffer(config: PrinterDeviceConfig, doc: LabelDoc, data: any): Promise<Buffer> {
        const generator = config.protocol === 'image' ? this.canvasGenerator : this.zplGenerator;
        // For the canvas-bitmap path, ask the coordinator whether this printer
        // supports the RAM-drive flow. Unknown printers start on 'inline' (safe);
        // a probe runs after the first print to upgrade to 'ram' if possible.
        const cacheMode = config.protocol === 'image' ? ramCacheCoordinator.getDecision(config) : undefined;
        return generator.generate(doc, data, {
            dpi: config.dpi || 203,
            darkness: config.darkness,
            printSpeed: config.printSpeed,
            widthMm: config.widthMm,
            heightMm: config.heightMm,
            // Per-printer BG cache scoping: ensures a hash uploaded to printer A
            // isn't assumed present on printer B.
            printerId: config.id,
            cacheMode,
        });
    }

    /**
     * Send a prepared buffer to the printer over a persistent strategy.
     * Reuses an existing open connection if available; on send error, reconnects once and retries.
     *
     * On reconnect, invalidates this printer's BG cache: a TCP/Serial failure often means
     * the printer was power-cycled and its RAM-stored ~DG graphics are gone. Clearing the
     * cache forces the NEXT generated label to include a fresh ~DG, so the printer
     * self-heals after one possibly-incomplete label.
     */
    public async sendBuffer(config: PrinterDeviceConfig, buffer: Buffer): Promise<void> {
        const strategy = this.getOrCreateStrategy(config);
        if (!strategy) throw new Error(`PrinterService: invalid connection type "${config.connection}"`);

        try {
            if (!strategy.isConnected()) {
                await strategy.connect(config);
                this.updateDeviceState(config.id, { config, status: 'connected' });
            }
            await strategy.send(buffer);
        } catch (err) {
            // One reconnect-and-retry. Covers idle TCP sockets closed by the printer/NAT
            // and serial ports that lost their handle. Also: assume the printer may have
            // rebooted → invalidate its BG cache so subsequent labels re-upload.
            log.warn(`PrinterService: send failed, attempting reconnect + retry — ${err}`);
            try { await strategy.disconnect(); } catch { /* ignore */ }
            CanvasBitmapGenerator.clearBackgroundCache(config.id);
            // Printer may have rebooted — its RAM-cache support decision could
            // also be stale (different firmware/profile reloaded). Re-probe.
            ramCacheCoordinator.invalidate(config.id);
            try {
                await strategy.connect(config);
                await strategy.send(buffer);
                this.updateDeviceState(config.id, { config, status: 'connected' });
            } catch (err2) {
                this.updateDeviceState(config.id, { config, status: 'error', lastError: String(err2) });
                try { await strategy.disconnect(); } catch { /* ignore */ }
                throw err2;
            }
        }
    }

    public async printLabel(config: PrinterDeviceConfig, doc: LabelDoc, data: any): Promise<void> {
        const startTotal = performance.now();
        const startGen = performance.now();
        const buffer = await this.generateBuffer(config, doc, data);
        const genTime = performance.now() - startGen;

        const startSend = performance.now();
        await this.sendBuffer(config, buffer);
        const sendTime = performance.now() - startSend;
        const totalTime = performance.now() - startTotal;
        log.info(`PrinterService: ${config.name} gen=${genTime.toFixed(1)}ms send=${sendTime.toFixed(1)}ms total=${totalTime.toFixed(1)}ms buf=${buffer.length}B`);

        // After a successful canvas-bitmap print, kick off a one-shot probe to learn
        // whether this printer supports ~DG/R:/^XG. Fire-and-forget — never blocks the
        // hot path. The decision is honored by the NEXT call to generateBuffer().
        if (config.protocol === 'image') {
            const strategy = this.strategies.get(config.id);
            if (strategy) ramCacheCoordinator.maybeProbe(config, strategy);
        }
    }

    /**
     * Returns the cached strategy for this config.id, or creates and caches a new one.
     * If the cached strategy was for a different connection type, replaces it.
     */
    private getOrCreateStrategy(config: PrinterDeviceConfig): IConnectionStrategy | null {
        let strategy = this.strategies.get(config.id) || null;

        const expectedCtor =
            config.connection === 'tcp' ? TcpStrategy :
            config.connection === 'serial' ? SerialStrategy :
            config.connection === 'windows_driver' ? SpoolerStrategy : null;

        if (!expectedCtor) return null;

        // If we have a strategy but it's the wrong type (config changed), replace it.
        if (strategy && !(strategy instanceof expectedCtor)) {
            try { void strategy.disconnect(); } catch { /* ignore */ }
            strategy = null;
        }

        if (!strategy) {
            strategy = new expectedCtor();
            this.strategies.set(config.id, strategy);
            this.updateDeviceState(config.id, { config, status: 'disconnected' });
        }

        return strategy;
    }
}

export const printerService = new PrinterService();
