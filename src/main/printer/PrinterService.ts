import log from '../logger';
import path from 'path';
import { Worker } from 'worker_threads';
import { loadPrinterConfig, type PrinterDeviceConfig } from '../config';
import type { IConnectionStrategy, PrinterState } from './types';
import { app, BrowserWindow } from 'electron';
import { TcpStrategy, SerialStrategy, SpoolerStrategy } from './strategies';
import { ZplGenerator, CanvasBitmapGenerator, type LabelDoc, type ILabelGenerator } from './generator';
import { ramCacheCoordinator } from './ramCacheCoordinator';

/**
 * Proxy to the generation worker thread. Generation misses (first print of a template,
 * post-sync re-render, pallet tables, unique GS1 barcodes) burn 30-300ms of CPU on a
 * weak terminal — inside the worker they no longer stall the main loop (live scale
 * stream, IPC, status pushes). Falls back to in-process generation when the worker
 * can't be created or dies (fallback caches start empty — consistent, since a dead
 * worker's caches died with it).
 */
class GeneratorWorkerClient {
    private worker: Worker | null = null;
    private seq = 0;
    private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    private disabled = false;
    // Doc keys the CURRENT worker instance has cached (renderer-content-derived, so a
    // changed template is a new key automatically). Lets repeat prints of a template
    // skip the per-print structured clone of the whole labelDoc into the worker — and
    // because the worker then reuses one object identity, its structural WeakMap cache
    // finally hits too. Cleared whenever the worker dies (its cache died with it).
    private knownDocKeys = new Set<string>();

    knowsDoc(key: string): boolean { return this.worker !== null && this.knownDocKeys.has(key); }
    markDoc(key: string): void { this.knownDocKeys.add(key); }
    forgetDoc(key: string): void { this.knownDocKeys.delete(key); }

    private ensure(): Worker | null {
        if (this.disabled) return null;
        if (this.worker) return this.worker;
        this.knownDocKeys.clear();
        try {
            const isDev = !app.isPackaged;
            const workerPath = path.join(__dirname, 'generator', 'worker.js');
            const w = new Worker(workerPath, {
                workerData: {
                    fontsDir: isDev
                        ? path.join(process.cwd(), 'resources', 'fonts')
                        : path.join(process.resourcesPath, 'fonts'),
                    logsDir: app.getPath('logs'),
                },
            });
            const onGone = (why: string) => (arg: any) => {
                if (this.worker === w) this.worker = null;
                if (why === 'error') {
                    // A runtime error in the worker (e.g. native module failed to load
                    // in the thread) is unlikely to be transient — stop retrying.
                    this.disabled = true;
                    log.error(`PrinterService: generator worker error — falling back to in-process generation: ${arg}`);
                }
                const err = new Error(`generator worker ${why}: ${arg}`);
                err.name = 'WorkerGone';
                for (const p of this.pending.values()) p.reject(err);
                this.pending.clear();
            };
            w.on('error', onGone('error'));
            w.on('exit', onGone('exit'));
            w.on('message', (msg: any) => {
                const p = this.pending.get(msg.id);
                if (!p) return;
                this.pending.delete(msg.id);
                if (msg.ok) p.resolve(msg.result);
                else p.reject(new Error(msg.error));
            });
            this.worker = w;
            log.info(`PrinterService: generation worker started (${workerPath})`);
            return w;
        } catch (e) {
            this.disabled = true;
            log.warn(`PrinterService: generator worker unavailable — using in-process generation: ${e}`);
            return null;
        }
    }

    /** Returns null when the worker is unavailable (caller uses the in-process path). */
    call(payload: Record<string, any>): Promise<any> | null {
        const w = this.ensure();
        if (!w) return null;
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            w.postMessage({ id, ...payload });
        });
    }
}

/** Structured-clone turns Buffer into Uint8Array on receipt — re-wrap without copying. */
function toBuffer(r: any): Buffer {
    if (Buffer.isBuffer(r)) return r;
    return Buffer.from(r.buffer, r.byteOffset, r.byteLength);
}

/**
 * Identity of the PHYSICAL device behind a printer config. Roles (pack/box/pallet)
 * have distinct config ids even when they point at the same printer — anything that
 * must be unique per DEVICE (send ordering, R:-drive wipes) keys on this instead.
 */
export function physicalPrinterKey(config: PrinterDeviceConfig): string {
    switch (config.connection) {
        case 'tcp': return config.ip ? `tcp:${config.ip}:${config.port || 9100}` : `id:${config.id}`;
        case 'serial': return config.serialPort ? `ser:${config.serialPort}` : `id:${config.id}`;
        case 'windows_driver': return config.driverName ? `spl:${config.driverName}` : `id:${config.id}`;
        default: return `id:${config.id || config.name || '__default__'}`;
    }
}

class PrinterService {
    private strategies: Map<string, IConnectionStrategy> = new Map();
    private states: Map<string, PrinterState> = new Map();
    private mainWindow: BrowserWindow | null = null;

    // Singleton generators — the in-process FALLBACK path (worker unavailable/dead).
    private zplGenerator: ILabelGenerator = new ZplGenerator();
    private canvasGenerator: ILabelGenerator = new CanvasBitmapGenerator();
    // Hot path: generation runs in a worker thread so miss-path CPU never stalls main.
    private generatorWorker = new GeneratorWorkerClient();

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
        if (config.palletPrinter) this.initDevice(config.palletPrinter);
        console.log(`[PrinterService] initializeStrategies finished in ${Date.now() - startTime}ms`);
    }

    private initDevice(config: PrinterDeviceConfig) {
        const expectedCtor =
            config.connection === 'tcp' ? TcpStrategy :
            config.connection === 'serial' ? SerialStrategy :
            config.connection === 'windows_driver' ? SpoolerStrategy : null;

        const existing = this.strategies.get(config.id) || null;
        const sameType = !!existing && !!expectedCtor && existing instanceof expectedCtor;

        // Tear down when the connection TYPE changes (e.g. user switched TCP → Serial).
        if (existing && !sameType) {
            existing.disconnect().catch(console.error);
            this.strategies.delete(config.id);
        }

        // Same-type but connection-material params changed (IP/port/persistence, COM/baud):
        // drop the open connection so the next print reconnects with the fresh settings.
        // The 400ms idle-close used to mask this, but a PERSISTENT socket never reconnects
        // on its own — without this, an IP change or turning persistence off would be
        // silently ignored until an app restart or a send error.
        if (existing && sameType && existing.isConnected()) {
            const prev = this.states.get(config.id)?.config;
            const connKey = (c?: PrinterDeviceConfig) => c ? JSON.stringify(
                [c.connection, c.ip, c.port, c.persistentConnection ?? false, c.serialPort, c.baudRate, c.driverName]
            ) : '';
            if (connKey(prev) !== connKey(config)) {
                log.info(`PrinterService: connection params changed for "${config.name}" — dropping open connection to re-apply`);
                existing.disconnect().catch(console.error);
            }
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

            // Simple connectivity test label. NOTE: ZPL commands must have NO space after
            // the caret (`^XA`, not `^ XA`) and no leading indentation, or printers/parsers
            // (e.g. Labelary / Virtual ZPL Printer) reject it with "generated no labels".
            const zpl =
                '^XA\n' +
                '^CI28\n' +
                '^FO40,40^A0N,50,50^FDTest Print^FS\n' +
                `^FO40,110^A0N,28,28^FD${config.name}^FS\n` +
                `^FO40,150^A0N,28,28^FD${config.connection}^FS\n` +
                '^FO40,200^BY2,3,90^BCN,90,Y,N,N^FDTEST123456^FS\n' +
                '^XZ';

            await strategy.send(Buffer.from(zpl, 'utf-8'));

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
    public async warmupConnection(config: PrinterDeviceConfig): Promise<'connected' | 'error' | 'skipped'> {
        const strategy = this.getOrCreateStrategy(config);
        if (!strategy) return 'skipped';
        if (strategy.isConnected()) return 'connected';
        try {
            await strategy.connect(config);
            this.updateDeviceState(config.id, { config, status: 'connected' });
            return 'connected';
        } catch (e) {
            this.updateDeviceState(config.id, { config, status: 'error', lastError: String(e) });
            // Don't throw — warmup is best-effort; first real print will retry.
            log.warn(`PrinterService: warmupConnection failed for ${config.name}: ${e}`);
            return 'error';
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
        // In 'auto' mode the pre-probe default is 'inline', which would silently no-op
        // the whole pre-upload. Warmup is off the print hot path, so resolve the probe
        // first (fast: early-resolves on TCP, scaled timeout on serial).
        const strategy = this.getOrCreateStrategy(config);
        if (strategy && strategy.isConnected()) {
            await ramCacheCoordinator.ensureDecision(config, strategy);
        }
        const cacheMode = ramCacheCoordinator.getDecision(config);
        // Inline path travels the bitmap in every job — pre-upload is meaningless.
        if (cacheMode === 'inline') return;

        const options = {
            dpi: config.dpi || 203,
            darkness: config.darkness,
            printSpeed: config.printSpeed,
            widthMm: config.widthMm,
            heightMm: config.heightMm,
            printerId: config.id,
            cacheMode,
            z64: config.z64,
            physicalKey: physicalPrinterKey(config),
        };

        let dgBuffer: Buffer | null = null;
        const viaWorker = this.generatorWorker.call({ cmd: 'warmup-bg', doc, options });
        if (viaWorker) {
            try {
                const res = await viaWorker;
                dgBuffer = res ? toBuffer(res) : null;
            } catch (e: any) {
                if (e?.name !== 'WorkerGone') throw e;
                const gen = this.canvasGenerator as CanvasBitmapGenerator;
                dgBuffer = await gen.generateBackgroundUpload(doc, options);
            }
        } else {
            const gen = this.canvasGenerator as CanvasBitmapGenerator;
            dgBuffer = await gen.generateBackgroundUpload(doc, options);
        }
        if (!dgBuffer || dgBuffer.length === 0) return; // Already cached on this printer.
        await this.sendBuffer(config, dgBuffer);
    }

    /**
     * Generate the printer byte stream for a label. CPU-only — does not touch the printer.
     * Safe to run in parallel with sendBuffer for the previous label (pipelining).
     */
    public async generateBuffer(config: PrinterDeviceConfig, doc: LabelDoc, data: any, docKey?: string): Promise<Buffer> {
        // For the canvas-bitmap path, ask the coordinator whether this printer
        // supports the RAM-drive flow. Unknown printers start on 'inline' (safe);
        // a probe runs after the first print to upgrade to 'ram' if possible.
        const cacheMode = config.protocol === 'image' ? ramCacheCoordinator.getDecision(config) : undefined;
        const options = {
            dpi: config.dpi || 203,
            darkness: config.darkness,
            printSpeed: config.printSpeed,
            widthMm: config.widthMm,
            heightMm: config.heightMm,
            // Per-printer BG cache scoping: ensures a hash uploaded to printer A
            // isn't assumed present on printer B.
            printerId: config.id,
            cacheMode,
            z64: config.z64,
            physicalKey: physicalPrinterKey(config),
        };

        // With a docKey, ship the doc to the worker only once — repeats send the key
        // alone (no per-print structured clone) and the worker reuses one doc object.
        const attempt = (includeDoc: boolean) => this.generatorWorker.call({
            cmd: 'generate', protocol: config.protocol,
            doc: includeDoc ? doc : undefined, docKey,
            data, options,
        });

        let includeDoc = !docKey || !this.generatorWorker.knowsDoc(docKey);
        let viaWorker = attempt(includeDoc);
        if (viaWorker && docKey && includeDoc) this.generatorWorker.markDoc(docKey);
        if (viaWorker) {
            try {
                return toBuffer(await viaWorker);
            } catch (e: any) {
                if (e?.message === 'DOC_MISSING' && !includeDoc && docKey) {
                    // The worker's LRU evicted this doc — resend it once.
                    this.generatorWorker.forgetDoc(docKey);
                    includeDoc = true;
                    viaWorker = attempt(true);
                    if (viaWorker) {
                        this.generatorWorker.markDoc(docKey);
                        try {
                            return toBuffer(await viaWorker);
                        } catch (e2: any) {
                            if (e2?.name !== 'WorkerGone') throw e2;
                            log.warn(`PrinterService: worker died mid-generate — in-process fallback for this label`);
                        }
                    }
                } else if (e?.name !== 'WorkerGone') {
                    // A generation error (bad template/data) would fail identically
                    // in-process and must surface; only worker-infra failures fall back.
                    throw e;
                } else {
                    log.warn(`PrinterService: worker died mid-generate — in-process fallback for this label`);
                }
            }
        }

        const generator = config.protocol === 'image' ? this.canvasGenerator : this.zplGenerator;
        return generator.generate(doc, data, options);
    }

    /**
     * Clear generator background caches — in the worker (hot path) AND the in-process
     * fallback singletons. No printerId → everything (after data sync); with printerId →
     * that printer's RAM upload tracking only (after reconnect).
     */
    public clearGeneratorCaches(printerId?: string): void {
        CanvasBitmapGenerator.clearBackgroundCache(printerId);
        const p = this.generatorWorker.call({ cmd: 'clear-bg-cache', printerId });
        if (p) p.catch(() => { /* worker down → its caches are already gone */ });
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
    // Fail-fast circuit breaker: after a connect/send failure, further sends to that
    // printer fail instantly for a short window instead of each queued label paying the
    // full connect timeout (3s TCP) serially while the device is clearly down.
    private static readonly BREAKER_MS = 5000;
    private breakerTrippedAt: Map<string, number> = new Map();

    public async sendBuffer(config: PrinterDeviceConfig, buffer: Buffer): Promise<void> {
        const strategy = this.getOrCreateStrategy(config);
        if (!strategy) throw new Error(`PrinterService: invalid connection type "${config.connection}"`);

        const trippedAt = this.breakerTrippedAt.get(config.id);
        if (trippedAt && Date.now() - trippedAt < PrinterService.BREAKER_MS) {
            throw new Error(`Printer "${config.name}" unreachable (failing fast for ${PrinterService.BREAKER_MS / 1000}s after recent error)`);
        }

        try {
            if (!strategy.isConnected()) {
                await strategy.connect(config);
                this.updateDeviceState(config.id, { config, status: 'connected' });
            }
            await strategy.send(buffer);
            this.breakerTrippedAt.delete(config.id);
        } catch (err) {
            // Retry only errors a reconnect can plausibly fix: stale/idle TCP sockets closed
            // by the printer/NAT, serial ports that lost their handle (ECONNRESET/EPIPE class).
            // Do NOT retry: spooler failures (connect() is virtual — the failure is
            // deterministic and each attempt costs the full 20s helper timeout) and
            // timeouts (the device is down/busy; a second identical wait doubles the stall).
            const msg = String((err as any)?.message || err);
            const isTimeout = /timed? ?out/i.test(msg);
            const isSpooler = config.connection === 'windows_driver';
            if (isSpooler || isTimeout) {
                this.breakerTrippedAt.set(config.id, Date.now());
                this.updateDeviceState(config.id, { config, status: 'error', lastError: msg });
                try { await strategy.disconnect(); } catch { /* ignore */ }
                // The label may have been generated with its BG marked "uploaded" while
                // the printer was off (RAM drive wiped). Without clearing the tracking
                // here, every later label recalls a graphic that no longer exists —
                // the whole static layer silently vanishes until a sync. Same clearing
                // the retry path below does.
                this.clearGeneratorCaches(config.id);
                ramCacheCoordinator.invalidate(config.id);
                throw err;
            }

            log.warn(`PrinterService: send failed, attempting reconnect + retry — ${err}`);
            try { await strategy.disconnect(); } catch { /* ignore */ }
            // Printer may have rebooted → its RAM-stored ~DG graphics are gone. Clear the
            // upload tracking so the next label re-uploads (inline JS cache is untouched).
            this.clearGeneratorCaches(config.id);
            // Its RAM-cache support decision could also be stale. Re-probe.
            ramCacheCoordinator.invalidate(config.id);
            try {
                await strategy.connect(config);
                await strategy.send(buffer);
                this.updateDeviceState(config.id, { config, status: 'connected' });
            } catch (err2) {
                this.breakerTrippedAt.set(config.id, Date.now());
                this.updateDeviceState(config.id, { config, status: 'error', lastError: String(err2) });
                try { await strategy.disconnect(); } catch { /* ignore */ }
                throw err2;
            }
        }

        // After a successful canvas-bitmap send, kick off a one-shot probe to learn
        // whether this printer supports ~DG/R:/^XG. Fire-and-forget — never blocks the
        // hot path. The decision is honored by the NEXT generateBuffer() call.
        // (This used to live in printLabel(), which nothing called — the probe never ran
        // and every 'auto' printer was permanently stuck on the slow inline path.)
        if (config.protocol === 'image') {
            ramCacheCoordinator.maybeProbe(config, strategy);
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
