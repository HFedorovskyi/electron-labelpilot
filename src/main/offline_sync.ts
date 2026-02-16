import fs from 'fs';
import { dialog } from 'electron';
import { encrypt, decrypt } from './encryption';
import { getExportData } from './database';
import { loadIdentity } from './identity';

export async function importOfflineUpdate(): Promise<{ success: boolean; message: string }> {
    const { processSyncData } = require('./processor');
    try {
        const result = await dialog.showOpenDialog({
            title: 'Select Update File (.lps)',
            filters: [{ name: 'LabelPilot Update', extensions: ['lps'] }],
            properties: ['openFile']
        });

        if (result.canceled || result.filePaths.length === 0) {
            return { success: false, message: 'Cancelled' };
        }

        const filePath = result.filePaths[0];
        const content = fs.readFileSync(filePath);

        // Decrypt
        const data = decrypt(content);

        // Unified Processing
        return await processSyncData(data);
    } catch (error: any) {
        console.error('Offline Import Error:', error);
        return { success: false, message: error.message };
    }
}

export async function exportOfflineData(): Promise<{ success: boolean; message: string }> {
    try {
        const identity = loadIdentity();
        const stationNum = identity?.station_number || '00';
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const filename = `report_${stationNum}_${dateStr}.lpr`;

        const result = await dialog.showSaveDialog({
            title: 'Export Data (.lpr)',
            defaultPath: filename,
            filters: [{ name: 'LabelPilot Report', extensions: ['lpr'] }]
        });

        if (result.canceled || !result.filePath) {
            return { success: false, message: 'Cancelled' };
        }

        // Get Data
        const data = getExportData();

        // Add Identity Info
        const payload = {
            ...data,
            station_identity: identity
        };

        // Encrypt
        const encrypted = encrypt(payload);

        // Save
        fs.writeFileSync(result.filePath, encrypted);

        return { success: true, message: 'Data exported successfully' };
    } catch (error: any) {
        console.error('Offline Export Error:', error);
        return { success: false, message: error.message };
    }
}
