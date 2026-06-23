import Database from 'better-sqlite3';
import path from 'path';
import { app } from 'electron';
import { runMigrations } from './migrations';
import log from './logger';

let db: Database.Database | null = null;

// Lazily-prepared statements reused by SQL text. Avoids recompiling identical SQL on hot
// paths (per-print recordPack, product search). Cleared when the db is recreated (reset).
const stmtCache = new Map<string, Database.Statement>();
function prep(sql: string): Database.Statement {
    const database = initDatabase();
    let s = stmtCache.get(sql);
    if (!s) { s = database.prepare(sql); stmtCache.set(sql, s); }
    return s;
}

export function initDatabase() {
  if (db) return db;

  try {
    const dbPath = path.join(app.getPath('userData'), 'client_data.db');
    log.info('Initializing database at:', dbPath);

    db = new Database(dbPath);
    log.info('Database instance created');

    // Pragmas for responsiveness on slow eMMC/HDD POS storage. Defaults (rollback journal +
    // synchronous=FULL) fsync on every commit, adding visible lag to each pack write.
    //   WAL          → readers don't block the writer; far fewer fsyncs.
    //   NORMAL       → durable under WAL, no per-commit fsync (safe across app crashes).
    //   busy_timeout → wait for a lock (e.g. during a sync import) instead of throwing.
    //   temp_store   → keep temp B-trees in RAM, not on disk.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('temp_store = MEMORY');

    // Use a transaction for schema creation to ensure atomicity
    const init = db.transaction(() => {
      db!.exec(`
      CREATE TABLE IF NOT EXISTS nomenclature (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        article TEXT,
        exp_date INTEGER NOT NULL,
        portion_container_id INTEGER,
        box_container_id INTEGER,
        templates_pack_label INTEGER,
        templates_box_label INTEGER,
        templates_pallet_label INTEGER,
        close_box_counter INTEGER,
        extra_data TEXT
      );

      CREATE TABLE IF NOT EXISTS container (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        weight REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        password TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pallet (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        number TEXT NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME,
        status TEXT NOT NULL DEFAULT 'Open',
        weight REAL,
        weight_netto REAL,
        weight_brutto REAL
      );

      CREATE TABLE IF NOT EXISTS boxes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pallete_id INTEGER NOT NULL REFERENCES pallet(id),
        number TEXT NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME,
        status TEXT NOT NULL DEFAULT 'Open',
        weight_netto REAL,
        weight_brutto REAL,
        nomenclature_id INTEGER REFERENCES nomenclature(id)
      );

      CREATE TABLE IF NOT EXISTS pack (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        number TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        box_id INTEGER NOT NULL REFERENCES boxes(id),
        nomenclature_id INTEGER NOT NULL REFERENCES nomenclature(id),
        weight_netto REAL NOT NULL,
        weight_brutto REAL NOT NULL,
        barcode_value TEXT,
        station_number TEXT,
        status TEXT NOT NULL,
        production_date TEXT,
        expiration_date TEXT,
        batch TEXT
      );

      CREATE TABLE IF NOT EXISTS station (
        uuid TEXT PRIMARY KEY NOT NULL,
        number INTEGER,
        name TEXT,
        server_url TEXT,
        last_sync_time DATETIME
      );



      CREATE TABLE IF NOT EXISTS barcodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        structure TEXT NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        structure TEXT NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME
      );

      -- Indexes for the per-print hot queries (recordPack / counters / closeBox).
      -- Without these, every pack does full table scans on pack/boxes that grow unbounded.
      CREATE INDEX IF NOT EXISTS idx_pack_box_status ON pack(box_id, status);
      CREATE INDEX IF NOT EXISTS idx_boxes_nom_status ON boxes(nomenclature_id, status);
      CREATE INDEX IF NOT EXISTS idx_boxes_pallet_status ON boxes(pallete_id, status);
      CREATE INDEX IF NOT EXISTS idx_nomenclature_name ON nomenclature(name);
    `);
    });



    init();
    runMigrations(db!);
    runSelfRepairMigration(db!);
    log.info('Database initialized successfully');
    return db;
  } catch (error) {
    log.error('Failed to initialize database:', error);
    throw error;
  }
}

// Migration: Ensure extra_data has Russian keys (Self-Repair)
function runSelfRepairMigration(db: Database.Database) {
  try {
    const products = db.prepare('SELECT id, extra_data FROM nomenclature').all() as any[];
    const updateStmt = db.prepare('UPDATE nomenclature SET extra_data = ? WHERE id = ?');
    const mapping: Record<string, string[]> = {
      'protein': ['белки', 'Белки'],
      'fat': ['жиры', 'Жиры'],
      'carbohydrates': ['углеводы', 'Углеводы'],
      'energy': ['ккал', 'Энергетическая ценность']
    };
    let outputCount = 0;
    for (const prod of products) {
      if (!prod.extra_data) continue;
      try {
        let extra: any = JSON.parse(prod.extra_data);
        let changed = false;
        for (const [eng, targets] of Object.entries(mapping)) {
          // If we have the English key, make sure ALL target Russian keys are present
          if (extra[eng] !== undefined) {
            for (const rus of targets) {
              if (extra[rus] === undefined) {
                extra[rus] = String(extra[eng]).replace('g', 'г').replace('kcal', '');
                changed = true;
              }
            }
          }
          // Also sync between existing Russian keys if one is missing
          const primaryRus = targets[0];
          if (extra[primaryRus] !== undefined) {
            for (const rus of targets.slice(1)) {
              if (extra[rus] === undefined) {
                extra[rus] = extra[primaryRus];
                changed = true;
              }
            }
          }
        }
        if (changed) {
          console.log(`Migration: Repairing nomenclature ${prod.id} (${prod.name}). Keys: ${Object.keys(extra).join(', ')}`);
          updateStmt.run(JSON.stringify(extra), prod.id);
          outputCount++;
        }
      } catch (e) { }
    }
    if (outputCount > 0) console.log(`Migration: Added Russian keys to ${outputCount} products.`);
  } catch (err) {
    // This is expected if table doesn't exist yet before first sync
  }
}

export function getProducts(search: string = '') {
  const db = initDatabase();
  if (!db) return [];

  const baseQuery = `
    SELECT n.*, c.weight as portion_weight 
    FROM nomenclature n
    LEFT JOIN container c ON n.portion_container_id = c.id
  `;

  if (search) {
    const query = `
      ${baseQuery}
      WHERE n.name LIKE @search OR n.article LIKE @search
      ORDER BY n.name ASC
      LIMIT 50
    `;
    const results = prep(query).all({ search: `%${search}%` });
    console.log(`getProducts(search: "${search}") results:`, results.length);
    return results;
  } else {
    const results = prep(`${baseQuery} ORDER BY n.name ASC LIMIT 50`).all();
    console.log('getProducts(all) results:', results.length);
    return results;
  }
}

export function getFixedWeightProducts(search: string = '') {
  const db = initDatabase();
  if (!db) return [];

  const baseQuery = `
    SELECT n.*, c.weight as portion_weight 
    FROM nomenclature n
    LEFT JOIN container c ON n.portion_container_id = c.id
    WHERE n.is_fixed_weight = 1
  `;

  if (search) {
    const query = `
      ${baseQuery}
      AND (n.name LIKE @search OR n.article LIKE @search)
      ORDER BY n.name ASC
      LIMIT 50
    `;
    return prep(query).all({ search: `%${search}%` });
  } else {
    return prep(`${baseQuery} ORDER BY n.name ASC LIMIT 50`).all();
  }
}

export function getContainers() {
  const db = initDatabase();
  if (!db) return [];
  return db.prepare('SELECT * FROM container').all();
}

export function getLabelById(id: number) {
  const db = initDatabase();
  if (!db) return null;
  return db.prepare('SELECT * FROM labels WHERE id = ?').get(id);
}

export function getBarcodeTemplateById(id: number) {
  const db = initDatabase();
  if (!db) return null;
  return db.prepare('SELECT * FROM barcodes WHERE id = ?').get(id);
}


export function getClientUUID(): string | null {
  const db = initDatabase();

  const row = db.prepare('SELECT uuid FROM station LIMIT 1').get() as { uuid: string } | undefined;

  return row ? row.uuid : null;
}


export function getStationInfo() {
  const db = initDatabase();
  const row = db.prepare('SELECT uuid, number FROM station LIMIT 1').get() as { uuid: string, number: number } | undefined;

  if (row) {
    return {
      uuid_client: row.uuid,
      station_number: row.number ? String(row.number).padStart(2, '0') : null
    };
  } else {
    return {
      uuid_client: null,
      station_number: null
    };
  }
}



export function recordPack(data: {
  number: string;
  box_number: string;
  nomenclature_id: number;
  weight_netto: number;
  weight_brutto: number;
  barcode_value: string;
  station_number?: string;
  production_date?: string;
  expiration_date?: string;
  batch?: string;
}) {
  const startTime = Date.now();
  const db = initDatabase();
  let newBoxCreated = false;
  return db.transaction(() => {
    // 1. Find or create an open box for this nomenclature
    let box = prep("SELECT id, number FROM boxes WHERE status = 'Open' AND nomenclature_id = ? ORDER BY id DESC LIMIT 1").get(data.nomenclature_id) as { id: number, number: string } | undefined;

    if (!box) {
      // Need a default pallet if none exists
      let pallet = prep("SELECT id FROM pallet WHERE status = 'Open' ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
      if (!pallet) {
        const palletInfo = { number: `P${Date.now()}`, status: 'Open' };
        const result = prep('INSERT INTO pallet (number, status) VALUES (?, ?)').run(palletInfo.number, palletInfo.status);
        pallet = { id: result.lastInsertRowid as number };
      }

      let actualNumber = data.box_number;
      let boxResult;
      let attempts = 0;

      while (attempts < 50) {
        try {
          boxResult = prep("INSERT INTO boxes (pallete_id, number, status, nomenclature_id) VALUES (?, ?, 'Open', ?)").run(
            pallet.id,
            actualNumber,
            data.nomenclature_id
          );
          box = { id: boxResult.lastInsertRowid as number, number: actualNumber };
          newBoxCreated = true;
          break;
        } catch (err: any) {
          if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.message.includes('UNIQUE')) {
            attempts++;
            // If the number is taken, try to find a new one by incrementing the total count
            const nextCount = (prep('SELECT COUNT(*) as total FROM boxes').get() as { total: number }).total + 1;
            // Best effort to preserve formatting if it was just a number
            if (/^\d+$/.test(actualNumber)) {
              actualNumber = String(nextCount);
            } else {
              actualNumber = `${data.box_number}_${attempts}`;
            }
          } else {
            throw err;
          }
        }
      }
      if (!box) throw new Error('Could not find a unique box number after 50 attempts');
    }

    // 2. Insert the pack
    prep(`
      INSERT INTO pack (number, box_id, nomenclature_id, weight_netto, weight_brutto, barcode_value, station_number, status, production_date, expiration_date, batch)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Printed', ?, ?, ?)
    `).run(
      data.number,
      box.id,
      data.nomenclature_id,
      data.weight_netto,
      data.weight_brutto,
      data.barcode_value,
      data.station_number || null,
      data.production_date || null,
      data.expiration_date || null,
      data.batch || null
    );

    const duration = Date.now() - startTime;
    console.log(`Database: recordPack completed in ${duration}ms (New box: ${newBoxCreated}, Box Number: ${box.number})`);
    return { success: true, boxId: box.id, boxNumber: box.number, newBoxCreated };
  })();
}

export function closeBox(boxId: number, weightNetto: number, weightBrutto: number) {
  const db = initDatabase();
  db.prepare("UPDATE boxes SET status = 'Closed', weight_netto = ?, weight_brutto = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
    weightNetto,
    weightBrutto,
    boxId
  );
  return { success: true };
}

export function getLatestCounters(nomenclatureId?: number) {
  const db = initDatabase();

  const lastPack = db.prepare('SELECT number FROM pack ORDER BY id DESC LIMIT 1').get() as { number: string } | undefined;
  const lastBox = db.prepare('SELECT number FROM boxes ORDER BY id DESC LIMIT 1').get() as { number: string } | undefined;
  const totalUnits = db.prepare('SELECT COUNT(*) as total FROM pack').get() as { total: number };
  const totalBoxes = db.prepare('SELECT COUNT(*) as total FROM boxes').get() as { total: number };

  // Count boxes on the currently open pallet
  const openPallet = db.prepare("SELECT id FROM pallet WHERE status = 'Open' ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
  let boxesInPallet = 0;
  if (openPallet) {
    const res = db.prepare("SELECT COUNT(*) as count FROM boxes WHERE pallete_id = ? AND status != 'Deleted'").get(openPallet.id) as { count: number };
    boxesInPallet = res.count;
  }

  // Count packs in the currently open box
  // We need to find the open box first. Logic similar to recordPack but read-only.
  // Ideally, an open box belongs to the open pallet, but strictly speaking it just needs status='Open'.
  // Let's find the most recent open box.
  let openBoxQuery = "SELECT id, number FROM boxes WHERE status = 'Open'";
  const queryArgs: any[] = [];

  if (nomenclatureId) {
    openBoxQuery += " AND nomenclature_id = ?";
    queryArgs.push(nomenclatureId);
  }

  openBoxQuery += " ORDER BY id DESC LIMIT 1";

  const openBox = db.prepare(openBoxQuery).get(...queryArgs) as { id: number, number: string } | undefined;
  let unitsInBox = 0;
  let boxNetWeight = 0;

  if (openBox) {
    const res = db.prepare("SELECT COUNT(*) as count, SUM(weight_netto) as current_weight FROM pack WHERE box_id = ? AND status != 'Deleted'").get(openBox.id) as { count: number, current_weight: number | null };
    unitsInBox = res.count;
    boxNetWeight = res.current_weight || 0;
  }

  const finalCounters = {
    lastPackNumber: lastPack?.number || '0',
    lastBoxNumber: lastBox?.number || '0',
    totalUnits: totalUnits.total,
    totalBoxes: totalBoxes.total,
    boxesInPallet: boxesInPallet,
    unitsInBox: unitsInBox,
    boxNetWeight: boxNetWeight,
    currentBoxId: openBox?.id || null,
    currentBoxNumber: openBox?.number || null
  };

  return finalCounters;
}

export function importFullDump(payload: any) {
  const startTime = Date.now();
  const db = initDatabase();
  console.log('Database: Starting full import dump... Keys in payload:', Object.keys(payload));

  const toPrim = (val: any) => {
    if (val === null || val === undefined) return null;
    if (typeof val === 'object') return val.id ?? null;
    return val;
  };

  // Disable foreign keys temporarily to allow deleting referenced nomenclature
  db.pragma('foreign_keys = OFF');

  try {
    const runImport = db.transaction(() => {
      // 1. Clear master tables (only what comes from server)
      db!.prepare('DELETE FROM nomenclature').run();
      db!.prepare('DELETE FROM container').run();
      db!.prepare('DELETE FROM barcodes').run();
      db!.prepare('DELETE FROM labels').run();

      // 2. Insert nomenclature
      if (payload.nomenclature && Array.isArray(payload.nomenclature)) {
        const stmt = db!.prepare(`
          INSERT INTO nomenclature (
            id, name, article, exp_date, portion_container_id,
            box_container_id, templates_pack_label, templates_box_label, templates_pallet_label,
            close_box_counter, extra_data,
            is_fixed_weight, fixed_weight_grams, min_weight_grams, max_weight_grams
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const item of payload.nomenclature) {
          try {
            stmt.run(
              toPrim(item.id),
              toPrim(item.name),
              toPrim(item.article),
              toPrim(item.exp_date) || 0,
              toPrim(item.portion_container_id) ?? toPrim(item.portion_container) ?? null,
              toPrim(item.box_container_id) ?? toPrim(item.box_container) ?? null,
              toPrim(item.templates_pack_label) ?? null,
              toPrim(item.templates_box_label) ?? null,
              toPrim(item.templates_pallet_label) ?? null,
              toPrim(item.close_box_counter) || 0,
              typeof item.extra_data === 'string' ? item.extra_data : JSON.stringify(item.extra_data || {}),
              item.is_fixed_weight ? 1 : 0,
              toPrim(item.fixed_weight_grams) || 0,
              toPrim(item.min_weight_grams) || 0,
              toPrim(item.max_weight_grams) || 0
            );
          } catch (err: any) {
            console.warn(`Skipping nomenclature item ${item.id} due to error:`, err.message);
          }
        }
      }

      // 3. Insert containers
      const containers = payload.containers || payload.container;
      if (containers && Array.isArray(containers)) {
        const stmt = db!.prepare('INSERT INTO container (id, name, weight) VALUES (?, ?, ?)');
        for (const item of containers) {
          try {
            stmt.run(toPrim(item.id), toPrim(item.name), toPrim(item.weight) || 0);
          } catch (err: any) {
            console.warn(`Skipping container item ${item.id} due to error:`, err.message);
          }
        }
      }

      // 4. Insert barcodes
      if (payload.barcodes && Array.isArray(payload.barcodes)) {
        const stmt = db!.prepare('INSERT OR REPLACE INTO barcodes (id, name, structure) VALUES (?, ?, ?)');
        let insertedCount = 0;
        for (const item of payload.barcodes) {
          try {
            const structure = typeof item.structure === 'string' ? item.structure : JSON.stringify(item.structure);
            if (!structure) {
              console.warn(`Skipping barcode ${item.id} (${item.name}): missing structure`);
              continue;
            }
            stmt.run(toPrim(item.id), toPrim(item.name), structure);
            insertedCount++;
          } catch (err: any) {
            console.warn(`Skipping barcode item ${item.id} due to error:`, err.message);
          }
        }
        console.log(`Database: Imported ${insertedCount}/${payload.barcodes.length} barcodes`);
      }

      // 5. Insert labels
      if (payload.labels && Array.isArray(payload.labels)) {
        const stmt = db!.prepare('INSERT OR REPLACE INTO labels (id, name, structure, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
        let insertedCount = 0;
        for (const item of payload.labels) {
          try {
            const structure = typeof item.structure === 'string' ? item.structure : JSON.stringify(item.structure);
            if (!structure) {
              console.warn(`Skipping label ${item.id} (${item.name}): missing structure`);
              continue;
            }
            stmt.run(
              toPrim(item.id),
              toPrim(item.name),
              structure,
              toPrim(item.created_at),
              toPrim(item.updated_at)
            );
            insertedCount++;
          } catch (err: any) {
            console.warn(`Skipping label item ${item.id} due to error:`, err.message);
          }
        }
        console.log(`Database: Imported ${insertedCount}/${payload.labels.length} labels`);
      }

      // 6. Update station number if provided
      if (payload.station_number) {
        db!.prepare('UPDATE station SET number = ?').run(payload.station_number);
        console.log(`Database: Updated station number to ${payload.station_number}`);
      }

      console.log('Database: Import sync completed successfully');
      return { success: true };
    });

    const duration = Date.now() - startTime;
    console.log(`Database: importFullDump completed in ${duration}ms`);
    return runImport();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

export function getStationIdentity() {
  const db = initDatabase();
  return db.prepare('SELECT * FROM station LIMIT 1').get() as any;
}

export function updateStationIdentity(data: { uuid: string; number: number; name: string; server_url: string; last_sync_time?: string }) {
  const db = initDatabase();
  const existing = getStationIdentity();

  if (existing) {
    db.prepare(`
      UPDATE station 
      SET uuid = ?, number = ?, name = ?, server_url = ?, last_sync_time = ?
      WHERE uuid = ?
    `).run(data.uuid, data.number, data.name, data.server_url, data.last_sync_time || new Date().toISOString(), existing.uuid);
  } else {
    db.prepare(`
      INSERT INTO station (uuid, number, name, server_url, last_sync_time)
      VALUES (?, ?, ?, ?, ?)
    `).run(data.uuid, data.number, data.name, data.server_url, data.last_sync_time || new Date().toISOString());
  }
}

export function resetDatabase() {
  const sqliteDb = initDatabase();
  console.log('Database: PERFORMING FULL RESET...');

  // Drop all tables
  const tables = sqliteDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];

  // Disable foreign keys to allow dropping interdependent tables
  try {
    sqliteDb.pragma('foreign_keys = OFF');
    sqliteDb.transaction(() => {
      for (const table of tables) {
        sqliteDb.prepare(`DROP TABLE IF EXISTS ${table.name}`).run();
      }
    })();
  } finally {
    sqliteDb.pragma('foreign_keys = ON');
  }

  // Close and clear the singleton to force a fresh start on next access
  sqliteDb.close();
  db = null;
  stmtCache.clear(); // cached statements are bound to the now-closed db

  console.log('Database: All tables dropped and connection closed. Re-initializing schema...');
  // Force re-initialization
  initDatabase();
  console.log('Database: RESET COMPLETE.');
}

export function getExportData() {
  const db = initDatabase();
  // Gather data for export (e.g., packs, boxes, logs)
  // For now, we export packs and boxes that have been created locally.
  // In a real scenario, we might want to filter by date or status.
  const packs = db.prepare('SELECT * FROM pack').all();
  const boxes = db.prepare('SELECT * FROM boxes').all();
  const pallets = db.prepare('SELECT * FROM pallet').all();
  // We can also add system logs if we had a table for them.

  return {
    packs,
    boxes,
    pallets,
    generated_at: new Date().toISOString()
  };
}

// --- Deletion Logic ---

export function getOpenPalletContent() {
  const db = initDatabase();

  // 1. Get Open Pallet
  const pallet = db.prepare("SELECT * FROM pallet WHERE status = 'Open' ORDER BY id DESC LIMIT 1").get() as any;
  if (!pallet) return null;

  // 2. Get Open Box (if any)
  const openBox = db.prepare("SELECT * FROM boxes WHERE pallete_id = ? AND status = 'Open' ORDER BY id DESC LIMIT 1").get(pallet.id) as any;

  // 3. Get All Boxes in Pallet (for list view)
  const boxes = db.prepare("SELECT * FROM boxes WHERE pallete_id = ? ORDER BY id DESC").all(pallet.id);

  // 4. Get Packs in Current Open Box (if available)
  let currentBoxPacks: any[] = [];
  if (openBox) {
    currentBoxPacks = db.prepare("SELECT * FROM pack WHERE box_id = ? ORDER BY id DESC").all(openBox.id);
  }

  return {
    pallet,
    openBox,
    boxesInPallet: boxes,
    packsInCurrentBox: currentBoxPacks
  };
}

// ── Pallet sheet render data ──────────────────────────────────────────────
// Format an ISO date string to dd.mm.yyyy (matches the pallet-sheet contract samples).
function fmtPalletDate(iso: any): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

/**
 * Pure aggregator: turn joined pack+nomenclature rows of one pallet into the pallet-sheet
 * render contract (scalar header keys + items[] table rows). Each pack counts as 1 unit;
 * rows are grouped by (nomenclature, batch) into table positions. Exported for testability.
 */
export function buildPalletRenderData(rows: any[], pallet: any, ctx: { operator_name?: string } = {}) {
  const groups = new Map<string, any>();
  const order: string[] = [];
  const nomTotals = new Map<number, { net: number; brut: number }>();
  const batchTotals = new Map<string, { net: number; brut: number }>();
  const boxIds = new Set<number>();
  let totalNet = 0, totalBrut = 0, totalPacks = 0;

  for (const r of rows) {
    const batch = r.batch ?? '';
    const key = `${r.nomenclature_id}::${batch}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        nomenclature_id: r.nomenclature_id, name: r.name ?? '', article: r.article ?? '',
        batch, production_date: r.production_date ?? '', expiration_date: r.expiration_date ?? '',
        exp_date_days: r.exp_date, qty: 0, net: 0, brut: 0,
      };
      groups.set(key, g); order.push(key);
    }
    g.qty += 1;
    g.net += (r.weight_netto || 0);
    g.brut += (r.weight_brutto || 0);
    if (!g.production_date && r.production_date) g.production_date = r.production_date;
    if (!g.expiration_date && r.expiration_date) g.expiration_date = r.expiration_date;

    boxIds.add(r.box_id);
    totalNet += (r.weight_netto || 0); totalBrut += (r.weight_brutto || 0); totalPacks += 1;

    const nt = nomTotals.get(r.nomenclature_id) || { net: 0, brut: 0 };
    nt.net += (r.weight_netto || 0); nt.brut += (r.weight_brutto || 0); nomTotals.set(r.nomenclature_id, nt);
    const bt = batchTotals.get(batch) || { net: 0, brut: 0 };
    bt.net += (r.weight_netto || 0); bt.brut += (r.weight_brutto || 0); batchTotals.set(batch, bt);
  }

  const items = order.map((key) => {
    const g = groups.get(key);
    const nt = nomTotals.get(g.nomenclature_id) || { net: 0, brut: 0 };
    const bt = batchTotals.get(g.batch) || { net: 0, brut: 0 };
    const prod = fmtPalletDate(g.production_date);
    let exp = fmtPalletDate(g.expiration_date);
    if (!exp && g.production_date && g.exp_date_days) {
      const d = new Date(g.production_date);
      if (!isNaN(d.getTime())) { d.setDate(d.getDate() + Number(g.exp_date_days)); exp = fmtPalletDate(d.toISOString()); }
    }
    return {
      name: g.name, article: g.article, quantity: String(g.qty), batch_number: g.batch,
      production_date_batch: prod, exp_date_full: exp,
      weight_netto_pack: g.net.toFixed(3), weight_brutto_pack: g.brut.toFixed(3),
      weight_netto_batch: bt.net.toFixed(3), weight_brutto_batch: bt.brut.toFixed(3),
      weight_netto_nomenclature: nt.net.toFixed(3), weight_brutto_nomenclature: nt.brut.toFixed(3),
    };
  });

  return {
    pallet_number: pallet?.number ?? '',
    shipping_date: '',                                  // not tracked locally (v1)
    production_date: items[0]?.production_date_batch ?? '',
    operator_name: ctx?.operator_name ?? '',
    total_count: String(totalPacks),
    total_places: String(order.length),
    total_boxes: String(boxIds.size),
    weight_total: totalBrut.toFixed(3),
    weight_netto_pallet: totalNet.toFixed(3),
    weight_brutto_pallet: totalBrut.toFixed(3),
    items,
  };
}

/**
 * Build pallet-sheet render data for the current OPEN pallet from local data.
 * Returns null if there is no open pallet. Joins nomenclature for name/article
 * (pack/boxes rows don't carry them). Includes packs from ALL boxes of the pallet.
 */
export function getPalletRenderData(ctx: { operator_name?: string } = {}) {
  const db = initDatabase();
  const pallet = db.prepare("SELECT * FROM pallet WHERE status = 'Open' ORDER BY id DESC LIMIT 1").get() as any;
  if (!pallet) return null;
  // A pallet sheet finalizes ("closes") the pallet, so a box that still has CONTENT must be
  // closed first. An open box with zero non-deleted packs is effectively empty (e.g. its packs
  // were deleted) — it does not represent work in progress and must NOT block the pallet,
  // otherwise the user gets stuck: handleCloseBox refuses to close an empty box.
  const openBox = db.prepare(`
    SELECT b.id FROM boxes b
    WHERE b.pallete_id = ? AND b.status = 'Open'
      AND EXISTS (SELECT 1 FROM pack p WHERE p.box_id = b.id AND p.status != 'Deleted')
    LIMIT 1
  `).get(pallet.id) as any;
  const rows = prep(`
    SELECT p.id AS pack_id, p.box_id, p.nomenclature_id, p.weight_netto, p.weight_brutto,
           p.production_date, p.expiration_date, p.batch, n.name, n.article, n.exp_date
    FROM pack p
    JOIN boxes b ON b.id = p.box_id
    LEFT JOIN nomenclature n ON n.id = p.nomenclature_id
    WHERE b.pallete_id = ? AND p.status != 'Deleted' AND b.status != 'Deleted'
    ORDER BY n.name COLLATE NOCASE, p.batch, p.id
  `).all(pallet.id) as any[];
  return { ...buildPalletRenderData(rows, pallet, ctx), hasOpenBox: !!openBox };
}

/**
 * Close the current open pallet (status → 'Closed'). Called after a pallet sheet prints, so
 * the next recorded pack starts a fresh pallet. Returns success:false if no open pallet.
 */
export function closeCurrentPallet() {
  const db = initDatabase();
  return db.transaction(() => {
    const pallet = db.prepare("SELECT id FROM pallet WHERE status = 'Open' ORDER BY id DESC LIMIT 1").get() as any;
    if (!pallet) return { success: false as const };
    // Close any leftover EMPTY open boxes on this pallet (boxes with no non-deleted packs).
    // If they stayed 'Open', recordPack would reuse them (it matches by status+nomenclature,
    // not by pallet) and new packs would land on this now-closed pallet, orphaning them.
    // Boxes that still hold content are left untouched (the print guard prevents reaching here
    // with a non-empty open box), so no packed box is ever silently closed.
    db.prepare(`
      UPDATE boxes SET status = 'Closed', updated_at = CURRENT_TIMESTAMP
      WHERE pallete_id = ? AND status = 'Open'
        AND NOT EXISTS (SELECT 1 FROM pack p WHERE p.box_id = boxes.id AND p.status != 'Deleted')
    `).run(pallet.id);
    db.prepare("UPDATE pallet SET status = 'Closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(pallet.id);
    return { success: true as const, palletId: pallet.id };
  })();
}

export function deletePack(packId: number) {
  const db = initDatabase();

  return db.transaction(() => {
    // 1. Get Pack and verify it's in an open box
    const pack = db!.prepare("SELECT * FROM pack WHERE id = ?").get(packId) as any;
    if (!pack) throw new Error("Pack not found");
    if (pack.status === 'Deleted') throw new Error("Pack already deleted");

    const box = db!.prepare("SELECT * FROM boxes WHERE id = ?").get(pack.box_id) as any;
    if (!box) throw new Error("Box not found"); // Should not happen
    if (box.status !== 'Open') throw new Error("Cannot delete pack from a closed box");

    // 2. Mark Pack as Deleted
    db!.prepare("UPDATE pack SET status = 'Deleted' WHERE id = ?").run(packId);

    // 3. Update Box Weights (Subtract)
    const newBoxNet = Math.max(0, (box.weight_netto || 0) - pack.weight_netto);
    const newBoxBrut = Math.max(0, (box.weight_brutto || 0) - pack.weight_brutto);

    db!.prepare("UPDATE boxes SET weight_netto = ?, weight_brutto = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
      newBoxNet,
      newBoxBrut,
      box.id
    );

    // 4. Update Pallet Weights (Subtract)
    // Note: Pallet weights are usually calculated on the fly or closed, but if we maintain running total:
    // This part depends on if we track pallet weight live. The schema has weight fields.
    // Let's assume we do update them if they exist.
    const pallet = db!.prepare("SELECT * FROM pallet WHERE id = ?").get(box.pallete_id) as any;
    if (pallet) {
      // Only update if pallet has weights (it might be null initially)
      const currentPalletNet = pallet.weight_netto || 0;
      const currentPalletBrut = pallet.weight_brutto || 0;

      // Subtract only if the box weight hasn't been fully finalized/stamped? 
      // Actually, if we reduce box weight, we should reduce pallet weight.
      const newPalletNet = Math.max(0, currentPalletNet - pack.weight_netto);
      const newPalletBrut = Math.max(0, currentPalletBrut - pack.weight_brutto);

      db!.prepare("UPDATE pallet SET weight_netto = ?, weight_brutto = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
        newPalletNet,
        newPalletBrut,
        pallet.id
      );
    }

    return { success: true, boxId: box.id };
  })();
}

export function deleteBox(boxId: number) {
  const db = initDatabase();

  return db.transaction(() => {
    // 1. Get Box and verify it's in an open pallet
    const box = db!.prepare("SELECT * FROM boxes WHERE id = ?").get(boxId) as any;
    if (!box) throw new Error("Box not found");
    if (box.status === 'Deleted') throw new Error("Box already deleted");

    const pallet = db!.prepare("SELECT * FROM pallet WHERE id = ?").get(box.pallete_id) as any;
    if (!pallet) throw new Error("Pallet not found");
    if (pallet.status !== 'Open') throw new Error("Cannot delete box from a closed pallet");

    // 2. Mark Box as Deleted
    db!.prepare("UPDATE boxes SET status = 'Deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(boxId);

    // 3. Mark all Packs in Box as Deleted
    db!.prepare("UPDATE pack SET status = 'Deleted' WHERE box_id = ?").run(boxId);

    // 4. Update Pallet Weights (Subtract Box Weight)
    // Note: A box has its own weight (contents + box tare).
    // If the box is deleted, we remove its entire contribution to the pallet.

    const currentPalletNet = pallet.weight_netto || 0;
    const currentPalletBrut = pallet.weight_brutto || 0;

    const newPalletNet = Math.max(0, currentPalletNet - (box.weight_netto || 0));
    const newPalletBrut = Math.max(0, currentPalletBrut - (box.weight_brutto || 0));

    db!.prepare("UPDATE pallet SET weight_netto = ?, weight_brutto = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
      newPalletNet,
      newPalletBrut,
      pallet.id
    );

    return { success: true, palletId: pallet.id };
  })();
}

// --- Print Jobs ---

export function savePrintJob(job: {
  job_id: number;
  nomenclature_id: number;
  nomenclature_name: string;
  nomenclature_article?: string;
  quantity: number;
  quantity_unit: string;
  batch_number?: string;
  marking_date?: string | null;
}) {
  const db = initDatabase();
  db.prepare(`
    INSERT OR REPLACE INTO print_jobs (job_id, nomenclature_id, nomenclature_name, nomenclature_article, quantity, quantity_unit, batch_number, marking_date, printed_qty, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT printed_qty FROM print_jobs WHERE job_id = ?), 0), COALESCE((SELECT status FROM print_jobs WHERE job_id = ? AND status = 'completed'), 'pending'))
  `).run(
    job.job_id,
    job.nomenclature_id,
    job.nomenclature_name,
    job.nomenclature_article || null,
    job.quantity,
    job.quantity_unit || 'pcs',
    job.batch_number || null,
    job.marking_date || null,
    job.job_id,
    job.job_id
  );
}

export function getPrintJobs(statusFilter?: string) {
  const db = initDatabase();
  if (statusFilter) {
    return db.prepare('SELECT * FROM print_jobs WHERE status = ? ORDER BY created_at DESC').all(statusFilter);
  }
  return db.prepare('SELECT * FROM print_jobs ORDER BY CASE status WHEN \'in_progress\' THEN 0 WHEN \'pending\' THEN 1 WHEN \'completed\' THEN 2 END, created_at DESC').all();
}

export function updatePrintJobProgress(jobId: number, printedQty: number) {
  const db = initDatabase();
  const job = db.prepare('SELECT * FROM print_jobs WHERE job_id = ?').get(jobId) as any;
  if (!job) throw new Error(`Print job #${jobId} not found`);

  const newPrintedQty = printedQty;
  const newStatus = newPrintedQty >= job.quantity ? 'completed' : 'in_progress';

  db.prepare(`
    UPDATE print_jobs SET printed_qty = ?, status = ?, completed_at = CASE WHEN ? = 'completed' THEN CURRENT_TIMESTAMP ELSE completed_at END
    WHERE job_id = ?
  `).run(newPrintedQty, newStatus, newStatus, jobId);

  return { success: true, status: newStatus, printed_qty: newPrintedQty, quantity: job.quantity };
}

export function completePrintJob(jobId: number) {
  const db = initDatabase();
  db.prepare("UPDATE print_jobs SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE job_id = ?").run(jobId);
  return { success: true };
}

export function deletePrintJob(jobId: number) {
  const db = initDatabase();
  db.prepare('DELETE FROM print_jobs WHERE job_id = ?').run(jobId);
  return { success: true };
}

