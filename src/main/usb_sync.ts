import fs from 'fs';
import crypto from 'crypto';

const SECRET_KEY = 'labelpilot-offline-sync-secret'; // Should be env var in production

interface SyncData {
    products: any[];
    templates: any[];
    timestamp: string;
}

export function exportDataToUSB(filePath: string, data: SyncData) {
    try {
        const jsonContent = JSON.stringify(data);
        const checksum = crypto.createHmac('sha256', SECRET_KEY)
            .update(jsonContent)
            .digest('hex');

        const payload = {
            data: data,
            checksum: checksum
        };

        fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
        return { success: true };
    } catch (err: any) {
        console.error("Export failed", err);
        return { success: false, error: err.message };
    }
}

export function importDataFromUSB(filePath: string): { success: boolean, data?: SyncData, error?: string } {
    try {
        if (!fs.existsSync(filePath)) {
            throw new Error('File not found');
        }
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const payload = JSON.parse(fileContent);

        // Verify Checksum
        const calculatedChecksum = crypto.createHmac('sha256', SECRET_KEY)
            .update(JSON.stringify(payload.data))
            .digest('hex');

        if (calculatedChecksum !== payload.checksum) {
            throw new Error('Security check failed: File might be tampered');
        }

        return { success: true, data: payload.data };
    } catch (error: any) {
        console.error('Import failed:', error);
        return { success: false, error: error.message };
    }
}
