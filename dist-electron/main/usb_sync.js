"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.exportDataToUSB = exportDataToUSB;
exports.importDataFromUSB = importDataFromUSB;
const fs_1 = __importDefault(require("fs"));
const crypto_1 = __importDefault(require("crypto"));
const SECRET_KEY = 'labelpilot-offline-sync-secret'; // Should be env var in production
function exportDataToUSB(filePath, data) {
    try {
        const jsonContent = JSON.stringify(data);
        const checksum = crypto_1.default.createHmac('sha256', SECRET_KEY)
            .update(jsonContent)
            .digest('hex');
        const payload = {
            data: data,
            checksum: checksum
        };
        fs_1.default.writeFileSync(filePath, JSON.stringify(payload, null, 2));
        return { success: true };
    }
    catch (err) {
        console.error("Export failed", err);
        return { success: false, error: err.message };
    }
}
function importDataFromUSB(filePath) {
    try {
        if (!fs_1.default.existsSync(filePath)) {
            throw new Error('File not found');
        }
        const fileContent = fs_1.default.readFileSync(filePath, 'utf-8');
        const payload = JSON.parse(fileContent);
        // Verify Checksum
        const calculatedChecksum = crypto_1.default.createHmac('sha256', SECRET_KEY)
            .update(JSON.stringify(payload.data))
            .digest('hex');
        if (calculatedChecksum !== payload.checksum) {
            throw new Error('Security check failed: File might be tampered');
        }
        return { success: true, data: payload.data };
    }
    catch (error) {
        console.error('Import failed:', error);
        return { success: false, error: error.message };
    }
}
