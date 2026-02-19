import { autoUpdater } from 'electron-updater';
import type { UpdateInfo, ProgressInfo } from 'electron-updater';
import { app, BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import log from '../logger';
import { createBackup, restoreBackup, listBackups } from './backup';
import type { BackupInfo } from './backup';
import { checkPreUpdateCompatibility } from './compatibility';
import { testConnectionFull } from '../sync';
import { loadPrinterConfig } from '../config';

export interface UpdateCheckResult {
    available: boolean;
    version?: string;
    releaseNotes?: string;
    /** Compatibility check result before allowing download */
    compatible?: boolean;
    compatibilityReason?: string;
}

export interface UpdateProgress {
    percent: number;
    transferred: number;
    total: number;
    bytesPerSecond: number;
}

// Cached server version from last ping — used for pre-update compat check
let lastKnownServerVersion: string | null = null;

export function setLastKnownServerVersion(version: string | null) {
    lastKnownServerVersion = version;
}

export function getLastKnownServerVersion(): string | null {
    return lastKnownServerVersion;
}

// ---------------------------------------------------------------------------
// electron-updater configuration
// ---------------------------------------------------------------------------

function configureAutoUpdater(mainWindow: BrowserWindow | null) {
    autoUpdater.logger = log;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    // Enable development mode update testing if dev-app-update.yml exists
    const devConfigPath = path.join(app.getAppPath(), 'dev-app-update.yml');
    if (fs.existsSync(devConfigPath)) {
        log.info(`[Updater] Potential dev config found at: ${devConfigPath}`);
        if (!app.isPackaged || autoUpdater.forceDevUpdateConfig) {
            log.info(`[Updater] APPLYING dev update config from: ${devConfigPath}`);
            autoUpdater.updateConfigPath = devConfigPath;
            // @ts-ignore
            autoUpdater.forceDevUpdateConfig = true;
        } else {
            log.info(`[Updater] Ignoring dev config because app is packaged and forceDevUpdateConfig is false.`);
        }
    }

    autoUpdater.on('update-available', (info: UpdateInfo) => {
        const currentVersion = app.getVersion();

        // Clean versions for comparison (remove 'v' prefix if present, trim whitespace)
        const cleanCurrent = currentVersion.replace(/^v/, '').trim();
        const cleanInfo = (info.version || '').replace(/^v/, '').trim();

        if (cleanCurrent === cleanInfo) {
            log.info(`[Updater] Update available event fired, but versions match (${cleanCurrent}). Ignoring.`);
            mainWindow?.webContents.send('updater:no-update');
            return;
        }

        log.info(`[Updater] Update available: v${info.version}. Release date: ${info.releaseDate}`);
        mainWindow?.webContents.send('updater:update-available', {
            version: info.version,
            releaseNotes: info.releaseNotes,
        });
    });

    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
        log.info(`[Updater] No update available. Current version: ${app.getVersion()}. Latest on server: ${info.version}`);
        mainWindow?.webContents.send('updater:no-update');
    });

    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
        mainWindow?.webContents.send('updater:progress', {
            percent: progress.percent,
            transferred: progress.transferred,
            total: progress.total,
            bytesPerSecond: progress.bytesPerSecond,
        } as UpdateProgress);
    });

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
        log.info(`[Updater] Update downloaded: v${info.version}`);
        mainWindow?.webContents.send('updater:downloaded', { version: info.version });
    });

    autoUpdater.on('error', (err: Error) => {
        log.error('[Updater] Error during update check/download:', err);
        // Log more details if available
        if (err.stack) log.error(`[Updater] Stack trace: ${err.stack}`);
        mainWindow?.webContents.send('updater:error', { message: err.message });
    });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialise the updater (call once from main process after window is ready).
 */
export function initUpdater(mainWindow: BrowserWindow | null) {
    configureAutoUpdater(mainWindow);
}

/**
 * Check for updates online.
 * Also runs a pre-update compatibility check against the current server.
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
    try {
        log.info(`[Updater] Checking for updates... (Current version: ${app.getVersion()})`);
        const result = await autoUpdater.checkForUpdates();
        if (!result || !result.updateInfo) {
            log.info('[Updater] Check finished: no update info returned.');
            return { available: false };
        }

        const newVersion = result.updateInfo.version;

        // Pre-update compatibility check (Level 3)
        const compat = checkPreUpdateCompatibility(newVersion, lastKnownServerVersion);

        return {
            available: true,
            version: newVersion,
            releaseNotes: typeof result.updateInfo.releaseNotes === 'string'
                ? result.updateInfo.releaseNotes
                : undefined,
            compatible: compat.compatible,
            compatibilityReason: compat.reason,
        };
    } catch (err: any) {
        log.error('[Updater] checkForUpdates failed:', err);
        return { available: false };
    }
}

/**
 * Download the update in the background.
 */
export async function downloadUpdate(): Promise<void> {
    log.info('[Updater] Starting download...');
    await autoUpdater.downloadUpdate();
}

/**
 * Create a backup, then quit and install the downloaded update.
 */
export async function installUpdate(): Promise<void> {
    log.info('[Updater] Creating backup before install...');
    await createBackup();
    log.info('[Updater] Quitting and installing update...');
    autoUpdater.quitAndInstall(false, true);
}

// ---------------------------------------------------------------------------
// Offline update (USB / downloaded .exe)
// ---------------------------------------------------------------------------

/**
 * Install an offline update from a local .exe installer.
 * Creates a backup, then launches the installer silently.
 */
export async function installOfflineUpdate(installerPath: string): Promise<{ success: boolean; message: string }> {
    if (!fs.existsSync(installerPath)) {
        return { success: false, message: `Файл не найден: ${installerPath}` };
    }

    const ext = path.extname(installerPath).toLowerCase();
    if (ext !== '.exe') {
        return { success: false, message: 'Ожидается файл .exe' };
    }

    log.info(`[Updater] Offline install from: ${installerPath}`);

    // Create backup first
    try {
        await createBackup();
        log.info('[Updater] Backup created before offline install.');
    } catch (err: any) {
        return { success: false, message: `Не удалось создать бэкап: ${err.message}` };
    }

    // Launch installer silently — NSIS /S flag
    const installDir = path.dirname(app.getPath('exe'));
    const child = spawn(installerPath, ['/S', `/D=${installDir}`], {
        detached: true,
        stdio: 'ignore',
    });
    child.unref();

    // Give installer a moment to start, then quit
    setTimeout(() => app.quit(), 1500);

    return { success: true, message: 'Установщик запущен. Приложение закроется.' };
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/**
 * Restore a backup by ID. The app should be restarted after this.
 */
export async function rollbackToBackup(backupId: string): Promise<{ success: boolean; message: string }> {
    try {
        log.info(`[Updater] Rolling back to backup: ${backupId}`);
        await restoreBackup(backupId);
        return { success: true, message: `Откат на бэкап "${backupId}" выполнен. Перезапустите приложение.` };
    } catch (err: any) {
        log.error('[Updater] Rollback failed:', err);
        return { success: false, message: err.message };
    }
}

/**
 * Get the list of available backups.
 */
export async function getBackups(): Promise<BackupInfo[]> {
    return listBackups();
}

// ---------------------------------------------------------------------------
// Server version refresh
// ---------------------------------------------------------------------------

/**
 * Ping the server and update the cached server version.
 * Call this periodically or on reconnect.
 */
export async function refreshServerVersion(): Promise<void> {
    try {
        const config = loadPrinterConfig();
        if (!config.serverIp) return;

        const info = await testConnectionFull(config.serverIp);
        if (info.online && info.serverVersion) {
            lastKnownServerVersion = info.serverVersion;
            log.info(`[Updater] Server version refreshed: ${info.serverVersion}`);
        }
    } catch (err) {
        log.warn('[Updater] Failed to refresh server version:', err);
    }
}
