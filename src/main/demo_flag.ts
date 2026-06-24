import fs from 'fs';
import path from 'path';
import { app } from 'electron';

/**
 * demo_flag.ts — DURABLE "am I in demo mode?" signal.
 *
 * Replaces the fragile `stationUuid.startsWith('demo-')` heuristic: that only
 * works while the demo seed's synthetic uuid is the active identity, and is lost
 * the moment any other identity logic touches the station. Instead we persist a
 * tiny marker FILE in app.getPath('userData') — mirroring how license.token is
 * stored in src/main/encryption.ts — so demo state survives independently of the
 * station uuid.
 *
 * Contract: every export is wrapped in try/catch and NEVER throws. isDemoActive()
 * returns false on any error (fail-safe: an unreadable flag means "not demo").
 *
 * Lifecycle:
 *   • setDemoFlag()   — after seedDemoData() successfully seeds (demo_seed.ts).
 *   • clearDemoFlag() — on any REAL provisioning: identity import (identity.ts),
 *                       offline update import (offline_sync.ts), and the
 *                       'reset-database' IPC handler (index.ts).
 *   NOTE: it is deliberately NOT cleared inside the shared processSyncData(),
 *   because demo seeding also routes through that path.
 */

const DEMO_FLAG_FILE = 'demo.flag';

function demoFlagPath(): string {
    return path.join(app.getPath('userData'), DEMO_FLAG_FILE);
}

/** Mark this station as running in the built-in demo mode. Never throws. */
export function setDemoFlag(): void {
    try {
        fs.writeFileSync(demoFlagPath(), '1', 'ascii');
    } catch (e) {
        console.warn('Could not persist demo flag:', e);
    }
}

/** Clear the demo marker (e.g. after a real provisioning). Never throws. */
export function clearDemoFlag(): void {
    try {
        const p = demoFlagPath();
        if (fs.existsSync(p)) {
            fs.unlinkSync(p);
        }
    } catch (e) {
        console.warn('Could not clear demo flag:', e);
    }
}

/** True iff the durable demo marker is present. Returns false on any error. */
export function isDemoActive(): boolean {
    try {
        return fs.existsSync(demoFlagPath());
    } catch {
        return false;
    }
}
