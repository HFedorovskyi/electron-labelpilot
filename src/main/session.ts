/**
 * session.ts — ephemeral, machine-local operator session.
 *
 * The current operator is NOT a persisted auth fact: it lives only in memory for the life of
 * the process. We DO persist "last operator uuid" as a pure UX convenience (to pre-highlight a
 * tile on the login screen) — it is never treated as proof of login.
 *
 * This is Layer C (workflow/audit/UX), not a security boundary. The PIN check happens at
 * setSession() via verifyPin; everything here is fail-open for legitimate operators.
 */

import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { getOperatorByUuid } from './operators';
import { verifyPin } from './pin';

export interface CurrentOperator {
    uuid: string;
    full_name: string;
}

// Module-level ephemeral session. null = no operator logged in.
let currentOperator: CurrentOperator | null = null;

const LAST_OPERATOR_FILE = 'last-operator.json';

function lastOperatorPath(): string {
    return path.join(app.getPath('userData'), LAST_OPERATOR_FILE);
}

/** Persist only the last operator uuid (UX convenience — pre-highlight a login tile). */
function saveLastOperatorUuid(uuid: string | null): void {
    try {
        fs.writeFileSync(lastOperatorPath(), JSON.stringify({ uuid }), 'utf-8');
    } catch (e) {
        console.warn('session: failed to persist last operator uuid:', e);
    }
}

export function getLastOperatorUuid(): string | null {
    try {
        const p = lastOperatorPath();
        if (!fs.existsSync(p)) return null;
        const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
        return parsed?.uuid ?? null;
    } catch {
        return null;
    }
}

export function getCurrentOperator(): CurrentOperator | null {
    return currentOperator;
}

/**
 * Set the current operator after verifying the supplied PIN against the operator's stored
 * Django pbkdf2_sha256 hash.
 *
 *  - Unknown uuid → { ok: false, reason: 'not_found' } (never sets a session).
 *  - Operator with NO pin → logs in on any/empty pin (verifyPin returns true).
 *  - Wrong pin → { ok: false, reason: 'bad_pin' }.
 *
 * On success, returns the resolved operator so the caller can broadcast it.
 */
export function setSession(uuid: string, pin: string): { ok: boolean; reason?: string; operator?: CurrentOperator } {
    const row = getOperatorByUuid(uuid);
    if (!row) return { ok: false, reason: 'not_found' };

    if (!verifyPin(pin ?? '', row.pin_hash)) {
        return { ok: false, reason: 'bad_pin' };
    }

    currentOperator = { uuid: row.uuid, full_name: row.full_name || '' };
    saveLastOperatorUuid(currentOperator.uuid);
    return { ok: true, operator: currentOperator };
}

/** Clear the current session (Switch Operator → back to login). */
export function logoutSession(): void {
    currentOperator = null;
    // Keep the last-operator hint so the same tile is pre-highlighted on the next login.
}
