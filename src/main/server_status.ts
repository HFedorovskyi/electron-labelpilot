import { BrowserWindow } from 'electron';
import { testConnection } from './sync';
import { loadPrinterConfig } from './config';

export class ServerStatusManager {
    private timer: NodeJS.Timeout | null = null;
    private lastStatus: 'connected' | 'disconnected' = 'disconnected';
    private mainWindow: BrowserWindow | null = null;
    private reconnectCbs: Array<() => void> = [];

    /** Subscribe to the disconnected -> connected transition (e.g. flush the report outbox). */
    onReconnect(cb: () => void) {
        this.reconnectCbs.push(cb);
    }

    // Adaptive cadence: poll often while disconnected (so reconnection is detected quickly),
    // back off once connected — the steady state — and back off FURTHER (but never stop) while
    // the window is hidden, so a reconnect that happens while minimized is still noticed and the
    // report outbox drains via onReconnect. (Previously hidden windows skipped the check
    // entirely, stranding the outbox until the window was shown again.)
    private readonly POLL_CONNECTED_MS = 15000;
    private readonly POLL_DISCONNECTED_MS = 5000;
    private readonly POLL_HIDDEN_MS = 60000;

    constructor() { }

    setMainWindow(win: BrowserWindow) {
        this.mainWindow = win;
        // Re-check connectivity the moment the window is shown/focused, so a reconnect that
        // happened while the window was minimized is detected at once (and the report outbox
        // drains immediately via the disconnected->connected transition) rather than waiting
        // for the next slow hidden-cadence tick.
        const recheck = () => { void this.checkConnection(); };
        win.on('show', recheck);
        win.on('focus', recheck);
        win.on('restore', recheck);
        // Immediate status report after window is set
        this.sendStatusUpdate();
    }

    startPolling() {
        this.stopPolling();
        const tick = async () => {
            // Always poll (even while hidden); nextDelay() just slows the cadence when hidden.
            await this.checkConnection();
            this.timer = setTimeout(tick, this.nextDelay());
        };
        // Initial immediate check, then self-schedule with adaptive delay.
        this.checkConnection().finally(() => {
            this.timer = setTimeout(tick, this.nextDelay());
        });
    }

    private nextDelay(): number {
        const hidden = !this.mainWindow || this.mainWindow.isDestroyed() || !this.mainWindow.isVisible();
        if (hidden) return this.POLL_HIDDEN_MS;
        return this.lastStatus === 'connected' ? this.POLL_CONNECTED_MS : this.POLL_DISCONNECTED_MS;
    }

    stopPolling() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    async checkConnection() {
        try {
            const config = loadPrinterConfig();
            const serverIp = config.serverIp;

            if (!serverIp) {
                this.updateStatus('disconnected');
                return;
            }

            const isOnline = await testConnection(serverIp);
            this.updateStatus(isOnline ? 'connected' : 'disconnected');
        } catch (error) {
            this.updateStatus('disconnected');
        }
    }

    private updateStatus(newStatus: 'connected' | 'disconnected') {
        if (this.lastStatus !== newStatus) {
            const reconnected = this.lastStatus === 'disconnected' && newStatus === 'connected';
            this.lastStatus = newStatus;
            this.sendStatusUpdate();
            if (reconnected) {
                this.reconnectCbs.forEach((cb) => { try { cb(); } catch (e) { console.error('[server_status] reconnect cb failed:', e); } });
            }
        }
    }

    private sendStatusUpdate() {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('discovery-event', {
                type: 'server-found',
                status: this.lastStatus
            });

            this.mainWindow.webContents.send('server-status-updated', {
                status: this.lastStatus
            });
        }
    }

    getStatus() {
        return this.lastStatus;
    }

    notifyReady() {
        this.sendStatusUpdate();
    }
}

export const serverStatusManager = new ServerStatusManager();
