"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getConfigPath = getConfigPath;
exports.loadScaleConfig = loadScaleConfig;
exports.saveScaleConfig = saveScaleConfig;
exports.getNumberingConfigPath = getNumberingConfigPath;
exports.loadNumberingConfig = loadNumberingConfig;
exports.saveNumberingConfig = saveNumberingConfig;
exports.getPrinterConfigPath = getPrinterConfigPath;
exports.loadPrinterConfig = loadPrinterConfig;
exports.savePrinterConfig = savePrinterConfig;
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const CONFIG_FILE = 'scale-config.json';
const NUMBERING_CONFIG_FILE = 'numbering-config.json';
const PRINTER_CONFIG_FILE = 'printer-config.json';
const DEFAULT_CONFIG = {
    type: 'simulator',
    protocolId: 'simulator',
    pollingInterval: 500,
    stabilityCount: 5
};
function getConfigPath() {
    return path_1.default.join(electron_1.app.getPath('userData'), CONFIG_FILE);
}
function loadScaleConfig() {
    const configPath = getConfigPath();
    try {
        if (fs_1.default.existsSync(configPath)) {
            const data = fs_1.default.readFileSync(configPath, 'utf-8');
            return { ...DEFAULT_CONFIG, ...JSON.parse(data) };
        }
    }
    catch (error) {
        console.error('Failed to load scale config:', error);
    }
    return DEFAULT_CONFIG;
}
function saveScaleConfig(config) {
    const configPath = getConfigPath();
    try {
        fs_1.default.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    }
    catch (error) {
        console.error('Failed to save scale config:', error);
    }
}
const DEFAULT_NUMBERING_CONFIG = {
    unit: { enabled: false, length: 3, prefix: '' },
    box: { enabled: false, length: 3, prefix: '' },
    pallet: { enabled: false, length: 3, prefix: '' }
};
function getNumberingConfigPath() {
    return path_1.default.join(electron_1.app.getPath('userData'), NUMBERING_CONFIG_FILE);
}
function loadNumberingConfig() {
    const configPath = getNumberingConfigPath();
    try {
        if (fs_1.default.existsSync(configPath)) {
            const data = fs_1.default.readFileSync(configPath, 'utf-8');
            return { ...DEFAULT_NUMBERING_CONFIG, ...JSON.parse(data) };
        }
    }
    catch (error) {
        console.error('Failed to load numbering config:', error);
    }
    return DEFAULT_NUMBERING_CONFIG;
}
function saveNumberingConfig(config) {
    const configPath = getNumberingConfigPath();
    try {
        fs_1.default.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    }
    catch (error) {
        console.error('Failed to save numbering config:', error);
    }
}
const DEFAULT_PRINTER_CONFIG = {
    packPrinter: '',
    boxPrinter: '',
    autoPrintOnStable: false,
    serverIp: ''
};
function getPrinterConfigPath() {
    return path_1.default.join(electron_1.app.getPath('userData'), PRINTER_CONFIG_FILE);
}
function loadPrinterConfig() {
    const configPath = getPrinterConfigPath();
    try {
        if (fs_1.default.existsSync(configPath)) {
            const data = fs_1.default.readFileSync(configPath, 'utf-8');
            return { ...DEFAULT_PRINTER_CONFIG, ...JSON.parse(data) };
        }
    }
    catch (error) {
        console.error('Failed to load printer config:', error);
    }
    return DEFAULT_PRINTER_CONFIG;
}
function savePrinterConfig(config) {
    const configPath = getPrinterConfigPath();
    try {
        fs_1.default.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    }
    catch (error) {
        console.error('Failed to save printer config:', error);
    }
}
