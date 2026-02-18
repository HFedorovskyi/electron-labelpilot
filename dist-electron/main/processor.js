"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processSyncData = processSyncData;
const identity_1 = require("./identity");
const database_1 = require("./database");
const config_1 = require("./config");
const i18n_1 = require("./i18n");
const logger_1 = __importDefault(require("./logger"));
const compatibility_1 = require("./updater/compatibility");
function extractIpFromUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.hostname;
    }
    catch (e) {
        return url.replace(/^https?:\/\//, '').split(/[:/]/)[0];
    }
}
/**
 * Handles incoming data from any sync source (Online or Offline).
 */
async function processSyncData(data) {
    const startTime = Date.now();
    logger_1.default.info(`Processor: Received ${data?.meta?.type || 'UNKNOWN'} sync data. Payload size: ${JSON.stringify(data.payload).length} bytes`);
    // 1. Basic Validation
    if (!data.station || !data.payload || !data.meta) {
        throw new Error('Invalid unified data format: Missing core sections (station, payload, or meta).');
    }
    // 1b. Compatibility check (Level 1 — offline .lps file)
    // This is the primary guard: if the server requires a newer client, block
    // the import BEFORE touching the database.
    const compatResult = (0, compatibility_1.checkSyncFileCompatibility)(data.meta.min_client_version);
    if (!compatResult.compatible) {
        throw new Error(compatResult.reason);
    }
    const currentIdentity = (0, identity_1.loadIdentity)();
    // 2. Identity Lock & Validation
    // Identity is strictly locked once set. 
    // The only way to change it is to use the "Reset Database" feature.
    if (currentIdentity && currentIdentity.station_uuid) {
        if (currentIdentity.station_uuid !== data.station.uuid ||
            currentIdentity.station_number !== String(data.station.number).padStart(2, '0')) {
            throw new Error((0, i18n_1.t)('error.identityLocked', {
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
        const printerConfig = (0, config_1.loadPrinterConfig)();
        printerConfig.serverIp = serverIp;
        (0, config_1.savePrinterConfig)(printerConfig);
        console.log(`Processor: Updated server IP to ${serverIp}`);
    }
    // 4. Update Station Identity (Database & Legacy Identity)
    (0, database_1.updateStationIdentity)({
        uuid: data.station.uuid,
        number: data.station.number,
        name: data.station.name,
        server_url: data.station.server_url,
        last_sync_time: data.meta.generated_at
    });
    const newIdentity = {
        station_uuid: data.station.uuid,
        station_number: String(data.station.number).padStart(2, '0'),
        station_name: data.station.name,
        server_url: data.station.server_url,
        last_sync_time: data.meta.generated_at
    };
    (0, identity_1.saveIdentity)(newIdentity);
    console.log('Processor: Station identity logic completed.');
    // 5. Update Database Tables
    await (0, database_1.importFullDump)(data.payload);
    // 5. If station_number was also inside the payload section for some reason, 
    // (legacy or dual-path), we handle it in database.ts importFullDump as well, 
    // but here we already updated it in identity.json.
    const endTime = Date.now();
    const duration = endTime - startTime;
    logger_1.default.info(`Processor: Finished processing ${data.meta.type} sync data in ${duration}ms.`);
    return {
        success: true,
        message: `${data.meta.type} processed successfully.`
    };
}
