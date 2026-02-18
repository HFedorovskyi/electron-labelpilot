"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBackup = createBackup;
exports.restoreBackup = restoreBackup;
exports.listBackups = listBackups;
exports.deleteOldBackups = deleteOldBackups;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
const logger_1 = __importDefault(require("../logger"));
const FILES_TO_BACKUP = [
    'client_data.db',
    'identity.json',
    'printer-config.json',
    'scale-config.json',
    'numbering-config.json',
];
const MAX_BACKUPS = 3;
function getBackupsDir() {
    return path_1.default.join(electron_1.app.getPath('userData'), 'backups');
}
function getUserDataDir() {
    return electron_1.app.getPath('userData');
}
function getFolderSize(folderPath) {
    if (!fs_1.default.existsSync(folderPath))
        return 0;
    let total = 0;
    for (const entry of fs_1.default.readdirSync(folderPath)) {
        const fullPath = path_1.default.join(folderPath, entry);
        const stat = fs_1.default.statSync(fullPath);
        total += stat.isDirectory() ? getFolderSize(fullPath) : stat.size;
    }
    return total;
}
/**
 * Creates a full backup of the DB and all config files.
 * Returns info about the created backup.
 */
async function createBackup() {
    const version = electron_1.app.getVersion();
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const id = `v${version}_${timestamp}`;
    const backupsDir = getBackupsDir();
    const backupPath = path_1.default.join(backupsDir, id);
    fs_1.default.mkdirSync(backupPath, { recursive: true });
    const userData = getUserDataDir();
    let copiedCount = 0;
    for (const file of FILES_TO_BACKUP) {
        const src = path_1.default.join(userData, file);
        if (fs_1.default.existsSync(src)) {
            fs_1.default.copyFileSync(src, path_1.default.join(backupPath, file));
            copiedCount++;
        }
    }
    // Save metadata
    const meta = {
        id,
        version,
        createdAt: now.toISOString(),
        files: FILES_TO_BACKUP.filter(f => fs_1.default.existsSync(path_1.default.join(userData, f))),
    };
    fs_1.default.writeFileSync(path_1.default.join(backupPath, 'backup-meta.json'), JSON.stringify(meta, null, 2));
    const sizeBytes = getFolderSize(backupPath);
    logger_1.default.info(`[Backup] Created backup "${id}" (${copiedCount} files, ${sizeBytes} bytes)`);
    // Auto-cleanup old backups
    await deleteOldBackups(MAX_BACKUPS);
    return {
        id,
        version,
        createdAt: now.toISOString(),
        path: backupPath,
        sizeBytes,
    };
}
/**
 * Restores all files from a backup by its ID.
 * Overwrites current userData files.
 */
async function restoreBackup(backupId) {
    const backupPath = path_1.default.join(getBackupsDir(), backupId);
    if (!fs_1.default.existsSync(backupPath)) {
        throw new Error(`Backup not found: ${backupId}`);
    }
    const metaPath = path_1.default.join(backupPath, 'backup-meta.json');
    if (!fs_1.default.existsSync(metaPath)) {
        throw new Error(`Backup metadata missing in: ${backupId}`);
    }
    const meta = JSON.parse(fs_1.default.readFileSync(metaPath, 'utf-8'));
    const userData = getUserDataDir();
    logger_1.default.info(`[Backup] Restoring backup "${backupId}" (version ${meta.version})...`);
    for (const file of FILES_TO_BACKUP) {
        const src = path_1.default.join(backupPath, file);
        if (fs_1.default.existsSync(src)) {
            fs_1.default.copyFileSync(src, path_1.default.join(userData, file));
            logger_1.default.info(`[Backup] Restored: ${file}`);
        }
    }
    logger_1.default.info(`[Backup] Restore complete from "${backupId}".`);
}
/**
 * Lists all available backups, sorted newest first.
 */
async function listBackups() {
    const backupsDir = getBackupsDir();
    if (!fs_1.default.existsSync(backupsDir))
        return [];
    const entries = fs_1.default.readdirSync(backupsDir);
    const result = [];
    for (const entry of entries) {
        const backupPath = path_1.default.join(backupsDir, entry);
        const metaPath = path_1.default.join(backupPath, 'backup-meta.json');
        if (!fs_1.default.existsSync(metaPath))
            continue;
        try {
            const meta = JSON.parse(fs_1.default.readFileSync(metaPath, 'utf-8'));
            result.push({
                id: meta.id,
                version: meta.version,
                createdAt: meta.createdAt,
                path: backupPath,
                sizeBytes: getFolderSize(backupPath),
            });
        }
        catch {
            // Skip malformed backup
        }
    }
    // Newest first
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
/**
 * Deletes old backups, keeping only the most recent `keepLast`.
 */
async function deleteOldBackups(keepLast = MAX_BACKUPS) {
    const backups = await listBackups();
    const toDelete = backups.slice(keepLast);
    for (const backup of toDelete) {
        try {
            fs_1.default.rmSync(backup.path, { recursive: true, force: true });
            logger_1.default.info(`[Backup] Deleted old backup: ${backup.id}`);
        }
        catch (err) {
            logger_1.default.warn(`[Backup] Failed to delete backup ${backup.id}:`, err);
        }
    }
}
