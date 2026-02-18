"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.COMPAT_MATRIX = void 0;
exports.semverLt = semverLt;
exports.semverGte = semverGte;
exports.checkSyncFileCompatibility = checkSyncFileCompatibility;
exports.checkOnlineCompatibility = checkOnlineCompatibility;
exports.checkPreUpdateCompatibility = checkPreUpdateCompatibility;
const electron_1 = require("electron");
const logger_1 = __importDefault(require("../logger"));
/**
 * Simple semver comparison.
 * Returns true if versionA < versionB.
 */
function semverLt(versionA, versionB) {
    const parse = (v) => v.replace(/^v/, '').split('.').map(Number);
    const [aMaj, aMin, aPatch] = parse(versionA);
    const [bMaj, bMin, bPatch] = parse(versionB);
    if (aMaj !== bMaj)
        return aMaj < bMaj;
    if (aMin !== bMin)
        return aMin < bMin;
    return aPatch < bPatch;
}
/**
 * Returns true if versionA >= versionB.
 */
function semverGte(versionA, versionB) {
    return !semverLt(versionA, versionB);
}
// ---------------------------------------------------------------------------
// Level 3: Client-side compatibility matrix
// Used ONLY before updating the client itself — to check whether the new
// client version will still be compatible with the currently running server.
//
// Rule: "If I update to X.Y.Z, what is the minimum server version I need?"
// ---------------------------------------------------------------------------
exports.COMPAT_MATRIX = {
    '1.0.0': { minServerVersion: '1.0.0' },
    // Add new entries when a new client version requires a newer server:
    // '2.0.0': { minServerVersion: '2.0.0' },
};
/**
 * Level 1 (Offline / .lps file import):
 * Checks whether the current client can process a sync file from the server.
 * Called in processor.ts before writing anything to the DB.
 *
 * @param minClientVersion  Value of meta.min_client_version from the sync file
 * @returns CompatibilityCheckResult
 */
function checkSyncFileCompatibility(minClientVersion) {
    if (!minClientVersion) {
        // Old server that doesn't embed version info — assume compatible
        return { compatible: true };
    }
    const myVersion = electron_1.app.getVersion();
    if (semverLt(myVersion, minClientVersion)) {
        const reason = `Версия клиента ${myVersion} устарела. ` +
            `Минимальная совместимая версия: ${minClientVersion}. ` +
            `Обновите LabelPilot перед синхронизацией.`;
        logger_1.default.warn(`[Compatibility] ${reason}`);
        return { compatible: false, reason, requiredVersion: minClientVersion };
    }
    return { compatible: true };
}
/**
 * Level 2 (Online — called after /ping/ response):
 * Checks whether the current client is compatible with the server it's connected to.
 *
 * @param serverMinClientVersion  Value of min_client_version from the ping response
 * @returns CompatibilityCheckResult
 */
function checkOnlineCompatibility(serverMinClientVersion) {
    return checkSyncFileCompatibility(serverMinClientVersion);
}
/**
 * Level 3 (Pre-update check):
 * Checks whether updating the client to `newClientVersion` would break
 * compatibility with the currently known server version.
 *
 * @param newClientVersion   The version we're about to install
 * @param currentServerVersion  Server version from the last ping
 * @returns CompatibilityCheckResult
 */
function checkPreUpdateCompatibility(newClientVersion, currentServerVersion) {
    if (!currentServerVersion) {
        // Server is offline — can't check, allow update with a warning
        return {
            compatible: true,
            reason: 'Сервер недоступен. Совместимость будет проверена при следующем подключении.',
        };
    }
    const entry = exports.COMPAT_MATRIX[newClientVersion];
    if (!entry) {
        // No entry in matrix — assume compatible
        return { compatible: true };
    }
    if (semverLt(currentServerVersion, entry.minServerVersion)) {
        const reason = `Обновление до v${newClientVersion} требует сервер v${entry.minServerVersion}+. ` +
            `Текущая версия сервера: ${currentServerVersion}. ` +
            `Сначала обновите сервер.`;
        logger_1.default.warn(`[Compatibility] ${reason}`);
        return { compatible: false, reason, requiredVersion: entry.minServerVersion };
    }
    return { compatible: true };
}
