"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.setLastKnownServerVersion = setLastKnownServerVersion;
exports.getLastKnownServerVersion = getLastKnownServerVersion;
exports.initUpdater = initUpdater;
exports.checkForUpdates = checkForUpdates;
exports.downloadUpdate = downloadUpdate;
exports.installUpdate = installUpdate;
exports.installOfflineUpdate = installOfflineUpdate;
exports.rollbackToBackup = rollbackToBackup;
exports.getBackups = getBackups;
exports.refreshServerVersion = refreshServerVersion;
const electron_updater_1 = require("electron-updater");
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const child_process_1 = require("child_process");
const logger_1 = __importDefault(require("../logger"));
const backup_1 = require("./backup");
const compatibility_1 = require("./compatibility");
const sync_1 = require("../sync");
const config_1 = require("../config");
// Cached server version from last ping — used for pre-update compat check
let lastKnownServerVersion = null;
function setLastKnownServerVersion(version) {
    lastKnownServerVersion = version;
}
function getLastKnownServerVersion() {
    return lastKnownServerVersion;
}
// ---------------------------------------------------------------------------
// electron-updater configuration
// ---------------------------------------------------------------------------
function configureAutoUpdater(mainWindow) {
    electron_updater_1.autoUpdater.logger = logger_1.default;
    electron_updater_1.autoUpdater.autoDownload = false;
    electron_updater_1.autoUpdater.autoInstallOnAppQuit = false;
    // Enable development mode update testing if dev-app-update.yml exists
    const devConfigPath = path_1.default.join(electron_1.app.getAppPath(), 'dev-app-update.yml');
    if (fs_1.default.existsSync(devConfigPath)) {
        logger_1.default.info(`[Updater] Found dev update config at: ${devConfigPath}`);
        electron_updater_1.autoUpdater.updateConfigPath = devConfigPath;
        // @ts-ignore — forceDevUpdateConfig is internal but useful for testing
        electron_updater_1.autoUpdater.forceDevUpdateConfig = true;
    }
    electron_updater_1.autoUpdater.on('update-available', (info) => {
        logger_1.default.info(`[Updater] Update available: v${info.version}`);
        mainWindow?.webContents.send('updater:update-available', {
            version: info.version,
            releaseNotes: info.releaseNotes,
        });
    });
    electron_updater_1.autoUpdater.on('update-not-available', () => {
        logger_1.default.info('[Updater] No update available.');
        mainWindow?.webContents.send('updater:no-update');
    });
    electron_updater_1.autoUpdater.on('download-progress', (progress) => {
        mainWindow?.webContents.send('updater:progress', {
            percent: progress.percent,
            transferred: progress.transferred,
            total: progress.total,
            bytesPerSecond: progress.bytesPerSecond,
        });
    });
    electron_updater_1.autoUpdater.on('update-downloaded', (info) => {
        logger_1.default.info(`[Updater] Update downloaded: v${info.version}`);
        mainWindow?.webContents.send('updater:downloaded', { version: info.version });
    });
    electron_updater_1.autoUpdater.on('error', (err) => {
        logger_1.default.error('[Updater] Error:', err);
        mainWindow?.webContents.send('updater:error', { message: err.message });
    });
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Initialise the updater (call once from main process after window is ready).
 */
function initUpdater(mainWindow) {
    configureAutoUpdater(mainWindow);
}
/**
 * Check for updates online.
 * Also runs a pre-update compatibility check against the current server.
 */
async function checkForUpdates() {
    try {
        const result = await electron_updater_1.autoUpdater.checkForUpdates();
        if (!result || !result.updateInfo) {
            return { available: false };
        }
        const newVersion = result.updateInfo.version;
        // Pre-update compatibility check (Level 3)
        const compat = (0, compatibility_1.checkPreUpdateCompatibility)(newVersion, lastKnownServerVersion);
        return {
            available: true,
            version: newVersion,
            releaseNotes: typeof result.updateInfo.releaseNotes === 'string'
                ? result.updateInfo.releaseNotes
                : undefined,
            compatible: compat.compatible,
            compatibilityReason: compat.reason,
        };
    }
    catch (err) {
        logger_1.default.error('[Updater] checkForUpdates failed:', err);
        return { available: false };
    }
}
/**
 * Download the update in the background.
 */
async function downloadUpdate() {
    logger_1.default.info('[Updater] Starting download...');
    await electron_updater_1.autoUpdater.downloadUpdate();
}
/**
 * Create a backup, then quit and install the downloaded update.
 */
async function installUpdate() {
    logger_1.default.info('[Updater] Creating backup before install...');
    await (0, backup_1.createBackup)();
    logger_1.default.info('[Updater] Quitting and installing update...');
    electron_updater_1.autoUpdater.quitAndInstall(false, true);
}
// ---------------------------------------------------------------------------
// Offline update (USB / downloaded .exe)
// ---------------------------------------------------------------------------
/**
 * Install an offline update from a local .exe installer.
 * Creates a backup, then launches the installer silently.
 */
async function installOfflineUpdate(installerPath) {
    if (!fs_1.default.existsSync(installerPath)) {
        return { success: false, message: `Файл не найден: ${installerPath}` };
    }
    const ext = path_1.default.extname(installerPath).toLowerCase();
    if (ext !== '.exe') {
        return { success: false, message: 'Ожидается файл .exe' };
    }
    logger_1.default.info(`[Updater] Offline install from: ${installerPath}`);
    // Create backup first
    try {
        await (0, backup_1.createBackup)();
        logger_1.default.info('[Updater] Backup created before offline install.');
    }
    catch (err) {
        return { success: false, message: `Не удалось создать бэкап: ${err.message}` };
    }
    // Launch installer silently — NSIS /S flag
    const installDir = path_1.default.dirname(electron_1.app.getPath('exe'));
    const child = (0, child_process_1.spawn)(installerPath, ['/S', `/D=${installDir}`], {
        detached: true,
        stdio: 'ignore',
    });
    child.unref();
    // Give installer a moment to start, then quit
    setTimeout(() => electron_1.app.quit(), 1500);
    return { success: true, message: 'Установщик запущен. Приложение закроется.' };
}
// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------
/**
 * Restore a backup by ID. The app should be restarted after this.
 */
async function rollbackToBackup(backupId) {
    try {
        logger_1.default.info(`[Updater] Rolling back to backup: ${backupId}`);
        await (0, backup_1.restoreBackup)(backupId);
        return { success: true, message: `Откат на бэкап "${backupId}" выполнен. Перезапустите приложение.` };
    }
    catch (err) {
        logger_1.default.error('[Updater] Rollback failed:', err);
        return { success: false, message: err.message };
    }
}
/**
 * Get the list of available backups.
 */
async function getBackups() {
    return (0, backup_1.listBackups)();
}
// ---------------------------------------------------------------------------
// Server version refresh
// ---------------------------------------------------------------------------
/**
 * Ping the server and update the cached server version.
 * Call this periodically or on reconnect.
 */
async function refreshServerVersion() {
    try {
        const config = (0, config_1.loadPrinterConfig)();
        if (!config.serverIp)
            return;
        const info = await (0, sync_1.testConnectionFull)(config.serverIp);
        if (info.online && info.serverVersion) {
            lastKnownServerVersion = info.serverVersion;
            logger_1.default.info(`[Updater] Server version refreshed: ${info.serverVersion}`);
        }
    }
    catch (err) {
        logger_1.default.warn('[Updater] Failed to refresh server version:', err);
    }
}
