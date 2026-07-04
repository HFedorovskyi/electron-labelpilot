import type { IConnectionStrategy } from '../types';
import type { PrinterDeviceConfig } from '../../config';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';

export class SpoolerStrategy implements IConnectionStrategy {
    private connected: boolean = false;
    private config: PrinterDeviceConfig | null = null;
    private helperPath: string = '';

    // ── Resident helper (shared across all spooler printers) ────────────
    // One `RawPrint.exe --server` process serves every spooler printer: the printer
    // name travels per command. This removes the per-label CreateProcess + CLR init +
    // Defender scan (100-400ms on a weak terminal) and the temp-file roundtrip that
    // used to dominate windows_driver latency. Protocol:
    //   stdin : "PRINT\t<printerName>\t<byteCount>\n" + <byteCount raw bytes>
    //   stdout: "OK\n" | "ERR <message>\n"   (strictly in command order)
    private static server: ChildProcess | null = null;
    private static serverBuf: string = '';
    private static pending: Array<{ resolve: (line: string) => void; reject: (e: Error) => void }> = [];
    // Serializes stdin writes so two printers can't interleave header/payload framing.
    private static chain: Promise<unknown> = Promise.resolve();

    private static readonly JOB_TIMEOUT_MS = 20000;

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
        const printerName = this.config.driverName;

        try {
            const reply = await this.sendResident(printerName, data);
            if (reply === 'OK') return;
            // "ERR ..." is a real winspool-level failure — the legacy path would fail
            // identically, so surface it (sendBuffer's breaker handles the rest).
            throw new SpoolerJobError(this.describeError(printerName, reply));
        } catch (err) {
            if (err instanceof SpoolerJobError) throw err;
            // Transport-level trouble (helper missing --server support after a partial
            // update, spawn failure, crash, timeout) → one legacy temp-file attempt.
            console.warn('[SpoolerStrategy] resident helper failed, falling back to per-job spawn:', err);
            await this.sendLegacy(printerName, data);
        }
    }

    private describeError(printerName: string, reply: string): string {
        return `Spooler print failed on "${printerName}" (${reply}). ` +
            `If this is a document/PDF driver (e.g. Microsoft Print to PDF), use the "browser" protocol — ` +
            `raw ZPL only works on ZPL/thermal printers.`;
    }

    // ── Resident-mode implementation ─────────────────────────────────────

    private ensureServer(): ChildProcess {
        const existing = SpoolerStrategy.server;
        if (existing && existing.exitCode === null && !existing.killed) return existing;

        const child = spawn(this.helperPath, ['--server'], { windowsHide: true });
        SpoolerStrategy.server = child;
        SpoolerStrategy.serverBuf = '';

        child.stdout!.on('data', (d: Buffer) => {
            SpoolerStrategy.serverBuf += d.toString('utf-8');
            let idx: number;
            while ((idx = SpoolerStrategy.serverBuf.indexOf('\n')) >= 0) {
                const line = SpoolerStrategy.serverBuf.slice(0, idx).replace(/\r$/, '');
                SpoolerStrategy.serverBuf = SpoolerStrategy.serverBuf.slice(idx + 1);
                const waiter = SpoolerStrategy.pending.shift();
                if (waiter) waiter.resolve(line);
            }
        });
        child.stderr!.on('data', (d: Buffer) => {
            console.warn('[RawPrint --server]', d.toString().trim());
        });
        const onGone = () => {
            // A killed child's 'close' fires LATE — by then a fresh server may already
            // be running with new waiters in the shared FIFO. Rejecting those would
            // double-print: send() falls back to the legacy spawn while the new resident
            // server also executes the job. Only the CURRENT server's death may flush
            // the queue; a stale child's waiter was already settled by its timeout.
            if (SpoolerStrategy.server !== child) return;
            SpoolerStrategy.server = null;
            const waiters = SpoolerStrategy.pending.splice(0);
            for (const w of waiters) w.reject(new Error('RawPrint server exited'));
        };
        child.on('close', onGone);
        child.on('error', onGone);
        return child;
    }

    private sendResident(printerName: string, data: Buffer): Promise<string> {
        const run = SpoolerStrategy.chain.then(() => new Promise<string>((resolve, reject) => {
            let child: ChildProcess;
            try {
                child = this.ensureServer();
            } catch (e) {
                return reject(e instanceof Error ? e : new Error(String(e)));
            }

            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                // The helper is stuck inside the spooler (classic stuck-GDI-driver case) —
                // kill it; the waiter queue is rejected via the 'close' handler, and the
                // next job spawns a fresh server.
                try { child.kill(); } catch { /* ignore */ }
                reject(new Error(`Print timed out after ${SpoolerStrategy.JOB_TIMEOUT_MS}ms on "${printerName}".`));
            }, SpoolerStrategy.JOB_TIMEOUT_MS);

            SpoolerStrategy.pending.push({
                resolve: (line) => { if (!settled) { settled = true; clearTimeout(timer); resolve(line); } },
                reject: (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } },
            });

            try {
                child.stdin!.write(`PRINT\t${printerName}\t${data.length}\n`);
                child.stdin!.write(data);
            } catch (e) {
                // Write failure → the 'close' handler will reject our waiter.
                console.warn('[SpoolerStrategy] stdin write failed:', e);
            }
        }));
        // Keep the chain alive regardless of individual job outcomes.
        SpoolerStrategy.chain = run.catch(() => undefined);
        return run;
    }

    // ── Legacy per-job fallback (temp file + one-shot spawn) ─────────────

    private async sendLegacy(printerName: string, data: Buffer): Promise<void> {
        const tempId = Math.random().toString(36).substring(7);
        const tempPath = path.join(os.tmpdir(), `labelpilot_${tempId}.bin`);
        await fs.promises.writeFile(tempPath, data);
        try {
            await this.invokeHelper(printerName, tempPath);
        } finally {
            fs.unlink(tempPath, (err) => { if (err) console.error('Failed to cleanup temp print file:', err); });
        }
    }

    private invokeHelper(printerName: string, filePath: string, timeoutMs = SpoolerStrategy.JOB_TIMEOUT_MS): Promise<void> {
        return new Promise((resolve, reject) => {
            console.log(`Spawning: ${this.helperPath} "${printerName}" "${filePath}"`);

            const child = spawn(this.helperPath, [printerName, filePath]);

            let stderr = '';
            let settled = false;
            const finish = (fn: () => void) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                fn();
            };

            // Hard timeout so a stuck spooler job never hangs the UI forever. This happens
            // with document/GDI drivers (e.g. "Microsoft Print to PDF") that can't render raw
            // ZPL and pop a hidden "Save As" dialog — RawPrint then never returns.
            const timer = setTimeout(() => {
                finish(() => {
                    try { child.kill(); } catch { /* ignore */ }
                    reject(new Error(
                        `Print timed out after ${timeoutMs}ms on "${printerName}". ` +
                        `If this is a document/PDF driver (e.g. Microsoft Print to PDF), use the "browser" protocol — ` +
                        `raw ZPL only works on ZPL/thermal printers.`
                    ));
                });
            }, timeoutMs);

            child.stderr.on('data', (d) => stderr += d.toString());
            child.on('close', (code) => finish(() => {
                if (code === 0) resolve();
                else reject(new Error(`RawPrint failed with code ${code}: ${stderr}`));
            }));
            child.on('error', (err) => finish(() => reject(err)));
        });
    }

    isConnected(): boolean {
        return this.connected; // Virtual connection
    }
}

/** A winspool-level job failure — legacy retry would fail identically, so don't. */
class SpoolerJobError extends Error { }
