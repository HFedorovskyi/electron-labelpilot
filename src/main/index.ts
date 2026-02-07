import { app, BrowserWindow, ipcMain } from 'electron';
import dgram from 'dgram';
import path from 'path';
import { initDatabase } from './database';
import { scaleManager } from './scales';

// Import usb_sync
import { exportDataToUSB, importDataFromUSB } from './usb_sync';
import { discoveryManager } from './discovery';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
    app.quit();
}

let mainWindow: any = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            sandbox: false,
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    scaleManager.setMainWindow(mainWindow);
    discoveryManager.setMainWindow(mainWindow);

    const devUrl = 'http://localhost:5173';

    if (!app.isPackaged) {
        mainWindow.loadURL(devUrl);
        mainWindow.webContents.openDevTools();
    } else {
        mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }
}

app.whenReady().then(() => {
    initDatabase();
    createWindow();

    // Initialize Managers
    scaleManager.init();

    // Default to station mode, or load from config if we had it. 
    // For now, default start is silent until UI sets mode.
    discoveryManager.setMode('station');

    // IPC Handlers
    ipcMain.on('set-app-mode', (_, mode) => {
        discoveryManager.setMode(mode);
    });

    ipcMain.on('connect-scale', (_, config) => {
        scaleManager.saveAndConnect(config);
    });

    ipcMain.handle('get-scale-config', () => {
        return scaleManager.getConfig();
    });

    ipcMain.on('save-scale-config', (_, config) => {
        scaleManager.saveAndConnect(config);
    });

    ipcMain.on('disconnect-scale', () => {
        scaleManager.disconnect();
    });

    ipcMain.handle('get-serial-ports', async () => {
        return await scaleManager.listPorts();
    });

    ipcMain.handle('get-protocols', () => {
        return scaleManager.getProtocols();
    });

    ipcMain.handle('get-products', async (_, search) => {
        // dynamic import or direct import if already verified
        const { getProducts } = await import('./database');
        return getProducts(search);
    });

    // Printing Handlers
    ipcMain.handle('print-label', async (event, options) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            return new Promise((resolve, reject) => {
                win.webContents.print({
                    silent: options?.silent || false,
                    deviceName: options?.deviceName,
                    printBackground: true,
                    margins: { marginType: 'none' }
                }, (success, errorType) => {
                    if (success) resolve(true);
                    else reject(errorType);
                });
            });
        }
        return false;
    });

    ipcMain.handle('get-printers', async (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        return win?.webContents.getPrintersAsync() || [];
    });

    // USB Sync Handlers
    ipcMain.handle('usb-export', async (_, { path, data }) => {
        return exportDataToUSB(path, data);
    });

    ipcMain.handle('usb-import', async (_, path) => {
        return importDataFromUSB(path);
    });

    // Data Sync Handlers
    ipcMain.handle('sync-data', async (_, serverIp) => {
        // dynamic import to avoid circular dep if any, though likely safe
        const { syncDataFromServer } = await import('./sync');
        return await syncDataFromServer(serverIp);
    });
});

// Import and start Sync Server
import { startSyncServer } from './server';
startSyncServer();

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
