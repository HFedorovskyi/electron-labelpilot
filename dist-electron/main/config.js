"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getConfigPath = getConfigPath;
exports.loadScaleConfig = loadScaleConfig;
exports.saveScaleConfig = saveScaleConfig;
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const CONFIG_FILE = 'scale-config.json';
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
