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
    {
        version: 2,
        description: 'Add production_date, expiration_date, and batch columns to pack',
        up(db) {
            const addColumn = (col: string) => {
                try {
                    db.exec(`ALTER TABLE pack ADD COLUMN ${col} TEXT;`);
                } catch (e: any) {
                    if (!e.message.includes('duplicate column')) throw e;
                }
            };
            addColumn('production_date');
            addColumn('expiration_date');
            addColumn('batch');
        },
        down(db) {
            // SQLite < 3.35 doesn't support DROP COLUMN — recreate table
            db.exec(`
          CREATE TABLE pack_bak AS SELECT id, number, created_at, box_id, nomenclature_id, weight_netto, weight_brutto, barcode_value, station_number, status FROM pack;
          DROP TABLE pack;
          ALTER TABLE pack_bak RENAME TO pack;
        `);
        }
    },
    {
        version: 3,
        description: 'Remove UNIQUE constraints from labels table (name and structure)',
        up(db) {
            // Recreate labels table without UNIQUE constraints
            // SQLite doesn't support DROP CONSTRAINT, so we rebuild the table
            try {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS labels_new (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        name TEXT NOT NULL,
                        structure TEXT NOT NULL,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME
                    );
                    INSERT OR IGNORE INTO labels_new SELECT * FROM labels;
                    DROP TABLE labels;
                    ALTER TABLE labels_new RENAME TO labels;
                `);
                console.log('[Migration v3] Labels table rebuilt without UNIQUE constraints');
            } catch (e: any) {
                console.warn('[Migration v3] Warning:', e.message);
            }
        },
        down(db) {
            // Add back UNIQUE constraints (lossy if duplicates exist)
            try {
                db.exec(`
                    CREATE TABLE labels_old (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        name TEXT NOT NULL UNIQUE,
                        structure TEXT NOT NULL UNIQUE,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME
                    );
                    INSERT OR IGNORE INTO labels_old SELECT * FROM labels;
                    DROP TABLE labels;
                    ALTER TABLE labels_old RENAME TO labels;
                `);
            } catch (e: any) {
                console.warn('[Migration v3 rollback] Warning:', e.message);
            }
        }
    },
    {
        version: 4,
        description: 'Add fixed weight columns to nomenclature',
        up(db) {
            const addColumn = (col: string, type: string, defaultVal: string) => {
                try {
                    db.exec(`ALTER TABLE nomenclature ADD COLUMN ${col} ${type} DEFAULT ${defaultVal};`);
                } catch (e: any) {
                    if (!e.message.includes('duplicate column')) throw e;
                }
            };
            addColumn('is_fixed_weight', 'INTEGER', '0');
            addColumn('fixed_weight_grams', 'REAL', '0');
            addColumn('min_weight_grams', 'REAL', '0');
            addColumn('max_weight_grams', 'REAL', '0');
        },
        down(_db) {
            // SQLite < 3.35 doesn't support DROP COLUMN — columns will remain but be unused
        }
    },
    {
        version: 5,
        description: 'Create print_jobs table for task-based labeling',
        up(db) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS print_jobs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id INTEGER NOT NULL UNIQUE,
                    nomenclature_id INTEGER NOT NULL,
                    nomenclature_name TEXT NOT NULL,
                    nomenclature_article TEXT,
                    quantity REAL NOT NULL,
                    quantity_unit TEXT NOT NULL DEFAULT 'pcs',
                    batch_number TEXT,
                    printed_qty REAL NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'pending',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    completed_at DATETIME
                );
            `);
            console.log('[Migration v5] Created print_jobs table');
        },
        down(db) {
            db.exec('DROP TABLE IF EXISTS print_jobs;');
        }
    },
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
