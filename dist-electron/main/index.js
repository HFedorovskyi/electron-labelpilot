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
    const devUrl = 'http://localhost:5173';
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
    electron_1.ipcMain.on('save-scale-config', (_, config) => {
        scales_1.scaleManager.saveAndConnect(config);
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
    // Printing Handlers
    electron_1.ipcMain.handle('print-label', async (event, options) => {
        const win = electron_1.BrowserWindow.fromWebContents(event.sender);
        if (win) {
            return new Promise((resolve, reject) => {
                win.webContents.print({
                    silent: options?.silent || false,
                    deviceName: options?.deviceName,
                    printBackground: true,
                    margins: { marginType: 'none' }
                }, (success, errorType) => {
                    if (success)
                        resolve(true);
                    else
                        reject(errorType);
                });
            });
        }
        return false;
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
    // Data Sync Handlers
    electron_1.ipcMain.handle('sync-data', async (_, serverIp) => {
        // dynamic import to avoid circular dep if any, though likely safe
        const { syncDataFromServer } = await Promise.resolve().then(() => __importStar(require('./sync')));
        return await syncDataFromServer(serverIp);
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
