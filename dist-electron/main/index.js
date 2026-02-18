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
const server_status_1 = require("./server_status");
const logger_1 = __importDefault(require("./logger")); // Ensure logger is imported
const UpdateService_1 = require("./updater/UpdateService");
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
let workerWindow = null;
function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
        width: 1200,
        height: 800,
        fullscreen: true, // Launch in full screen mode by default
        webPreferences: {
            preload: electron_1.app.isPackaged
                ? path_1.default.join(electron_1.app.getAppPath(), 'dist-electron/preload/index.js')
                : path_1.default.join(__dirname, '../preload/index.js'),
            sandbox: false,
            nodeIntegration: false,
            contextIsolation: true,
        },
        backgroundColor: '#1e1e1e', // Prevent white flash, especially if GPU disabled
    });
    scales_1.scaleManager.setMainWindow(mainWindow);
    discovery_1.discoveryManager.setMainWindow(mainWindow);
    server_status_1.serverStatusManager.setMainWindow(mainWindow);
    const devUrl = 'http://127.0.0.1:5173';
    if (!electron_1.app.isPackaged) {
        mainWindow.loadURL(devUrl);
        mainWindow.webContents.openDevTools();
    }
    else {
        mainWindow.loadFile(path_1.default.join(electron_1.app.getAppPath(), 'dist/index.html'));
    }
}
function createWorkerWindow() {
    workerWindow = new electron_1.BrowserWindow({
        show: false,
        webPreferences: {
            preload: electron_1.app.isPackaged
                ? path_1.default.join(electron_1.app.getAppPath(), 'dist-electron/preload/index.js')
                : path_1.default.join(__dirname, '../preload/index.js'),
            sandbox: false,
            nodeIntegration: false,
            contextIsolation: true,
            backgroundThrottling: false // CRITICAL: Prevent Chrome from slowing down hidden window
        },
    });
    const devUrl = 'http://127.0.0.1:5173';
    const url = electron_1.app.isPackaged
        ? `file://${path_1.default.join(electron_1.app.getAppPath(), 'dist/index.html')}?print=true`
        : `${devUrl}?print=true`;
    workerWindow.loadURL(url);
    workerWindow.on('closed', () => {
        workerWindow = null;
    });
}
electron_1.app.whenReady().then(() => {
    (0, database_1.initDatabase)();
    electron_1.ipcMain.handle('get-station-info', () => {
        const { getStationInfo } = require('./database');
        return getStationInfo();
    });
    createWindow();
    createWorkerWindow();
    // Initialize Managers
    scales_1.scaleManager.init();
    // Initialize auto-updater
    (0, UpdateService_1.initUpdater)(mainWindow);
    // Refresh server version cache for pre-update compat checks
    (0, UpdateService_1.refreshServerVersion)().catch(() => { });
    // Default to station mode, or load from config if we had it. 
    // For now, default start is silent until UI sets mode.
    discovery_1.discoveryManager.setMode('station');
    server_status_1.serverStatusManager.startPolling();
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
    let printQueue = Promise.resolve();
    electron_1.ipcMain.handle('print-label', async (_, options) => {
        // Queue the print request to ensure sequential processing
        const result = await (printQueue = printQueue.then(async () => {
            const startTime = Date.now();
            const { silent, labelDoc, data, printerConfig, printerName } = options;
            // ── DIAGNOSTIC: Log what we received to understand routing ──
            logger_1.default.info(`[print-label] Routing: protocol=${printerConfig?.protocol}, connection=${printerConfig?.connection}, name=${printerConfig?.name}`);
            // New Routing Logic: Use PrinterService for all protocols (zpl, image, tspl)
            // when we have a structured printerConfig with a direct connection (TCP/Serial).
            // Fall through to legacy webContents.print() only for windows_driver without protocol support.
            if (printerConfig && typeof printerConfig === 'object' &&
                (printerConfig.protocol !== 'image' || printerConfig.connection === 'tcp' || printerConfig.connection === 'serial')) {
                try {
                    const { printerService } = await Promise.resolve().then(() => __importStar(require('./printer/PrinterService')));
                    await printerService.printLabel(printerConfig, labelDoc, data);
                    const duration = Date.now() - startTime;
                    logger_1.default.info(`Printed via PrinterService (${printerConfig.protocol}) to ${printerConfig.name} in ${duration}ms`);
                    return true;
                }
                catch (e) {
                    logger_1.default.error('PrinterService failed:', e);
                    return false;
                }
            }
            // IMAGE MODE: Use persistent worker window
            const targetPrinter = printerName || printerConfig?.driverName;
            logger_1.default.info(`Image Mode Printing: Target=${targetPrinter || 'Default'}`);
            // Ensure window exists (should be created on app ready)
            if (!workerWindow || workerWindow.isDestroyed()) {
                logger_1.default.info('Worker window missing, recreating...');
                createWorkerWindow();
            }
            return new Promise((resolve) => {
                const currentWorker = workerWindow;
                const performPrint = () => {
                    const printOptions = {
                        silent: silent !== false,
                        printBackground: true,
                        margins: { marginType: 'none' }
                    };
                    if (targetPrinter) {
                        printOptions.deviceName = targetPrinter;
                    }
                    logger_1.default.info(`Printing to device: ${printOptions.deviceName || 'default'} (Silent: ${silent !== false})`);
                    currentWorker.webContents.print(printOptions, (success, failureReason) => {
                        const duration = Date.now() - startTime;
                        if (success) {
                            logger_1.default.info(`Print result: SUCCESS (Duration: ${duration}ms)`);
                        }
                        else {
                            logger_1.default.error(`Print result: FAILURE (Duration: ${duration}ms) Reason: ${failureReason}`);
                        }
                        resolve(success);
                    });
                };
                // One-time listener for this specific print job
                const readyHandler = (_event) => {
                    // console.log('Received ready-to-print from renderer');
                    electron_1.ipcMain.removeListener('ready-to-print', readyHandler);
                    performPrint();
                };
                electron_1.ipcMain.on('ready-to-print', readyHandler);
                // Wait for load if needed, otherwise send immediately
                if (currentWorker.webContents.isLoading()) {
                    logger_1.default.info('Worker is loading, waiting for finish...');
                    currentWorker.webContents.once('did-finish-load', () => {
                        currentWorker.webContents.send('print-data', { labelDoc, data });
                    });
                }
                else {
                    currentWorker.webContents.send('print-data', { labelDoc, data });
                }
                // Timeout safety
                setTimeout(() => {
                    electron_1.ipcMain.removeListener('ready-to-print', readyHandler);
                    resolve(false);
                }, 15000); // 15s timeout
            });
        }).catch(err => {
            logger_1.default.error('Print queue error:', err);
            return false;
        }));
        return result;
    });
});
electron_1.ipcMain.handle('get-printers', async (event) => {
    const startTime = Date.now();
    logger_1.default.info('[IPC] get-printers started');
    try {
        const win = electron_1.BrowserWindow.fromWebContents(event.sender);
        const printers = await win?.webContents.getPrintersAsync() || [];
        logger_1.default.info(`[IPC] get-printers finished in ${Date.now() - startTime}ms. Count: ${printers.length}`);
        return printers;
    }
    catch (e) {
        logger_1.default.error(`[IPC] get-printers FAILED in ${Date.now() - startTime}ms:`, e);
        return [];
    }
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
    const { testConnectionFull } = await Promise.resolve().then(() => __importStar(require('./sync')));
    logger_1.default.info(`Attempting to sync data with server: ${serverIp}`);
    const info = await testConnectionFull(serverIp);
    return info.online;
});
electron_1.ipcMain.handle('get-server-status', () => {
    return server_status_1.serverStatusManager.getStatus();
});
// Printer Config Handlers
electron_1.ipcMain.handle('get-printer-config', async () => {
    const { loadPrinterConfig } = await Promise.resolve().then(() => __importStar(require('./config')));
    return loadPrinterConfig();
});
electron_1.ipcMain.on('save-printer-config', async (_, config) => {
    logger_1.default.info('[IPC] save-printer-config started', {
        packProtocol: config.packPrinter?.protocol,
        boxProtocol: config.boxPrinter?.protocol,
        autoPrint: config.autoPrintOnStable
    });
    const startTime = Date.now();
    try {
        const { savePrinterConfig } = await Promise.resolve().then(() => __importStar(require('./config')));
        savePrinterConfig(config);
        // Reload printer service
        const { printerService } = await Promise.resolve().then(() => __importStar(require('./printer/PrinterService')));
        printerService.reloadConfig();
        // Broadcast update to all windows
        electron_1.BrowserWindow.getAllWindows().forEach(win => {
            win.webContents.send('printer-config-updated', config);
        });
        // Restart polling to pick up new IP immediately if it changed
        server_status_1.serverStatusManager.startPolling();
        logger_1.default.info(`[IPC] save-printer-config finished in ${Date.now() - startTime}ms`);
    }
    catch (e) {
        logger_1.default.error(`[IPC] save-printer-config FAILED in ${Date.now() - startTime}ms:`, e);
    }
});
electron_1.ipcMain.handle('test-print', async (_event, config) => {
    logger_1.default.info('[IPC] test-print started', { protocol: config.protocol, name: config.name });
    const startTime = Date.now();
    if (config.protocol === 'image') {
        const testDoc = {
            id: 'test',
            name: 'Test Label',
            widthMm: config.widthMm || 58,
            heightMm: config.heightMm || 40,
            canvas: { width: 400, height: 300, background: '#ffffff' },
            elements: [
                { id: '1', type: 'text', text: 'TEST PRINT', x: 50, y: 50, fontSize: 30, fontWeight: 'bold' },
                { id: '2', type: 'text', text: `Printer: ${config.name}`, x: 50, y: 100, fontSize: 16 },
                { id: '3', type: 'text', text: `Protocol: ${config.protocol}`, x: 50, y: 130, fontSize: 16 },
                { id: '4', type: 'barcode', value: 'TEST123456', x: 50, y: 180, w: 300, h: 80, barcodeType: 'code128' }
            ]
        };
        const testData = { batch_number: 'TEST' };
        if (!workerWindow) {
            logger_1.default.info('[IPC] test-print: creating worker window');
            createWorkerWindow();
        }
        const currentWorker = workerWindow;
        return new Promise((resolve) => {
            const readyHandler = (ev) => {
                if (ev.sender === currentWorker.webContents) {
                    electron_1.ipcMain.removeListener('ready-to-print', readyHandler);
                    const printOptions = {
                        silent: false,
                        printBackground: true,
                        margins: { marginType: 'none' },
                        deviceName: config.driverName || ''
                    };
                    logger_1.default.info('[IPC] test-print: calling webContents.print');
                    currentWorker.webContents.print(printOptions, (success) => {
                        logger_1.default.info(`[IPC] test-print (image) finished in ${Date.now() - startTime}ms. Success: ${success}`);
                        resolve({ success });
                    });
                }
            };
            electron_1.ipcMain.on('ready-to-print', readyHandler);
            currentWorker.webContents.send('print-data', { labelDoc: testDoc, data: testData });
        });
    }
    const { printerService } = await Promise.resolve().then(() => __importStar(require('./printer/PrinterService')));
    try {
        await printerService.testPrint(config);
        logger_1.default.info(`[IPC] test-print (${config.protocol}) finished in ${Date.now() - startTime}ms`);
        return { success: true };
    }
    catch (error) {
        logger_1.default.error(`[IPC] test-print FAILED in ${Date.now() - startTime}ms:`, error);
        return { success: false, message: error.message };
    }
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
electron_1.ipcMain.on('renderer-ready', () => {
    server_status_1.serverStatusManager.notifyReady();
});
// --- Identity & Offline Sync Handlers ---
electron_1.ipcMain.handle('get-identity', () => {
    const { loadIdentity } = require('./identity');
    return loadIdentity();
});
electron_1.ipcMain.handle('import-identity-file', async () => {
    const { dialog } = require('electron');
    const { importIdentityFile } = require('./identity');
    try {
        const result = await dialog.showOpenDialog({
            title: 'Select Identity File (.lpi)',
            filters: [{ name: 'LabelPilot Identity', extensions: ['lpi'] }],
            properties: ['openFile']
        });
        if (result.canceled || result.filePaths.length === 0) {
            return { success: false, message: 'Cancelled' };
        }
        const identity = await importIdentityFile(result.filePaths[0]);
        return { success: true, identity };
    }
    catch (error) {
        console.error('Identity Import Error:', error);
        return { success: false, message: error.message };
    }
});
electron_1.ipcMain.handle('offline-import', async () => {
    const { importOfflineUpdate } = require('./offline_sync');
    return await importOfflineUpdate();
});
electron_1.ipcMain.handle('offline-export', async () => {
    const { exportOfflineData } = require('./offline_sync');
    return await exportOfflineData();
});
electron_1.ipcMain.handle('get-next-sequence', (_, type) => {
    const { getNextSequence } = require('./sequence');
    try {
        return { success: true, number: getNextSequence(type) };
    }
    catch (error) {
        return { success: false, message: error.message };
    }
});
electron_1.ipcMain.handle('reset-database', async () => {
    const { resetDatabase } = require('./database');
    const { deleteIdentity } = require('./identity');
    try {
        resetDatabase();
        deleteIdentity();
        return { success: true, message: 'Database reset successfully' };
    }
    catch (error) {
        console.error('Failed to reset database:', error);
        return { success: false, message: error.message };
    }
});
electron_1.ipcMain.on('open-logs-folder', () => {
    const logsPath = path_1.default.join(electron_1.app.getPath('userData'), 'logs');
    electron_1.shell.openPath(logsPath);
});
electron_1.ipcMain.on('quit-app', () => {
    electron_1.app.quit();
});
// --- Updater IPC Handlers ---
electron_1.ipcMain.handle('updater:get-version', () => electron_1.app.getVersion());
electron_1.ipcMain.handle('updater:check', async () => {
    return await (0, UpdateService_1.checkForUpdates)();
});
electron_1.ipcMain.handle('updater:download', async () => {
    await (0, UpdateService_1.downloadUpdate)();
    return { success: true };
});
electron_1.ipcMain.handle('updater:install', async () => {
    await (0, UpdateService_1.installUpdate)();
    return { success: true };
});
electron_1.ipcMain.handle('updater:install-offline', async () => {
    const result = await electron_1.dialog.showOpenDialog({
        title: 'Выберите установщик LabelPilot (.exe)',
        filters: [{ name: 'LabelPilot Installer', extensions: ['exe'] }],
        properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) {
        return { success: false, message: 'Отменено' };
    }
    return await (0, UpdateService_1.installOfflineUpdate)(result.filePaths[0]);
});
electron_1.ipcMain.handle('updater:list-backups', async () => {
    return await (0, UpdateService_1.getBackups)();
});
electron_1.ipcMain.handle('updater:rollback', async (_, backupId) => {
    return await (0, UpdateService_1.rollbackToBackup)(backupId);
});
electron_1.ipcMain.handle('updater:refresh-server-version', async () => {
    await (0, UpdateService_1.refreshServerVersion)();
    return { success: true };
});
// Import and start Sync Server
const server_1 = require("./server");
// Register ipc handlers
(0, server_1.startSyncServer)((data) => {
    if (mainWindow) {
        mainWindow.webContents.send('sync-complete', { success: true, ...data });
    }
});
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        electron_1.app.quit();
    }
});
