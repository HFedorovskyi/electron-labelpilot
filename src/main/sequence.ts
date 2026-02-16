import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { loadIdentity } from './identity';
import { loadNumberingConfig } from './config';

const SEQUENCE_FILE = 'sequence-store.json';

interface SequenceStore {
    unit: number;
    box: number;
    pallet: number;
}

const DEFAULT_SEQUENCE: SequenceStore = {
    unit: 0,
    box: 0,
    pallet: 0
};

function getSequencePath(): string {
    return path.join(app.getPath('userData'), SEQUENCE_FILE);
}

function loadSequenceStore(): SequenceStore {
    const seqPath = getSequencePath();
    try {
        if (fs.existsSync(seqPath)) {
            const data = fs.readFileSync(seqPath, 'utf-8');
            return { ...DEFAULT_SEQUENCE, ...JSON.parse(data) };
        }
    } catch (error) {
        console.error('Failed to load sequence store:', error);
    }
    return DEFAULT_SEQUENCE;
}

function saveSequenceStore(store: SequenceStore): void {
    const seqPath = getSequencePath();
    try {
        fs.writeFileSync(seqPath, JSON.stringify(store, null, 2), 'utf-8');
    } catch (error) {
        console.error('Failed to save sequence store:', error);
    }
}

/**
 * Generates the next sequence number based on Station ID and Local Counter.
 * Format: SS (Station) + NNNNN (Seq) + Padding (Zeros) + 1 (Suffix)
 * Example: Station 01, Seq 123, Len 13 -> "0100123000001"
 */
export function getNextSequence(type: 'unit' | 'box' | 'pallet'): string {
    const identity = loadIdentity();
    if (!identity) throw new Error('Station identity not loaded');

    const config = loadNumberingConfig();
    const typeConfig = config[type];

    // Config fallback length
    const targetLength = typeConfig.length || 13;

    const store = loadSequenceStore();
    store[type]++;
    saveSequenceStore(store);

    const seqNum = store[type];
    const stationPrefix = identity.station_number.padStart(2, '0');
    const sequencePart = String(seqNum).padStart(5, '0');

    // Core Value = SS + NNNNN
    const core = `${stationPrefix}${sequencePart}`;

    // User requested format: "ssnnnnnXXXX1" where X is zero padding.
    // Typically, barcode logic might be different (e.g. EAN13 checksum), 
    // but we are following the specific request for "Offline Sync & Station Numbering".
    // "1" as a suffix seems to be a specific requirement from the user example.
    const suffix = '1';

    const requiredPadding = targetLength - core.length - suffix.length;

    if (requiredPadding >= 0) {
        const padding = '0'.repeat(requiredPadding);
        return `${core}${padding}${suffix}`;
    } else {
        // If Core + Suffix exceeds length, we return the core + suffix (overflow).
        // Or we should warn? For now, return as is.
        return `${core}${suffix}`;
    }
}

export function getCurrentCounters() {
    return loadSequenceStore();
}
