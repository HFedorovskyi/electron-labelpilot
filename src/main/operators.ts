/**
 * operators.ts — DB accessors for the server-owned `operators` table.
 *
 * Operators back the operator PIN-login layer (Layer C: workflow/audit/UX, NOT a
 * security boundary). Rows are written by importFullDump from payload.operators.
 * These accessors are read-only; the table is owned by the server sync.
 */

import { initDatabase } from './database';

export interface OperatorRow {
    uuid: string;
    full_name: string;
    short_code: string | null;
    pin_hash: string | null;
    is_active: number;
}

/**
 * Active operators, for the login tiles. Returns [] (never throws) if the table is
 * missing (e.g. a DB synced before migration v8) so the gate can fall back gracefully.
 */
export function listActiveOperators(): OperatorRow[] {
    try {
        const db = initDatabase();
        return db
            .prepare(
                'SELECT uuid, full_name, short_code, pin_hash, is_active FROM operators WHERE is_active = 1 ORDER BY full_name COLLATE NOCASE'
            )
            .all() as OperatorRow[];
    } catch (e) {
        console.warn('listActiveOperators failed (treating as empty):', e);
        return [];
    }
}

/** Look up a single operator by uuid. Returns null if not found / table missing. */
export function getOperatorByUuid(uuid: string): OperatorRow | null {
    if (!uuid) return null;
    try {
        const db = initDatabase();
        const row = db
            .prepare('SELECT uuid, full_name, short_code, pin_hash, is_active FROM operators WHERE uuid = ?')
            .get(uuid) as OperatorRow | undefined;
        return row ?? null;
    } catch (e) {
        console.warn('getOperatorByUuid failed:', e);
        return null;
    }
}
