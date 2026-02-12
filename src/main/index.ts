import { app, BrowserWindow, ipcMain } from 'electron';
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

// Global error handler for EPIPE errors which are common in Electron main process
// when console output pipes are closed unexpectedly.
process.on('uncaughtException', (err: any) => {
    if (err.code === 'EPIPE') {
        // Safe to ignore EPIPE as it just means we can't write to stdout/stderr
        return;
    }
    console.error('Uncaught Exception:', err);
    // Usually we should exit on uncaught exception, but let's try to keep running if possible
    // process.exit(1); 
});

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

    const devUrl = 'http://127.0.0.1:5173';

    if (!app.isPackaged) {
        mainWindow.loadURL(devUrl);
        mainWindow.webContents.openDevTools();
    } else {
        mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }
}

app.whenReady().then(() => {
    initDatabase();

    ipcMain.handle('get-station-info', () => {
        const { getStationInfo } = require('./database');
        return getStationInfo();
    });



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

    ipcMain.handle('get-scale-status', () => {
        return scaleManager.getStatus();
    });

    ipcMain.on('save-scale-config', (_, config) => {
        scaleManager.saveAndConnect(config);
    });

    ipcMain.handle('get-numbering-config', async () => {
        const { loadNumberingConfig } = await import('./config');
        return loadNumberingConfig();
    });

    ipcMain.on('save-numbering-config', async (_, config) => {
        const { saveNumberingConfig } = await import('./config');
        saveNumberingConfig(config);
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

    ipcMain.handle('get-containers', async () => {
        const { getContainers } = await import('./database');
        return getContainers();
    });

    // Printing Handlers
    ipcMain.handle('print-label', async (_, options) => {
        const { silent, labelDoc, data, printerName } = options;

        return new Promise((resolve) => {
            const printWindow = new BrowserWindow({
                show: false,
                webPreferences: {
                    preload: path.join(__dirname, '../preload/index.js'),
                    sandbox: false,
                    nodeIntegration: false,
                    contextIsolation: true,
                },
            });

            const devUrl = 'http://127.0.0.1:5173';
            const url = app.isPackaged
                ? `file://${path.join(__dirname, '../dist/index.html')}?print=true`
                : `${devUrl}?print=true`;

            printWindow.loadURL(url);

            printWindow.webContents.on('did-finish-load', () => {
                printWindow.webContents.send('print-data', { labelDoc, data });
            });

            const readyHandler = (event: any) => {
                if (event.sender === printWindow.webContents) {
                    ipcMain.removeListener('ready-to-print', readyHandler);
                    const printOptions: any = {
                        silent: silent !== false,
                        printBackground: true,
                        margins: { marginType: 'none' }
                    };
                    // Route to specific printer (supports industrial: TSC, Zebra, Honeywell, CAB, etc.)
                    if (printerName) {
                        printOptions.deviceName = printerName;
                    }
                    printWindow.webContents.print(printOptions, (success) => {
                        printWindow.close();
                        resolve(success);
                    });
                }
            };
            ipcMain.on('ready-to-print', readyHandler);
        });
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

    ipcMain.handle('get-label', async (_, id) => {
        const { getLabelById } = await import('./database');
        return getLabelById(id);
    });

    ipcMain.handle('get-barcode-template', async (_, id) => {
        const { getBarcodeTemplateById } = await import('./database');
        return getBarcodeTemplateById(id);
    });

    // Data Sync Handlers
    ipcMain.handle('sync-data', async (_, serverIp) => {
        const { testConnection } = await import('./sync');
        return await testConnection(serverIp);
    });

    // Printer Config Handlers
    ipcMain.handle('get-printer-config', async () => {
        const { loadPrinterConfig } = await import('./config');
        return loadPrinterConfig();
    });

    ipcMain.on('save-printer-config', async (_, config) => {
        const { savePrinterConfig } = await import('./config');
        savePrinterConfig(config);
    });

    // Database Viewer Handlers
    ipcMain.handle('get-tables', async () => {
        const { getTables } = await import('./database');
        return getTables();
    });

    ipcMain.handle('get-table-data', async (_, tableName) => {
        const { getTableData } = await import('./database');
        return getTableData(tableName);
    });

    ipcMain.handle('record-pack', async (_, data) => {
        const { recordPack } = await import('./database');
        return recordPack(data);
    });

    ipcMain.handle('close-box', async (_, { boxId, weightNetto, weightBrutto }) => {
        const { closeBox } = await import('./database');
        return closeBox(boxId, weightNetto, weightBrutto);
    });

    ipcMain.handle('get-latest-counters', async () => {
        const { getLatestCounters } = await import('./database');
        return getLatestCounters();
    });

    ipcMain.on('log-to-main', (_event, ...args) => {
        console.log('[Renderer Log]:', ...args);
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
