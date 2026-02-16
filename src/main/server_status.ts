import { BrowserWindow } from 'electron';
import { testConnection } from './sync';
import { loadPrinterConfig } from './config';

export class ServerStatusManager {
    private interval: NodeJS.Timeout | null = null;
    private lastStatus: 'connected' | 'disconnected' = 'disconnected';
    private mainWindow: BrowserWindow | null = null;

    constructor() { }

    setMainWindow(win: BrowserWindow) {
        this.mainWindow = win;
        // Immediate status report after window is set
        this.sendStatusUpdate();
    }

    startPolling() {
        if (this.interval) clearInterval(this.interval);

        // Initial check
        this.checkConnection();

        // Poll every 5 seconds
        this.interval = setInterval(() => {
            this.checkConnection();
        }, 5000);
    }

    stopPolling() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
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
