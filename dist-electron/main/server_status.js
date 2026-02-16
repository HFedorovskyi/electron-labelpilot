"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.serverStatusManager = exports.ServerStatusManager = void 0;
const sync_1 = require("./sync");
const config_1 = require("./config");
class ServerStatusManager {
    interval = null;
    lastStatus = 'disconnected';
    mainWindow = null;
    constructor() { }
    setMainWindow(win) {
        this.mainWindow = win;
        // Immediate status report after window is set
        this.sendStatusUpdate();
    }
    startPolling() {
        if (this.interval)
            clearInterval(this.interval);
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
            const config = (0, config_1.loadPrinterConfig)();
            const serverIp = config.serverIp;
            if (!serverIp) {
                this.updateStatus('disconnected');
                return;
            }
            const isOnline = await (0, sync_1.testConnection)(serverIp);
            this.updateStatus(isOnline ? 'connected' : 'disconnected');
        }
        catch (error) {
            this.updateStatus('disconnected');
        }
    }
    updateStatus(newStatus) {
        if (this.lastStatus !== newStatus) {
            this.lastStatus = newStatus;
            this.sendStatusUpdate();
        }
    }
    sendStatusUpdate() {
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
exports.ServerStatusManager = ServerStatusManager;
exports.serverStatusManager = new ServerStatusManager();
