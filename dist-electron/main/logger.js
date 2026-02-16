"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_log_1 = __importDefault(require("electron-log"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
// Configure logging
electron_log_1.default.transports.file.level = 'debug';
electron_log_1.default.transports.console.level = 'debug';
// Customize log file location to ensure it's in a predictable place
electron_log_1.default.transports.file.resolvePathFn = () => path_1.default.join(electron_1.app.getPath('userData'), 'logs', 'main.log');
// Optional: Add some metadata to every log
electron_log_1.default.variables.process = 'Main';
electron_log_1.default.info('Logger initialized at:', electron_log_1.default.transports.file.getFile().path);
exports.default = electron_log_1.default;
