"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OffscreenGenerator = exports.printNative = exports.initOffscreenWindow = void 0;
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const logger_1 = __importDefault(require("../logger"));
let offscreenWindow = null;
let renderPromiseResolve = null;
// Initialize the offscreen window (Singleton)
const initOffscreenWindow = async () => {
    if (offscreenWindow && !offscreenWindow.isDestroyed())
        return;
    logger_1.default.info('[Offscreen] Initializing offscreen window...');
    offscreenWindow = new electron_1.BrowserWindow({
        show: false, // Must be hidden
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path_1.default.join(__dirname, '../../preload/index.js'),
            backgroundThrottling: false, // Important: prevent Chrome from throttling hidden window
        }
    });
    // Load Renderer with ?render=true flag
    if (electron_1.app.isPackaged) {
        // Use loadURL with file:// protocol, exactly like workerWindow
        const indexPath = path_1.default.join(electron_1.app.getAppPath(), 'dist/index.html');
        // Windows paths need to be normalized for URL
        const url = `file://${indexPath}?render=true`;
        logger_1.default.info(`[Offscreen] Loading URL: ${url}`);
        await offscreenWindow.loadURL(url);
    }
    else {
        const url = process.env['VITE_DEV_SERVER_URL'];
        await offscreenWindow.loadURL(`${url}?render=true`);
    }
    // --- IPC Event Handlers ---
    // 1. Renderer tells us it's mounted and ready to receive commands
    electron_1.ipcMain.on('print-renderer-mounted', (event) => {
        const webContents = event.sender;
        if (offscreenWindow && offscreenWindow.webContents.id === webContents.id) {
            logger_1.default.info('[Offscreen] Renderer mounted and ready');
        }
    });
    // 2. Renderer tells us it finished rendering the label
    electron_1.ipcMain.on('print-render-ready', (event) => {
        const webContents = event.sender;
        if (offscreenWindow && offscreenWindow.webContents.id === webContents.id) {
            logger_1.default.info('[Offscreen] Label rendered, resolving promise');
            if (renderPromiseResolve) {
                renderPromiseResolve();
                renderPromiseResolve = null;
            }
        }
    });
    offscreenWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
        logger_1.default.error(`[Offscreen] Failed to load: ${errorDescription} (${errorCode})`);
    });
    offscreenWindow.on('closed', () => {
        offscreenWindow = null;
    });
};
exports.initOffscreenWindow = initOffscreenWindow;
/**
 * Perform a native browser print on the offscreen window.
 * Useful for "Driver Mode" where we want to use the Windows Spooler but with pixel-perfect accuracy.
 */
const printNative = async (doc, data, printerName) => {
    logger_1.default.info(`[Offscreen] Native Print request for printer: ${printerName || 'default'}`);
    if (!offscreenWindow || offscreenWindow.isDestroyed()) {
        await (0, exports.initOffscreenWindow)();
    }
    if (!offscreenWindow)
        throw new Error('Failed to create offscreen window');
    // Setup completion promise
    const completionPromise = new Promise((resolve) => {
        renderPromiseResolve = resolve;
    });
    // Send 'print-render-request'
    offscreenWindow.webContents.send('print-render-request', {
        doc,
        data,
        preview: false
    });
    // Wait for 'print-render-ready'
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Render timeout')), 5000));
    await Promise.race([completionPromise, timeoutPromise]);
    // Perform print
    return new Promise((resolve) => {
        const printOptions = {
            silent: true,
            printBackground: true,
            margins: { marginType: 'none' }
        };
        if (printerName) {
            printOptions.deviceName = printerName;
        }
        logger_1.default.info(`[Offscreen] Calling webContents.print to: ${printOptions.deviceName || 'default'}`);
        offscreenWindow.webContents.print(printOptions, (success, failureReason) => {
            if (success) {
                logger_1.default.info('[Offscreen] Native print success');
            }
            else {
                logger_1.default.error(`[Offscreen] Native print failure: ${failureReason}`);
            }
            resolve(success);
        });
    });
};
exports.printNative = printNative;
class OffscreenGenerator {
    async generate(doc, data, _options) {
        const t0 = Date.now();
        // Ensure window exists
        if (!offscreenWindow || offscreenWindow.isDestroyed()) {
            await (0, exports.initOffscreenWindow)();
        }
        if (!offscreenWindow)
            throw new Error('Failed to create offscreen window');
        // Resize window to match label dimensions EXACTLY
        const width = doc.canvas.width;
        const height = doc.canvas.height;
        offscreenWindow.setContentSize(width, height);
        // Send data to renderer
        logger_1.default.info(`[Offscreen] Sending label data to renderer. Size: ${width}x${height}`);
        // Setup completion promise
        const completionPromise = new Promise((resolve) => {
            renderPromiseResolve = resolve;
        });
        // Send 'print-render-request'
        offscreenWindow.webContents.send('print-render-request', {
            doc,
            data,
            preview: false
        });
        // Wait for 'print-render-ready' (with timeout)
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Render timeout')), 5000));
        await Promise.race([completionPromise, timeoutPromise]);
        // Capture page as image
        const image = await offscreenWindow.webContents.capturePage({
            x: 0, y: 0, width, height
        });
        const finishTime = Date.now();
        logger_1.default.info(`[Offscreen] Rendered and captured in ${finishTime - t0}ms`);
        // Convert image to ZPL (^GFA)
        const bitmap = image.toBitmap(); // Buffer containing RGBA pixels
        // Electron NativeImage bitmap usually is BGRA or RGBA (Platform dependent, but usually 32-bit)
        // Convert to Monochrome
        const mono = this.rgbaToMono(new Uint8ClampedArray(bitmap), width, height);
        // Compress to Hex
        const zplHex = this.compressZplRLE(mono, Math.ceil(width / 8), height);
        const totalBytes = Math.ceil(width / 8) * height;
        const bytesPerRow = Math.ceil(width / 8);
        // ZPL Command
        const zpl = `
^XA
^FO0,0^GFA,${totalBytes},${totalBytes},${bytesPerRow},${zplHex}^FS
^XZ`;
        logger_1.default.info(`[Offscreen] Generated ZPL in ${Date.now() - finishTime}ms`);
        return Buffer.from(zpl);
    }
    // --- Helpers (Adapted from CanvasBitmapGenerator) ---
    rgbaToMono(rgba, width, height) {
        const mono = new Uint8Array(Math.ceil(width / 8) * height);
        for (let row = 0; row < height; row++) {
            const monoRowOffset = row * Math.ceil(width / 8);
            for (let col = 0; col < width; col++) {
                const idx = (row * width + col) * 4;
                // Check bounds
                if (idx + 2 >= rgba.length)
                    break;
                const r = rgba[idx];
                const g = rgba[idx + 1];
                const b = rgba[idx + 2];
                // alpha = rgba[idx + 3];
                // Luminance calculation
                const lum = (r * 77 + g * 150 + b * 29) >> 8;
                // Threshold: <= 180 is BLACK (print), > 180 is WHITE (no print)
                if (lum <= 180) {
                    mono[monoRowOffset + (col >> 3)] |= (0x80 >> (col & 7));
                }
            }
        }
        return mono;
    }
    compressZplRLE(mono, bytesPerRow, height) {
        let result = '';
        let prevRowHex = '';
        for (let row = 0; row < height; row++) {
            const offset = row * bytesPerRow;
            const rowBytes = mono.subarray(offset, offset + bytesPerRow);
            let rowHex = '';
            for (let i = 0; i < rowBytes.length; i++) {
                rowHex += rowBytes[i].toString(16).padStart(2, '0').toUpperCase();
            }
            if (row > 0 && rowHex === prevRowHex) {
                result += ':';
                continue;
            }
            if (rowBytes.every(b => b === 0)) {
                result += ',';
                prevRowHex = rowHex;
                continue;
            }
            if (rowBytes.every(b => b === 0xFF)) {
                result += '!';
                prevRowHex = rowHex;
                continue;
            }
            result += this.compressRowRLE(rowHex);
            prevRowHex = rowHex;
        }
        return result;
    }
    compressRowRLE(hex) {
        let result = '';
        let i = 0;
        while (i < hex.length) {
            const ch = hex[i];
            let count = 1;
            while (i + count < hex.length && hex[i + count] === ch)
                count++;
            if (count >= 2)
                result += this.encodeRepeatCount(count) + ch;
            else
                result += ch;
            i += count;
        }
        return result;
    }
    encodeRepeatCount(count) {
        let result = '';
        while (count >= 20) {
            const highMultiple = Math.min(Math.floor(count / 20), 20);
            result += String.fromCharCode('g'.charCodeAt(0) + highMultiple - 1);
            count -= highMultiple * 20;
        }
        if (count >= 1) {
            result += String.fromCharCode('G'.charCodeAt(0) + count - 1);
        }
        return result;
    }
}
exports.OffscreenGenerator = OffscreenGenerator;
