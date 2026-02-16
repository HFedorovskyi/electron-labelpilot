import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { decrypt } from './encryption';

const IDENTITY_FILE = 'identity.json';

export interface StationIdentity {
    station_number: string; // 2 digits, e.g. "01"
    station_uuid: string;
    station_name: string;
    server_url?: string;
    last_sync_time?: string;
}

export function getIdentityPath(): string {
    return path.join(app.getPath('userData'), IDENTITY_FILE);
}

export function loadIdentity(): StationIdentity | null {
    const { getStationIdentity } = require('./database');
    try {
        const dbStation = getStationIdentity();
        if (dbStation) {
            return {
                station_uuid: dbStation.uuid,
                station_number: String(dbStation.number || '0').padStart(2, '0'),
                station_name: dbStation.name || '',
                server_url: dbStation.server_url || '',
                last_sync_time: dbStation.last_sync_time || ''
            };
        }
    } catch (e) {
        console.warn('Failed to load identity from database, falling back to JSON:', e);
    }

    const identityPath = getIdentityPath();
    try {
        if (fs.existsSync(identityPath)) {
            const data = fs.readFileSync(identityPath, 'utf-8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Failed to load identity JSON:', error);
    }
    return null;
}

export function saveIdentity(identity: StationIdentity): void {
    const identityPath = getIdentityPath();
    try {
        fs.writeFileSync(identityPath, JSON.stringify(identity, null, 2), 'utf-8');
    } catch (error) {
        console.error('Failed to save identity:', error);
        throw error;
    }
}

export async function importIdentityFile(filePath: string): Promise<StationIdentity> {
    const { processSyncData } = require('./processor');
    try {
        const fileContent = fs.readFileSync(filePath);
        // Expecting the file to be encrypted
        const data = decrypt(fileContent);

        // Use unified processor
        await processSyncData(data);

        const updated = loadIdentity();
        if (!updated) throw new Error('Failed to load identity after import');
        return updated;
    } catch (error) {
        console.error('Failed to import identity file:', error);
        throw error;
    }
}

export function deleteIdentity(): void {
    const identityPath = getIdentityPath();
    if (fs.existsSync(identityPath)) {
        fs.unlinkSync(identityPath);
    }
}
