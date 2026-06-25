import fs from 'fs';
import { randomUUID } from 'crypto';
import { dialog } from 'electron';
import { encrypt, decrypt } from './encryption';
import { getExportData } from './database';
import { loadIdentity } from './identity';
import { clearDemoFlag } from './demo_flag';

/**
 * Build ONE encrypted .lpr report — the identical payload for both transports (online POST
 * to upload_report, or USB export). Lean on purpose: only station_uuid + printed_labels +
 * logs (the server ignores packs/boxes/pallets), so 10-20 stations stay cheap on the LAN.
 * Pass a since-watermark for a delta (auto reports); omit it for a full snapshot (USB).
 */
export function buildReportPayload(opts: { sincePackId?: number; sinceErrorId?: number; sinceDeletedAt?: string; sinceDeletedId?: number } = {}) {
    const identity = loadIdentity();
    const data = getExportData(opts);
    const payload = {
        station_uuid: identity?.station_uuid,
        station_identity: identity,
        printed_labels: data.printed_labels,
        deleted_labels: data.deleted_labels,
        logs: data.logs,
        report_id: randomUUID(),
        generated_at: data.generated_at,
    };
    return {
        blob: encrypt(payload),
        maxPackId: data.maxPackId,
        maxErrorId: data.maxErrorId,
        maxDeletedAt: data.maxDeletedAt,
        maxDeletedId: data.maxDeletedId,
        labelCount: data.printed_labels.length,
        deletedCount: data.deleted_labels.length,
        logCount: data.logs.length,
        hasData: data.printed_labels.length > 0 || data.deleted_labels.length > 0 || data.logs.length > 0,
    };
}

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
        const syncResult = await processSyncData(data);
        // A successful offline (.lps) import is a REAL provisioning — leave demo
        // mode. (Not done inside processSyncData: demo seeding uses that path too.)
        if (syncResult.success) {
            clearDemoFlag();
        }
        return syncResult;
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

        // Manual USB export = a FULL snapshot (no watermark) — the escape hatch when the
        // server has been unreachable. The server dedupes on unique_id, so re-exporting
        // labels that were already auto-sent online can never double-count.
        const { blob } = buildReportPayload();
        fs.writeFileSync(result.filePath, blob);

        return { success: true, message: 'Data exported successfully' };
    } catch (error: any) {
        console.error('Offline Export Error:', error);
        return { success: false, message: error.message };
    }
}
