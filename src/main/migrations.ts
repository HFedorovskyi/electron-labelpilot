import Database from 'better-sqlite3';

export interface Migration {
    version: number;
    description: string;
    up(db: Database.Database): void;
    down(db: Database.Database): void;
}

/**
 * All migrations in ascending version order.
 * NEVER remove or modify existing migrations — only add new ones.
 */
export const migrations: Migration[] = [
    {
        version: 1,
        description: 'Baseline schema (existing tables)',
        up(_db) {
            // Schema already created by initDatabase() CREATE TABLE IF NOT EXISTS.
            // This migration just marks the baseline as applied.
        },
        down(_db) {
            // Cannot roll back the baseline.
        }
    },
    // Future migrations go here, e.g.:
    // {
    //   version: 2,
    //   description: 'Add barcode_type column to barcodes',
    //   up(db) {
    //     db.exec(`ALTER TABLE barcodes ADD COLUMN barcode_type TEXT DEFAULT 'auto'`);
    //   },
    //   down(db) {
    //     // SQLite < 3.35 doesn't support DROP COLUMN — recreate table
    //     db.exec(`CREATE TABLE barcodes_bak AS SELECT id, name, structure FROM barcodes`);
    //     db.exec(`DROP TABLE barcodes`);
    //     db.exec(`ALTER TABLE barcodes_bak RENAME TO barcodes`);
    //   }
    // },
];

/**
 * Ensures the _migrations tracking table exists.
 */
function ensureMigrationsTable(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS _migrations (
            version     INTEGER PRIMARY KEY,
            description TEXT    NOT NULL,
            applied_at  TEXT    NOT NULL
        )
    `);
}

/**
 * Returns the highest migration version already applied to the DB.
 */
function getCurrentVersion(db: Database.Database): number {
    const row = db
        .prepare('SELECT MAX(version) as v FROM _migrations')
        .get() as { v: number | null };
    return row?.v ?? 0;
}

/**
 * Applies all pending migrations in order, each inside its own transaction.
 * Throws on failure — the caller should handle rollback / alerting.
 */
export function runMigrations(db: Database.Database): void {
    ensureMigrationsTable(db);
    const currentVersion = getCurrentVersion(db);

    const pending = migrations.filter(m => m.version > currentVersion);
    if (pending.length === 0) {
        console.log(`[Migrations] DB is up-to-date at version ${currentVersion}.`);
        return;
    }

    console.log(`[Migrations] Current version: ${currentVersion}. Applying ${pending.length} migration(s)...`);

    for (const migration of pending) {
        console.log(`[Migrations] Applying v${migration.version}: ${migration.description}`);
        db.transaction(() => {
            migration.up(db);
            db.prepare(
                'INSERT INTO _migrations (version, description, applied_at) VALUES (?, ?, ?)'
            ).run(migration.version, migration.description, new Date().toISOString());
        })();
        console.log(`[Migrations] v${migration.version} applied successfully.`);
    }

    const newVersion = getCurrentVersion(db);
    console.log(`[Migrations] Done. DB is now at version ${newVersion}.`);
}

/**
 * Rolls back migrations down to (but not including) targetVersion.
 * Used during update rollback.
 */
export function rollbackMigrations(db: Database.Database, targetVersion: number): void {
    ensureMigrationsTable(db);
    const currentVersion = getCurrentVersion(db);

    if (currentVersion <= targetVersion) {
        console.log(`[Migrations] Nothing to roll back (current: ${currentVersion}, target: ${targetVersion}).`);
        return;
    }

    // Get applied migrations above targetVersion, in descending order
    const toRollback = migrations
        .filter(m => m.version > targetVersion && m.version <= currentVersion)
        .sort((a, b) => b.version - a.version);

    console.log(`[Migrations] Rolling back ${toRollback.length} migration(s) to v${targetVersion}...`);

    for (const migration of toRollback) {
        console.log(`[Migrations] Rolling back v${migration.version}: ${migration.description}`);
        db.transaction(() => {
            migration.down(db);
            db.prepare('DELETE FROM _migrations WHERE version = ?').run(migration.version);
        })();
        console.log(`[Migrations] v${migration.version} rolled back.`);
    }

    console.log(`[Migrations] Rollback complete. DB is now at version ${targetVersion}.`);
}
