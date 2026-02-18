import axios from 'axios';
import { checkOnlineCompatibility } from './updater/compatibility';
import log from './logger';

export interface ServerInfo {
    online: boolean;
    serverVersion?: string;
    minClientVersion?: string;
    /** True if the current client version satisfies the server's requirement */
    compatible: boolean;
    compatibilityReason?: string;
}

export interface SyncData {
    barcodes?: any[];
    barcode_templates?: any[];
    labels?: any[];
    label_templates?: any[];
    containers?: any[];
    packs?: any[];
    nomenclature?: any[];
    nomenclatures?: any[];
    station_number?: number;
}

/**
 * testConnection: Lightweight server check with version info.
 * Uses /api/v1/stations/ping/ and returns full ServerInfo.
 * The server should respond with: { status, server_version, min_client_version }
 */
export async function testConnectionFull(serverIp: string): Promise<ServerInfo> {
    if (!serverIp) {
        return { online: false, compatible: true };
    }

    const baseUrl = `http://${serverIp}:8000/api/v1`;

    try {
        const { getClientUUID } = require('./database');
        const uuid = getClientUUID();

        if (!uuid) {
            log.info('Connection Test: Station is unconfigured (no UUID). Skipping ping.');
            return { online: false, compatible: true };
        }

        log.info(`Connection Test: Pinging ${baseUrl}/stations/ping/?station_uuid=${uuid}`);

        const response = await axios.get(`${baseUrl}/stations/ping/`, {
            params: { station_uuid: uuid },
            timeout: 3000
        });

        if (response.data && response.data.status === 'online') {
            const serverVersion: string | undefined = response.data.server_version;
            const minClientVersion: string | undefined = response.data.min_client_version;

            // Level 2 compatibility check
            const compatResult = checkOnlineCompatibility(minClientVersion);

            if (!compatResult.compatible) {
                log.warn(`Connection Test: Client is outdated. ${compatResult.reason}`);
            } else {
                log.info(`Connection Test: SUCCESS. Server v${serverVersion ?? 'unknown'}`);
            }

            return {
                online: true,
                serverVersion,
                minClientVersion,
                compatible: compatResult.compatible,
                compatibilityReason: compatResult.reason,
            };
        }

        log.warn('Connection Test: Unexpected response format:', response.data);
        return { online: false, compatible: true };
    } catch (err: any) {
        if (err.response) {
            log.error(`Connection Test Server Error: ${err.response.status}`);
        } else {
            log.error('Connection Test Error:', err.message);
        }
        return { online: false, compatible: true };
    }
}

/**
 * Legacy boolean wrapper — keeps existing callers working unchanged.
 */
export async function testConnection(serverIp: string): Promise<boolean> {
    const info = await testConnectionFull(serverIp);
    return info.online;
}
