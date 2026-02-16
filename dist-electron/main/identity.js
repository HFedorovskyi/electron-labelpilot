"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getIdentityPath = getIdentityPath;
exports.loadIdentity = loadIdentity;
exports.saveIdentity = saveIdentity;
exports.importIdentityFile = importIdentityFile;
exports.deleteIdentity = deleteIdentity;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const electron_1 = require("electron");
const encryption_1 = require("./encryption");
const IDENTITY_FILE = 'identity.json';
function getIdentityPath() {
    return path_1.default.join(electron_1.app.getPath('userData'), IDENTITY_FILE);
}
function loadIdentity() {
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
    }
    catch (e) {
        console.warn('Failed to load identity from database, falling back to JSON:', e);
    }
    const identityPath = getIdentityPath();
    try {
        if (fs_1.default.existsSync(identityPath)) {
            const data = fs_1.default.readFileSync(identityPath, 'utf-8');
            return JSON.parse(data);
        }
    }
    catch (error) {
        console.error('Failed to load identity JSON:', error);
    }
    return null;
}
function saveIdentity(identity) {
    const identityPath = getIdentityPath();
    try {
        fs_1.default.writeFileSync(identityPath, JSON.stringify(identity, null, 2), 'utf-8');
    }
    catch (error) {
        console.error('Failed to save identity:', error);
        throw error;
    }
}
async function importIdentityFile(filePath) {
    const { processSyncData } = require('./processor');
    try {
        const fileContent = fs_1.default.readFileSync(filePath);
        // Expecting the file to be encrypted
        const data = (0, encryption_1.decrypt)(fileContent);
        // Use unified processor
        await processSyncData(data);
        const updated = loadIdentity();
        if (!updated)
            throw new Error('Failed to load identity after import');
        return updated;
    }
    catch (error) {
        console.error('Failed to import identity file:', error);
        throw error;
    }
}
function deleteIdentity() {
    const identityPath = getIdentityPath();
    if (fs_1.default.existsSync(identityPath)) {
        fs_1.default.unlinkSync(identityPath);
    }
}
