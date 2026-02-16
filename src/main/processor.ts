import { loadIdentity, saveIdentity } from './identity';
import type { StationIdentity } from './identity';
import { importFullDump, updateStationIdentity } from './database';
import { loadPrinterConfig, savePrinterConfig } from './config';
import { t } from './i18n';
import log from './logger';

function extractIpFromUrl(url: string): string {
    try {
        const parsed = new URL(url);
        return parsed.hostname;
    } catch (e) {
        return url.replace(/^https?:\/\//, '').split(/[:/]/)[0];
    }
}

export interface UnifiedSyncData {
    // ...
}

/**
 * Handles incoming data from any sync source (Online or Offline).
 */
export async function processSyncData(data: any): Promise<{ success: boolean; message: string }> {
    const startTime = Date.now();
    log.info(`Processor: Received ${data?.meta?.type || 'UNKNOWN'} sync data. Payload size: ${JSON.stringify(data.payload).length} bytes`);

    // 1. Basic Validation
    if (!data.station || !data.payload || !data.meta) {
        throw new Error('Invalid unified data format: Missing core sections (station, payload, or meta).');
    }

    const currentIdentity = loadIdentity();

    // 2. Identity Lock & Validation
    // Identity is strictly locked once set. 
    // The only way to change it is to use the "Reset Database" feature.
    if (currentIdentity && currentIdentity.station_uuid) {
        if (currentIdentity.station_uuid !== data.station.uuid ||
            currentIdentity.station_number !== String(data.station.number).padStart(2, '0')) {
            throw new Error(t('error.identityLocked', {
                uuid: currentIdentity.station_uuid,
                number: currentIdentity.station_number,
                newUuid: data.station.uuid,
                newNumber: String(data.station.number)
            }));
        }
    }

    // 3. Extract and Update Server IP in Config
    const serverIp = extractIpFromUrl(data.station.server_url);
    if (serverIp) {
        const printerConfig = loadPrinterConfig();
        printerConfig.serverIp = serverIp;
        savePrinterConfig(printerConfig);
        console.log(`Processor: Updated server IP to ${serverIp}`);
    }

    // 4. Update Station Identity (Database & Legacy Identity)
    updateStationIdentity({
        uuid: data.station.uuid,
        number: data.station.number,
        name: data.station.name,
        server_url: data.station.server_url,
        last_sync_time: data.meta.generated_at
    });

    const newIdentity: StationIdentity = {
        station_uuid: data.station.uuid,
        station_number: String(data.station.number).padStart(2, '0'),
        station_name: data.station.name,
        server_url: data.station.server_url,
        last_sync_time: data.meta.generated_at
    };
    saveIdentity(newIdentity);
    console.log('Processor: Station identity logic completed.');

    // 5. Update Database Tables
    await importFullDump(data.payload);

    // 5. If station_number was also inside the payload section for some reason, 
    // (legacy or dual-path), we handle it in database.ts importFullDump as well, 
    // but here we already updated it in identity.json.

    const endTime = Date.now();
    const duration = endTime - startTime;
    log.info(`Processor: Finished processing ${data.meta.type} sync data in ${duration}ms.`);

    return {
        success: true,
        message: `${data.meta.type} processed successfully.`
    };
}
