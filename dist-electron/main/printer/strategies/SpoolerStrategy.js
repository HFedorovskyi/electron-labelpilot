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
Object.defineProperty(exports, "__esModule", { value: true });
exports.SpoolerStrategy = void 0;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const electron_1 = require("electron");
class SpoolerStrategy {
    connected = false;
    config = null;
    helperPath = '';
    constructor() {
        this.resolveHelperPath();
    }
    resolveHelperPath() {
        // Handle both dev (relative to cwd) and prod (resourcesPath)
        const possiblePaths = [
            path.join(process.cwd(), 'resources', 'printer', 'RawPrint.exe'),
            path.join(process.resourcesPath, 'printer', 'RawPrint.exe'),
            // Fallback for some dev environments where resources might be copied differently
            path.join(electron_1.app.getAppPath(), '..', 'resources', 'printer', 'RawPrint.exe')
        ];
        for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
                this.helperPath = p;
                break;
            }
        }
        if (!this.helperPath) {
            console.warn('RawPrint.exe not found in:', possiblePaths);
        }
        else {
            console.log('SpoolerStrategy using helper:', this.helperPath);
        }
    }
    async connect(config) {
        this.config = config;
        this.connected = true;
        // No real persistent connection for spooler, just validation
        if (!config.driverName) {
            throw new Error('Driver name missing for Windows Spooler printer');
        }
        if (!this.helperPath) {
            throw new Error('RawPrint.exe helper not found. Cannot print to Spooler.');
        }
    }
    async disconnect() {
        this.connected = false;
    }
    async send(data) {
        if (!this.connected || !this.config || !this.config.driverName) {
            throw new Error('Printer not connected or configured');
        }
        // 1. Write data to temp file
        const tempId = Math.random().toString(36).substring(7);
        const tempPath = path.join(os.tmpdir(), `labelpilot_${tempId}.bin`);
        await fs.promises.writeFile(tempPath, data);
        try {
            // 2. Invoke Helper
            await this.invokeHelper(this.config.driverName, tempPath);
        }
        finally {
            // 3. Cleanup
            fs.unlink(tempPath, (err) => { if (err)
                console.error('Failed to cleanup temp print file:', err); });
        }
    }
    invokeHelper(printerName, filePath) {
        return new Promise((resolve, reject) => {
            console.log(`Spawning: ${this.helperPath} "${printerName}" "${filePath}"`);
            const child = (0, child_process_1.spawn)(this.helperPath, [printerName, filePath]);
            let stderr = '';
            child.stderr.on('data', (d) => stderr += d.toString());
            child.on('close', (code) => {
                if (code === 0) {
                    resolve();
                }
                else {
                    reject(new Error(`RawPrint failed with code ${code}: ${stderr}`));
                }
            });
            child.on('error', (err) => {
                reject(err);
            });
        });
    }
    isConnected() {
        return this.connected; // Virtual connection
    }
}
exports.SpoolerStrategy = SpoolerStrategy;
