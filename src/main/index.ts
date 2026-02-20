import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import path from 'path';
import { initDatabase } from './database';
import { scaleManager } from './scales';

// Import usb_sync
import { exportDataToUSB, importDataFromUSB } from './usb_sync';
import { discoveryManager } from './discovery';
import { serverStatusManager } from './server_status';
import log from './logger'; // Ensure logger is imported
import {
    initUpdater,
    checkForUpdates,
    downloadUpdate,
    installUpdate,
    installOfflineUpdate,
    rollbackToBackup,
    getBackups,
    refreshServerVersion,
} from './updater/UpdateService';

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
let workerWindow: BrowserWindow | null = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        fullscreen: true, // Launch in full screen mode by default
        webPreferences: {
            preload: app.isPackaged
                ? path.join(app.getAppPath(), 'dist-electron/preload/index.js')
                : path.join(__dirname, '../preload/index.js'),
            sandbox: false,
            nodeIntegration: false,
            contextIsolation: true,
        },
        backgroundColor: '#1e1e1e', // Prevent white flash, especially if GPU disabled
    });

    scaleManager.setMainWindow(mainWindow);
    discoveryManager.setMainWindow(mainWindow);
    serverStatusManager.setMainWindow(mainWindow);

    const devUrl = 'http://127.0.0.1:5173';

    if (!app.isPackaged) {
        mainWindow.loadURL(devUrl);
        mainWindow.webContents.openDevTools();
    } else {
        mainWindow.loadFile(path.join(app.getAppPath(), 'dist/index.html'));
    }
}

function createWorkerWindow() {
    workerWindow = new BrowserWindow({
        show: false,
        webPreferences: {
            preload: app.isPackaged
                ? path.join(app.getAppPath(), 'dist-electron/preload/index.js')
                : path.join(__dirname, '../preload/index.js'),
            sandbox: false,
            nodeIntegration: false,
            contextIsolation: true,
            backgroundThrottling: false // CRITICAL: Prevent Chrome from slowing down hidden window
        },
    });

    const devUrl = 'http://127.0.0.1:5173';
    const url = app.isPackaged
        ? `file://${path.join(app.getAppPath(), 'dist/index.html')}?print=true`
        : `${devUrl}?print=true`;

    workerWindow.loadURL(url);

    workerWindow.on('closed', () => {
        workerWindow = null;
    });
}

app.whenReady().then(() => {
    initDatabase();

    ipcMain.handle('get-station-info', () => {
        const { getStationInfo } = require('./database');
        return getStationInfo();
    });



    createWindow();
    createWorkerWindow();

    // Initialize Managers
    scaleManager.init();

    // Initialize auto-updater
    initUpdater(mainWindow);
    // Refresh server version cache for pre-update compat checks
    refreshServerVersion().catch(() => { });

    // --- TEMPORARY VERIFICATION TRIGGER REMOVED ---
    // Default to station mode, or load from config if we had it. 
    // For now, default start is silent until UI sets mode.
    discoveryManager.setMode('station');
    serverStatusManager.startPolling();

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
    let printQueue: Promise<any> = Promise.resolve();

    ipcMain.handle('print-label', async (_, options) => {
        // Queue the print request to ensure sequential processing
        const result = await (printQueue = printQueue.then(async () => {
            const startTime = Date.now();
            const { silent, labelDoc, data, printerConfig, printerName } = options;

            // ── DIAGNOSTIC: Log what we received to understand routing ──
            log.info(`[print-label] Routing: protocol=${printerConfig?.protocol}, connection=${printerConfig?.connection}, name=${printerConfig?.name}`);

            // New Routing Logic: Use PrinterService for all native protocols (zpl, image/hybrid_zpl, tspl)
            // Fall through to legacy webContents.print() only for "browser" protocol.
            if (printerConfig && typeof printerConfig === 'object' && printerConfig.protocol !== 'browser') {
                try {
                    const { printerService } = await import('./printer/PrinterService');
                    await printerService.printLabel(printerConfig, labelDoc, data);
                    const duration = Date.now() - startTime;
                    log.info(`Printed via PrinterService (${printerConfig.protocol}) to ${printerConfig.name} in ${duration}ms`);
                    return true;
                } catch (e) {
                    log.error('PrinterService failed:', e);
                    return false;
                }
            }

            // IMAGE MODE: Use persistent worker window
            const targetPrinter = printerName || printerConfig?.driverName;
            log.info(`Image Mode Printing: Target=${targetPrinter || 'Default'}`);

            // Ensure window exists (should be created on app ready)
            if (!workerWindow || workerWindow.isDestroyed()) {
                log.info('Worker window missing, recreating...');
                createWorkerWindow();
            }

            return new Promise((resolve) => {
                const currentWorker = workerWindow!;



                const performPrint = () => {
                    const printOptions: any = {
                        silent: silent !== false,
                        printBackground: true,
                        margins: { marginType: 'none' }
                    };
                    if (targetPrinter) {
                        printOptions.deviceName = targetPrinter;
                    }

                    log.info(`Printing to device: ${printOptions.deviceName || 'default'} (Silent: ${silent !== false})`);
                    currentWorker.webContents.print(printOptions, (success, failureReason) => {
                        const duration = Date.now() - startTime;
                        if (success) {
                            log.info(`Print result: SUCCESS (Duration: ${duration}ms)`);
                        } else {
                            log.error(`Print result: FAILURE (Duration: ${duration}ms) Reason: ${failureReason}`);
                        }
                        resolve(success);
                    });
                };

                // One-time listener for this specific print job
                const readyHandler = (_event: any) => {
                    // console.log('Received ready-to-print from renderer');
                    ipcMain.removeListener('ready-to-print', readyHandler);
                    performPrint();
                };

                ipcMain.on('ready-to-print', readyHandler);

                // Wait for load if needed, otherwise send immediately
                const payload = { labelDoc, data };
                log.info(`[print-label] Sending payload to worker. Data keys: ${Object.keys(data).join(', ')}`);
                // log.info(`[print-label] Data sample: ${JSON.stringify(data).substring(0, 200)}...`);

                if (currentWorker.webContents.isLoading()) {
                    log.info('Worker is loading, waiting for finish...');
                    currentWorker.webContents.once('did-finish-load', () => {
                        currentWorker.webContents.send('print-data', payload);
                    });
                } else {
                    currentWorker.webContents.send('print-data', payload);
                }

                // Timeout safety
                setTimeout(() => {
                    ipcMain.removeListener('ready-to-print', readyHandler);
                    resolve(false);
                }, 15000); // 15s timeout
            });
        }).catch(err => {
            log.error('Print queue error:', err);
            return false;
        }));

        return result;
    });
});

ipcMain.handle('get-printers', async (event) => {
    const startTime = Date.now();
    log.info('[IPC] get-printers started');
    try {
        const win = BrowserWindow.fromWebContents(event.sender);
        const printers = await win?.webContents.getPrintersAsync() || [];
        log.info(`[IPC] get-printers finished in ${Date.now() - startTime}ms. Count: ${printers.length}`);
        return printers;
    } catch (e) {
        log.error(`[IPC] get-printers FAILED in ${Date.now() - startTime}ms:`, e);
        return [];
    }
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
    const { testConnectionFull } = await import('./sync');
    log.info(`Attempting to sync data with server: ${serverIp}`);
    const info = await testConnectionFull(serverIp);
    return info.online;
});

ipcMain.handle('get-server-status', () => {
    return serverStatusManager.getStatus();
});

// Printer Config Handlers
ipcMain.handle('get-printer-config', async () => {
    const { loadPrinterConfig } = await import('./config');
    return loadPrinterConfig();
});

ipcMain.on('save-printer-config', async (_, config) => {
    log.info('[IPC] save-printer-config started', {
        packProtocol: config.packPrinter?.protocol,
        boxProtocol: config.boxPrinter?.protocol,
        autoPrint: config.autoPrintOnStable
    });
    const startTime = Date.now();
    try {
        const { savePrinterConfig } = await import('./config');
        savePrinterConfig(config);

        // Reload printer service
        const { printerService } = await import('./printer/PrinterService');
        printerService.reloadConfig();

        // Broadcast update to all windows
        BrowserWindow.getAllWindows().forEach(win => {
            win.webContents.send('printer-config-updated', config);
        });

        // Restart polling to pick up new IP immediately if it changed
        serverStatusManager.startPolling();
        log.info(`[IPC] save-printer-config finished in ${Date.now() - startTime}ms`);
    } catch (e) {
        log.error(`[IPC] save-printer-config FAILED in ${Date.now() - startTime}ms:`, e);
    }
});

ipcMain.handle('test-print', async (_event, config) => {
    log.info('[IPC] test-print started', { protocol: config.protocol, name: config.name });
    const startTime = Date.now();

    if (config.protocol === 'browser') {
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
            log.info('[IPC] test-print: creating worker window');
            createWorkerWindow();
        }
        const currentWorker = workerWindow!;

        return new Promise((resolve) => {
            const readyHandler = (ev: any) => {
                if (ev.sender === currentWorker.webContents) {
                    ipcMain.removeListener('ready-to-print', readyHandler);
                    const printOptions: any = {
                        silent: false,
                        printBackground: true,
                        margins: { marginType: 'none' },
                        deviceName: config.driverName || ''
                    };
                    log.info('[IPC] test-print: calling webContents.print');
                    currentWorker.webContents.print(printOptions, (success) => {
                        log.info(`[IPC] test-print (image) finished in ${Date.now() - startTime}ms. Success: ${success}`);
                        resolve({ success });
                    });
                }
            };
            ipcMain.on('ready-to-print', readyHandler);
            currentWorker.webContents.send('print-data', { labelDoc: testDoc, data: testData });
        });
    }

    const { printerService } = await import('./printer/PrinterService');
    try {
        await printerService.testPrint(config);
        log.info(`[IPC] test-print (${config.protocol}) finished in ${Date.now() - startTime}ms`);
        return { success: true };
    } catch (error: any) {
        log.error(`[IPC] test-print FAILED in ${Date.now() - startTime}ms:`, error);
        return { success: false, message: error.message };
    }
});

// Database Viewer Handlers
ipcMain.handle('get-tables', async () => {
    const { getTables } = await import('./database');
    return getTables();
});

ipcMain.handle('get-all-labels', async () => {
    const { initDatabase } = await import('./database');
    const db = initDatabase();
    return db.prepare('SELECT * FROM labels').all();
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

ipcMain.handle('get-open-pallet-content', async () => {
    const { getOpenPalletContent } = await import('./database');
    return getOpenPalletContent();
});

ipcMain.handle('delete-pack', async (_, packId) => {
    const { deletePack } = await import('./database');
    return deletePack(packId);
});

ipcMain.handle('delete-box', async (_, boxId) => {
    const { deleteBox } = await import('./database');
    return deleteBox(boxId);
});

ipcMain.handle('get-latest-counters', async () => {
    const { getLatestCounters } = await import('./database');
    return getLatestCounters();
});

ipcMain.on('log-to-main', (_event, ...args) => {
    log.info('[Renderer Log]:', ...args);
});


ipcMain.on('renderer-ready', () => {
    serverStatusManager.notifyReady();
});

// --- Identity & Offline Sync Handlers ---

ipcMain.handle('get-identity', () => {
    const { loadIdentity } = require('./identity');
    return loadIdentity();
});

ipcMain.handle('import-identity-file', async () => {
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
    } catch (error: any) {
        console.error('Identity Import Error:', error);
        return { success: false, message: error.message };
    }
});

ipcMain.handle('offline-import', async () => {
    const { importOfflineUpdate } = require('./offline_sync');
    return await importOfflineUpdate();
});

ipcMain.handle('offline-export', async () => {
    const { exportOfflineData } = require('./offline_sync');
    return await exportOfflineData();
});

ipcMain.handle('get-next-sequence', (_, type) => {
    const { getNextSequence } = require('./sequence');
    try {
        return { success: true, number: getNextSequence(type) };
    } catch (error: any) {
        return { success: false, message: error.message };
    }
});

ipcMain.handle('reset-database', async () => {
    const { resetDatabase } = require('./database');
    const { deleteIdentity } = require('./identity');
    try {
        resetDatabase();
        deleteIdentity();
        return { success: true, message: 'Database reset successfully' };
    } catch (error: any) {
        console.error('Failed to reset database:', error);
        return { success: false, message: error.message };
    }
});

ipcMain.on('open-logs-folder', () => {
    const logsPath = path.join(app.getPath('userData'), 'logs');
    shell.openPath(logsPath);
});

ipcMain.on('quit-app', () => {
    app.quit();
});

// --- Updater IPC Handlers ---

ipcMain.handle('updater:get-version', () => app.getVersion());

ipcMain.handle('updater:check', async () => {
    return await checkForUpdates();
});

ipcMain.handle('updater:download', async () => {
    await downloadUpdate();
    return { success: true };
});

ipcMain.handle('updater:install', async () => {
    await installUpdate();
    return { success: true };
});

ipcMain.handle('updater:install-offline', async () => {
    const result = await dialog.showOpenDialog({
        title: 'Выберите установщик LabelPilot (.exe)',
        filters: [{ name: 'LabelPilot Installer', extensions: ['exe'] }],
        properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) {
        return { success: false, message: 'Отменено' };
    }
    return await installOfflineUpdate(result.filePaths[0]);
});

ipcMain.handle('updater:list-backups', async () => {
    return await getBackups();
});

ipcMain.handle('updater:rollback', async (_, backupId: string) => {
    return await rollbackToBackup(backupId);
});

ipcMain.handle('updater:refresh-server-version', async () => {
    await refreshServerVersion();
    return { success: true };
});

// Import and start Sync Server
import { startSyncServer } from './server';

// Register ipc handlers
startSyncServer((data) => {
    if (mainWindow) {
        mainWindow.webContents.send('sync-complete', { success: true, ...data });
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
