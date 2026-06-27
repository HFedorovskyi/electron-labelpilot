import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import log from '../logger';

export interface BackupInfo {
    id: string;           // e.g. "v1.0.0_20260218T153000"
    version: string;      // app version at time of backup
    createdAt: string;    // ISO timestamp
    path: string;         // absolute path to backup folder
    sizeBytes: number;    // total size of backup
}

const FILES_TO_BACKUP = [
    'client_data.db',
    'identity.json',
    'license.token',      // station license — without it a rollback would lose licensed state
    'report_state.json',  // report watermark — keep it paired with the DB snapshot
    'printer-config.json',
    'scale-config.json',
    'numbering-config.json',
];

// The offline report spool is a DIRECTORY of *.lpr blobs (pending uploads). Snapshot it too so a
// rollback is a complete restore. Forward updates never touch userData, so the live spool is safe
// regardless; this only closes the rollback-fidelity gap.
const DIRS_TO_BACKUP = ['outbox'];

const MAX_BACKUPS = 3;

function getBackupsDir(): string {
    return path.join(app.getPath('userData'), 'backups');
}

function getUserDataDir(): string {
    return app.getPath('userData');
}

function getFolderSize(folderPath: string): number {
    if (!fs.existsSync(folderPath)) return 0;
    let total = 0;
    for (const entry of fs.readdirSync(folderPath)) {
        const fullPath = path.join(folderPath, entry);
        const stat = fs.statSync(fullPath);
        total += stat.isDirectory() ? getFolderSize(fullPath) : stat.size;
    }
    return total;
}

/**
 * Creates a full backup of the DB and all config files.
 * Returns info about the created backup.
 */
export async function createBackup(): Promise<BackupInfo> {
    const version = app.getVersion();
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const id = `v${version}_${timestamp}`;

    const backupsDir = getBackupsDir();
    const backupPath = path.join(backupsDir, id);

    fs.mkdirSync(backupPath, { recursive: true });

    const userData = getUserDataDir();
    let copiedCount = 0;

    for (const file of FILES_TO_BACKUP) {
        const src = path.join(userData, file);
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(backupPath, file));
            copiedCount++;
        }
    }

    // Snapshot directory state (the offline outbox spool) — copy each file into backup/<dir>/.
    for (const dir of DIRS_TO_BACKUP) {
        const srcDir = path.join(userData, dir);
        if (!fs.existsSync(srcDir)) continue;
        const dstDir = path.join(backupPath, dir);
        fs.mkdirSync(dstDir, { recursive: true });
        for (const entry of fs.readdirSync(srcDir)) {
            const s = path.join(srcDir, entry);
            if (fs.statSync(s).isFile()) {
                fs.copyFileSync(s, path.join(dstDir, entry));
                copiedCount++;
            }
        }
    }

    // Save metadata
    const meta = {
        id,
        version,
        createdAt: now.toISOString(),
        files: FILES_TO_BACKUP.filter(f => fs.existsSync(path.join(userData, f))),
    };
    fs.writeFileSync(path.join(backupPath, 'backup-meta.json'), JSON.stringify(meta, null, 2));

    const sizeBytes = getFolderSize(backupPath);
    log.info(`[Backup] Created backup "${id}" (${copiedCount} files, ${sizeBytes} bytes)`);

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
export async function restoreBackup(backupId: string): Promise<void> {
    const backupPath = path.join(getBackupsDir(), backupId);

    if (!fs.existsSync(backupPath)) {
        throw new Error(`Backup not found: ${backupId}`);
    }

    const metaPath = path.join(backupPath, 'backup-meta.json');
    if (!fs.existsSync(metaPath)) {
        throw new Error(`Backup metadata missing in: ${backupId}`);
    }

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    const userData = getUserDataDir();

    log.info(`[Backup] Restoring backup "${backupId}" (version ${meta.version})...`);

    for (const file of FILES_TO_BACKUP) {
        const src = path.join(backupPath, file);
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(userData, file));
            log.info(`[Backup] Restored: ${file}`);
        }
    }

    // Restore spool directories by MERGE (copy backed-up blobs back; never delete spool files
    // written live since the backup — those are still-valid pending uploads). .lpr filenames are
    // timestamp+random, so collisions don't occur and the result is the union.
    for (const dir of DIRS_TO_BACKUP) {
        const srcDir = path.join(backupPath, dir);
        if (!fs.existsSync(srcDir)) continue;
        const dstDir = path.join(userData, dir);
        fs.mkdirSync(dstDir, { recursive: true });
        let n = 0;
        for (const entry of fs.readdirSync(srcDir)) {
            const s = path.join(srcDir, entry);
            if (fs.statSync(s).isFile()) {
                fs.copyFileSync(s, path.join(dstDir, entry));
                n++;
            }
        }
        if (n) log.info(`[Backup] Restored ${dir}/ (${n} file(s), merged)`);
    }

    log.info(`[Backup] Restore complete from "${backupId}".`);
}

/**
 * Lists all available backups, sorted newest first.
 */
export async function listBackups(): Promise<BackupInfo[]> {
    const backupsDir = getBackupsDir();
    if (!fs.existsSync(backupsDir)) return [];

    const entries = fs.readdirSync(backupsDir);
    const result: BackupInfo[] = [];

    for (const entry of entries) {
        const backupPath = path.join(backupsDir, entry);
        const metaPath = path.join(backupPath, 'backup-meta.json');

        if (!fs.existsSync(metaPath)) continue;

        try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            result.push({
                id: meta.id,
                version: meta.version,
                createdAt: meta.createdAt,
                path: backupPath,
                sizeBytes: getFolderSize(backupPath),
            });
        } catch {
            // Skip malformed backup
        }
    }

    // Newest first
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Deletes old backups, keeping only the most recent `keepLast`.
 */
export async function deleteOldBackups(keepLast: number = MAX_BACKUPS): Promise<void> {
    const backups = await listBackups();
    const toDelete = backups.slice(keepLast);

    for (const backup of toDelete) {
        try {
            fs.rmSync(backup.path, { recursive: true, force: true });
            log.info(`[Backup] Deleted old backup: ${backup.id}`);
        } catch (err) {
            log.warn(`[Backup] Failed to delete backup ${backup.id}:`, err);
        }
    }
}
