import { BrowserWindow } from 'electron';
import { testConnection } from './sync';
import { loadPrinterConfig } from './config';

export class ServerStatusManager {
    private timer: NodeJS.Timeout | null = null;
    private lastStatus: 'connected' | 'disconnected' = 'disconnected';
    private mainWindow: BrowserWindow | null = null;

    // Adaptive cadence: poll often while disconnected (so reconnection is detected quickly),
    // but back off once connected — the steady state — to cut the constant 5s HTTP round-trip
    // on an always-on weak POS. Also skip the network call entirely while the window is hidden.
    private readonly POLL_CONNECTED_MS = 15000;
    private readonly POLL_DISCONNECTED_MS = 5000;

    constructor() { }

    setMainWindow(win: BrowserWindow) {
        this.mainWindow = win;
        // Immediate status report after window is set
        this.sendStatusUpdate();
    }

    startPolling() {
        this.stopPolling();
        const tick = async () => {
            const hidden = !this.mainWindow || this.mainWindow.isDestroyed() || !this.mainWindow.isVisible();
            if (!hidden) {
                await this.checkConnection();
            }
            const delay = this.lastStatus === 'connected' ? this.POLL_CONNECTED_MS : this.POLL_DISCONNECTED_MS;
            this.timer = setTimeout(tick, delay);
        };
        // Initial immediate check, then self-schedule with adaptive delay.
        this.checkConnection().finally(() => {
            const delay = this.lastStatus === 'connected' ? this.POLL_CONNECTED_MS : this.POLL_DISCONNECTED_MS;
            this.timer = setTimeout(tick, delay);
        });
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
            this.lastStatus = newStatus;
            this.sendStatusUpdate();
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
