"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const database_1 = require("./database");
const scales_1 = require("./scales");
// Import usb_sync
const usb_sync_1 = require("./usb_sync");
const discovery_1 = require("./discovery");
// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
    electron_1.app.quit();
}
// Global error handler for EPIPE errors which are common in Electron main process
// when console output pipes are closed unexpectedly.
process.on('uncaughtException', (err) => {
    if (err.code === 'EPIPE') {
        // Safe to ignore EPIPE as it just means we can't write to stdout/stderr
        return;
    }
    console.error('Uncaught Exception:', err);
    // Usually we should exit on uncaught exception, but let's try to keep running if possible
    // process.exit(1); 
});
let mainWindow = null;
function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            preload: path_1.default.join(__dirname, '../preload/index.js'),
            sandbox: false,
            nodeIntegration: false,
            contextIsolation: true,
        },
    });
    scales_1.scaleManager.setMainWindow(mainWindow);
    discovery_1.discoveryManager.setMainWindow(mainWindow);
    const devUrl = 'http://127.0.0.1:5173';
    if (!electron_1.app.isPackaged) {
        mainWindow.loadURL(devUrl);
        mainWindow.webContents.openDevTools();
    }
    else {
        mainWindow.loadFile(path_1.default.join(__dirname, '../dist/index.html'));
    }
}
electron_1.app.whenReady().then(() => {
    (0, database_1.initDatabase)();
    electron_1.ipcMain.handle('get-station-info', () => {
        const { getStationInfo } = require('./database');
        return getStationInfo();
    });
    createWindow();
    // Initialize Managers
    scales_1.scaleManager.init();
    // Default to station mode, or load from config if we had it. 
    // For now, default start is silent until UI sets mode.
    discovery_1.discoveryManager.setMode('station');
    // IPC Handlers
    electron_1.ipcMain.on('set-app-mode', (_, mode) => {
        discovery_1.discoveryManager.setMode(mode);
    });
    electron_1.ipcMain.on('connect-scale', (_, config) => {
        scales_1.scaleManager.saveAndConnect(config);
    });
    electron_1.ipcMain.handle('get-scale-config', () => {
        return scales_1.scaleManager.getConfig();
    });
    electron_1.ipcMain.handle('get-scale-status', () => {
        return scales_1.scaleManager.getStatus();
    });
    electron_1.ipcMain.on('save-scale-config', (_, config) => {
        scales_1.scaleManager.saveAndConnect(config);
    });
    electron_1.ipcMain.handle('get-numbering-config', async () => {
        const { loadNumberingConfig } = await Promise.resolve().then(() => __importStar(require('./config')));
        return loadNumberingConfig();
    });
    electron_1.ipcMain.on('save-numbering-config', async (_, config) => {
        const { saveNumberingConfig } = await Promise.resolve().then(() => __importStar(require('./config')));
        saveNumberingConfig(config);
    });
    electron_1.ipcMain.on('disconnect-scale', () => {
        scales_1.scaleManager.disconnect();
    });
    electron_1.ipcMain.handle('get-serial-ports', async () => {
        return await scales_1.scaleManager.listPorts();
    });
    electron_1.ipcMain.handle('get-protocols', () => {
        return scales_1.scaleManager.getProtocols();
    });
    electron_1.ipcMain.handle('get-products', async (_, search) => {
        // dynamic import or direct import if already verified
        const { getProducts } = await Promise.resolve().then(() => __importStar(require('./database')));
        return getProducts(search);
    });
    electron_1.ipcMain.handle('get-containers', async () => {
        const { getContainers } = await Promise.resolve().then(() => __importStar(require('./database')));
        return getContainers();
    });
    // Printing Handlers
    electron_1.ipcMain.handle('print-label', async (_, options) => {
        const { silent, labelDoc, data, printerName } = options;
        return new Promise((resolve) => {
            const printWindow = new electron_1.BrowserWindow({
                show: false,
                webPreferences: {
                    preload: path_1.default.join(__dirname, '../preload/index.js'),
                    sandbox: false,
                    nodeIntegration: false,
                    contextIsolation: true,
                },
            });
            const devUrl = 'http://127.0.0.1:5173';
            const url = electron_1.app.isPackaged
                ? `file://${path_1.default.join(__dirname, '../dist/index.html')}?print=true`
                : `${devUrl}?print=true`;
            printWindow.loadURL(url);
            printWindow.webContents.on('did-finish-load', () => {
                printWindow.webContents.send('print-data', { labelDoc, data });
            });
            const readyHandler = (event) => {
                if (event.sender === printWindow.webContents) {
                    electron_1.ipcMain.removeListener('ready-to-print', readyHandler);
                    const printOptions = {
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
            electron_1.ipcMain.on('ready-to-print', readyHandler);
        });
    });
    electron_1.ipcMain.handle('get-printers', async (event) => {
        const win = electron_1.BrowserWindow.fromWebContents(event.sender);
        return win?.webContents.getPrintersAsync() || [];
    });
    // USB Sync Handlers
    electron_1.ipcMain.handle('usb-export', async (_, { path, data }) => {
        return (0, usb_sync_1.exportDataToUSB)(path, data);
    });
    electron_1.ipcMain.handle('usb-import', async (_, path) => {
        return (0, usb_sync_1.importDataFromUSB)(path);
    });
    electron_1.ipcMain.handle('get-label', async (_, id) => {
        const { getLabelById } = await Promise.resolve().then(() => __importStar(require('./database')));
        return getLabelById(id);
    });
    electron_1.ipcMain.handle('get-barcode-template', async (_, id) => {
        const { getBarcodeTemplateById } = await Promise.resolve().then(() => __importStar(require('./database')));
        return getBarcodeTemplateById(id);
    });
    // Data Sync Handlers
    electron_1.ipcMain.handle('sync-data', async (_, serverIp) => {
        const { syncDataFromServer } = await Promise.resolve().then(() => __importStar(require('./sync')));
        return await syncDataFromServer(serverIp);
    });
    // Printer Config Handlers
    electron_1.ipcMain.handle('get-printer-config', async () => {
        const { loadPrinterConfig } = await Promise.resolve().then(() => __importStar(require('./config')));
        return loadPrinterConfig();
    });
    electron_1.ipcMain.on('save-printer-config', async (_, config) => {
        const { savePrinterConfig } = await Promise.resolve().then(() => __importStar(require('./config')));
        savePrinterConfig(config);
    });
    // Database Viewer Handlers
    electron_1.ipcMain.handle('get-tables', async () => {
        const { getTables } = await Promise.resolve().then(() => __importStar(require('./database')));
        return getTables();
    });
    electron_1.ipcMain.handle('get-table-data', async (_, tableName) => {
        const { getTableData } = await Promise.resolve().then(() => __importStar(require('./database')));
        return getTableData(tableName);
    });
    electron_1.ipcMain.handle('record-pack', async (_, data) => {
        const { recordPack } = await Promise.resolve().then(() => __importStar(require('./database')));
        return recordPack(data);
    });
    electron_1.ipcMain.handle('close-box', async (_, { boxId, weightNetto, weightBrutto }) => {
        const { closeBox } = await Promise.resolve().then(() => __importStar(require('./database')));
        return closeBox(boxId, weightNetto, weightBrutto);
    });
    electron_1.ipcMain.handle('get-latest-counters', async () => {
        const { getLatestCounters } = await Promise.resolve().then(() => __importStar(require('./database')));
        return getLatestCounters();
    });
    electron_1.ipcMain.on('log-to-main', (_event, ...args) => {
        console.log('[Renderer Log]:', ...args);
    });
});
// Import and start Sync Server
const server_1 = require("./server");
(0, server_1.startSyncServer)();
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        electron_1.app.quit();
    }
});
