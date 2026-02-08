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
    const db = initDatabase();

    // Log items with weights
    const nomRows = db.prepare('SELECT n.*, c.weight as portion_weight FROM nomenclature n LEFT JOIN container c ON n.portion_container_id = c.id LIMIT 5').all();
    console.log('Main Process: Nomenclature sample with join:', JSON.stringify(nomRows, null, 2));

    const containerRows = db.prepare('SELECT * FROM container LIMIT 5').all();
    console.log('Main Process: Container sample:', JSON.stringify(containerRows, null, 2));

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
    ipcMain.handle('print-label', async (_, options) => {
        const { silent, labelDoc, data } = options;

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

            // We need a simple HTML to mount the React component or just raw HTML
            // Since we already have LabelRenderer in the renderer, let's just send the HTML?
            // Or better: open a window, load a special "print" page that uses the same renderer.

            // For now, let's use a simpler approach: 
            // The sender window already has the rendered content? No, it has the preview.


            // Actually, let's just reuse the existing window for printing if possible, 
            // but the user wants it to be fast and not hold up the flow.

            // REALISTIC APPROACH: 
            // Open a hidden window that loads the same app but with a ?print=true route.
            const devUrl = 'http://localhost:5173';
            const url = app.isPackaged
                ? `file://${path.join(__dirname, '../dist/index.html')}?print=true`
                : `${devUrl}?print=true`;

            printWindow.loadURL(url);

            printWindow.webContents.on('did-finish-load', () => {
                printWindow.webContents.send('print-data', { labelDoc, data });
            });

            ipcMain.once('ready-to-print', (e) => {
                if (e.sender === printWindow.webContents) {
                    printWindow.webContents.print({
                        silent: silent !== false,
                        printBackground: true,
                        margins: { marginType: 'none' }
                    }, (success) => {
                        printWindow.close();
                        resolve(success);
                    });
                }
            });
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
