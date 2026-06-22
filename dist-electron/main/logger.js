"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_log_1 = __importDefault(require("electron-log"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
// Configure logging. In production keep file logs at 'info' and silence the console
// transport entirely — its string formatting + stdout writes are pure overhead on a
// 24/7 kiosk (and the per-print/IPC logs are high-frequency). Dev stays verbose.
const isPackaged = electron_1.app.isPackaged;
electron_log_1.default.transports.file.level = isPackaged ? 'info' : 'debug';
electron_log_1.default.transports.console.level = isPackaged ? false : 'debug';
// Customize log file location to ensure it's in a predictable place
electron_log_1.default.transports.file.resolvePathFn = () => path_1.default.join(electron_1.app.getPath('userData'), 'logs', 'main.log');
// Optional: Add some metadata to every log
electron_log_1.default.variables.process = 'Main';
electron_log_1.default.info('Logger initialized at:', electron_log_1.default.transports.file.getFile().path);
exports.default = electron_log_1.default;
