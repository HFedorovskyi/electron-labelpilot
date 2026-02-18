import { app } from 'electron';
import log from '../logger';

/**
 * Simple semver comparison.
 * Returns true if versionA < versionB.
 */
export function semverLt(versionA: string, versionB: string): boolean {
    const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
    const [aMaj, aMin, aPatch] = parse(versionA);
    const [bMaj, bMin, bPatch] = parse(versionB);

    if (aMaj !== bMaj) return aMaj < bMaj;
    if (aMin !== bMin) return aMin < bMin;
    return aPatch < bPatch;
}

/**
 * Returns true if versionA >= versionB.
 */
export function semverGte(versionA: string, versionB: string): boolean {
    return !semverLt(versionA, versionB);
}

// ---------------------------------------------------------------------------
// Level 3: Client-side compatibility matrix
// Used ONLY before updating the client itself — to check whether the new
// client version will still be compatible with the currently running server.
//
// Rule: "If I update to X.Y.Z, what is the minimum server version I need?"
// ---------------------------------------------------------------------------
export const COMPAT_MATRIX: Record<string, { minServerVersion: string }> = {
    '1.0.0': { minServerVersion: '1.0.0' },
    // Add new entries when a new client version requires a newer server:
    // '2.0.0': { minServerVersion: '2.0.0' },
};

export interface CompatibilityCheckResult {
    compatible: boolean;
    reason?: string;
    requiredVersion?: string;
}

/**
 * Level 1 (Offline / .lps file import):
 * Checks whether the current client can process a sync file from the server.
 * Called in processor.ts before writing anything to the DB.
 *
 * @param minClientVersion  Value of meta.min_client_version from the sync file
 * @returns CompatibilityCheckResult
 */
export function checkSyncFileCompatibility(minClientVersion: string | undefined): CompatibilityCheckResult {
    if (!minClientVersion) {
        // Old server that doesn't embed version info — assume compatible
        return { compatible: true };
    }

    const myVersion = app.getVersion();
    if (semverLt(myVersion, minClientVersion)) {
        const reason =
            `Версия клиента ${myVersion} устарела. ` +
            `Минимальная совместимая версия: ${minClientVersion}. ` +
            `Обновите LabelPilot перед синхронизацией.`;
        log.warn(`[Compatibility] ${reason}`);
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
export function checkOnlineCompatibility(serverMinClientVersion: string | undefined): CompatibilityCheckResult {
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
export function checkPreUpdateCompatibility(
    newClientVersion: string,
    currentServerVersion: string | null
): CompatibilityCheckResult {
    if (!currentServerVersion) {
        // Server is offline — can't check, allow update with a warning
        return {
            compatible: true,
            reason: 'Сервер недоступен. Совместимость будет проверена при следующем подключении.',
        };
    }

    const entry = COMPAT_MATRIX[newClientVersion];
    if (!entry) {
        // No entry in matrix — assume compatible
        return { compatible: true };
    }

    if (semverLt(currentServerVersion, entry.minServerVersion)) {
        const reason =
            `Обновление до v${newClientVersion} требует сервер v${entry.minServerVersion}+. ` +
            `Текущая версия сервера: ${currentServerVersion}. ` +
            `Сначала обновите сервер.`;
        log.warn(`[Compatibility] ${reason}`);
        return { compatible: false, reason, requiredVersion: entry.minServerVersion };
    }

    return { compatible: true };
}
