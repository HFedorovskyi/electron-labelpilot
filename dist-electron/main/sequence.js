"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getNextSequence = getNextSequence;
exports.getCurrentCounters = getCurrentCounters;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const electron_1 = require("electron");
const identity_1 = require("./identity");
const config_1 = require("./config");
const SEQUENCE_FILE = 'sequence-store.json';
const DEFAULT_SEQUENCE = {
    unit: 0,
    box: 0,
    pallet: 0
};
function getSequencePath() {
    return path_1.default.join(electron_1.app.getPath('userData'), SEQUENCE_FILE);
}
function loadSequenceStore() {
    const seqPath = getSequencePath();
    try {
        if (fs_1.default.existsSync(seqPath)) {
            const data = fs_1.default.readFileSync(seqPath, 'utf-8');
            return { ...DEFAULT_SEQUENCE, ...JSON.parse(data) };
        }
    }
    catch (error) {
        console.error('Failed to load sequence store:', error);
    }
    return DEFAULT_SEQUENCE;
}
function saveSequenceStore(store) {
    const seqPath = getSequencePath();
    try {
        fs_1.default.writeFileSync(seqPath, JSON.stringify(store, null, 2), 'utf-8');
    }
    catch (error) {
        console.error('Failed to save sequence store:', error);
    }
}
/**
 * Generates the next sequence number based on Station ID and Local Counter.
 * Format: SS (Station) + NNNNN (Seq) + Padding (Zeros) + 1 (Suffix)
 * Example: Station 01, Seq 123, Len 13 -> "0100123000001"
 */
function getNextSequence(type) {
    const identity = (0, identity_1.loadIdentity)();
    if (!identity)
        throw new Error('Station identity not loaded');
    const config = (0, config_1.loadNumberingConfig)();
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
    }
    else {
        // If Core + Suffix exceeds length, we return the core + suffix (overflow).
        // Or we should warn? For now, return as is.
        return `${core}${suffix}`;
    }
}
function getCurrentCounters() {
    return loadSequenceStore();
}
