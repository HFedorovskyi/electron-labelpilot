import type { IConnectionStrategy } from '../types';
import type { PrinterDeviceConfig } from '../../config';
import * as net from 'net';

export class TcpStrategy implements IConnectionStrategy {
    private socket: net.Socket | null = null;
    private connected: boolean = false;
    private idleTimer: NodeJS.Timeout | null = null;
    private persistent: boolean = false;
    // Close the socket shortly after the last write. Many ZPL-over-TCP receivers finalize a
    // print job on connection close (e.g. Virtual ZPL Printer / Labelary-based tools) rather
    // than on ^XZ — a persistent socket would buffer forever and never render. Real printers
    // render on ^XZ and are unaffected. During a burst (pipelined batch) consecutive writes
    // reset the timer, so the socket is reused; it closes only once printing goes idle.
    // With config.persistentConnection the idle-close is skipped entirely (keepalive holds
    // the socket) — at operator pace this saves the reconnect handshake on every label.
    private static readonly IDLE_CLOSE_MS = 400;

    private clearIdleClose() {
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    }

    private scheduleIdleClose() {
        this.clearIdleClose();
        if (this.persistent) return;
        this.idleTimer = setTimeout(() => {
            this.idleTimer = null;
            this.disconnect().catch(() => { /* best-effort */ });
        }, TcpStrategy.IDLE_CLOSE_MS);
    }

    async connect(config: PrinterDeviceConfig): Promise<void> {
        this.clearIdleClose();
        this.persistent = !!config.persistentConnection;
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
                // Disable Nagle: label jobs are latency-sensitive one-shot writes, and the
                // final sub-MSS segment would otherwise wait on the printer's delayed ACK
                // (embedded print servers commonly delay 100-200ms) before ^XZ arrives.
                socket.setNoDelay(true);
                if (this.persistent) {
                    socket.setKeepAlive(true, 30_000);
                }
                // Reflect remote closes (printer reboot, NAT drop) in isConnected() so the
                // next send reconnects up-front instead of failing into the retry path.
                socket.once('close', () => {
                    if (this.socket === socket) this.connected = false;
                });
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
        this.clearIdleClose();
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        this.connected = false;
    }

    async send(data: Buffer): Promise<void> {
        this.clearIdleClose();
        return new Promise((resolve, reject) => {
            if (!this.socket || !this.connected) {
                // Auto-reconnect attempt could go here, but let's fail fast for now
                return reject(new Error('Printer not connected'));
            }

            this.socket.write(data, (err) => {
                if (err) reject(err);
                else { this.scheduleIdleClose(); resolve(); }
            });
        });
    }

    isConnected(): boolean {
        // We might want to check if socket is actually writable
        return this.connected && !!this.socket && !this.socket.destroyed;
    }

    async query(data: Buffer, timeoutMs: number, doneWhen?: (accumulated: Buffer) => boolean): Promise<Buffer | null> {
        if (!this.socket || !this.connected) return null;
        const socket = this.socket;
        this.clearIdleClose(); // keep the socket open to read the reply

        return new Promise<Buffer | null>((resolve) => {
            const chunks: Buffer[] = [];
            let settled = false;

            const finish = (result: Buffer | null) => {
                if (settled) return;
                settled = true;
                socket.removeListener('data', onData);
                socket.removeListener('error', onError);
                clearTimeout(timer);
                this.scheduleIdleClose();
                resolve(result);
            };

            const onData = (buf: Buffer) => {
                chunks.push(buf);
                // Without a matcher, don't resolve eagerly — let the timeout collect the
                // full reply (printers may send the response in multiple packets). With a
                // matcher, resolve as soon as the caller has what it needs.
                if (doneWhen) {
                    const acc = Buffer.concat(chunks);
                    if (doneWhen(acc)) finish(acc);
                }
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
