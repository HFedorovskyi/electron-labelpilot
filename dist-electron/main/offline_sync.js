"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.importOfflineUpdate = importOfflineUpdate;
exports.exportOfflineData = exportOfflineData;
const fs_1 = __importDefault(require("fs"));
const electron_1 = require("electron");
const encryption_1 = require("./encryption");
const database_1 = require("./database");
const identity_1 = require("./identity");
async function importOfflineUpdate() {
    const { processSyncData } = require('./processor');
    try {
        const result = await electron_1.dialog.showOpenDialog({
            title: 'Select Update File (.lps)',
            filters: [{ name: 'LabelPilot Update', extensions: ['lps'] }],
            properties: ['openFile']
        });
        if (result.canceled || result.filePaths.length === 0) {
            return { success: false, message: 'Cancelled' };
        }
        const filePath = result.filePaths[0];
        const content = fs_1.default.readFileSync(filePath);
        // Decrypt
        const data = (0, encryption_1.decrypt)(content);
        // Unified Processing
        return await processSyncData(data);
    }
    catch (error) {
        console.error('Offline Import Error:', error);
        return { success: false, message: error.message };
    }
}
async function exportOfflineData() {
    try {
        const identity = (0, identity_1.loadIdentity)();
        const stationNum = identity?.station_number || '00';
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const filename = `report_${stationNum}_${dateStr}.lpr`;
        const result = await electron_1.dialog.showSaveDialog({
            title: 'Export Data (.lpr)',
            defaultPath: filename,
            filters: [{ name: 'LabelPilot Report', extensions: ['lpr'] }]
        });
        if (result.canceled || !result.filePath) {
            return { success: false, message: 'Cancelled' };
        }
        // Get Data
        const data = (0, database_1.getExportData)();
        // Add Identity Info
        const payload = {
            ...data,
            station_identity: identity
        };
        // Encrypt
        const encrypted = (0, encryption_1.encrypt)(payload);
        // Save
        fs_1.default.writeFileSync(result.filePath, encrypted);
        return { success: true, message: 'Data exported successfully' };
    }
    catch (error) {
        console.error('Offline Export Error:', error);
        return { success: false, message: error.message };
    }
}
