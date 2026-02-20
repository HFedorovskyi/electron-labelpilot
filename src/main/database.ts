import Database from 'better-sqlite3';
import path from 'path';
import { app } from 'electron';
import { runMigrations } from './migrations';

let db: Database.Database | null = null;

export function initDatabase() {
  if (db) return db;

  const dbPath = path.join(app.getPath('userData'), 'client_data.db');
  console.log('Initializing database at:', dbPath);

  db = new Database(dbPath);

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
        status TEXT NOT NULL
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
    `);
  });



  init();
  runMigrations(db!);
  runSelfRepairMigration(db!);
  return db;
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
    const results = db.prepare(query).all({ search: `%${search}%` });
    console.log(`getProducts(search: "${search}") results:`, results.length);
    return results;
  } else {
    const results = db.prepare(`${baseQuery} ORDER BY n.name ASC LIMIT 50`).all();
    console.log('getProducts(all) results:', results.length);
    return results;
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

export function getTables() {
  const db = initDatabase();
  if (!db) return [];
  // Exclude sqlite internal tables
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
}

export function getTableData(tableName: string) {
  const db = initDatabase();
  if (!db) return [];

  // Security check: ensure tableName is a valid table name from our list
  const tables = getTables() as { name: string }[];
  if (!tables.some(t => t.name === tableName)) {
    throw new Error(`Invalid table name: ${tableName}`);
  }

  // Optimize: Limit rows for large tables to prevent memory explosion
  return db.prepare(`SELECT * FROM ${tableName} ORDER BY id DESC LIMIT 100`).all();
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
}) {
  const startTime = Date.now();
  const db = initDatabase();
  let newBoxCreated = false;
  return db.transaction(() => {
    // 1. Find or create an open box for this nomenclature
    let box = db!.prepare("SELECT id, number FROM boxes WHERE status = 'Open' AND nomenclature_id = ? ORDER BY id DESC LIMIT 1").get(data.nomenclature_id) as { id: number, number: string } | undefined;

    if (!box) {
      // Need a default pallet if none exists
      let pallet = db!.prepare("SELECT id FROM pallet WHERE status = 'Open' ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
      if (!pallet) {
        const palletInfo = { number: `P${Date.now()}`, status: 'Open' };
        const result = db!.prepare('INSERT INTO pallet (number, status) VALUES (?, ?)').run(palletInfo.number, palletInfo.status);
        pallet = { id: result.lastInsertRowid as number };
      }

      let actualNumber = data.box_number;
      let boxResult;
      let attempts = 0;

      while (attempts < 50) {
        try {
          boxResult = db!.prepare("INSERT INTO boxes (pallete_id, number, status, nomenclature_id) VALUES (?, ?, 'Open', ?)").run(
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
            const nextCount = (db!.prepare('SELECT COUNT(*) as total FROM boxes').get() as { total: number }).total + 1;
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
    db!.prepare(`
      INSERT INTO pack (number, box_id, nomenclature_id, weight_netto, weight_brutto, barcode_value, station_number, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Printed')
    `).run(
      data.number,
      box.id,
      data.nomenclature_id,
      data.weight_netto,
      data.weight_brutto,
      data.barcode_value,
      data.station_number || null
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
            box_container_id, templates_pack_label, templates_box_label, 
            close_box_counter, extra_data
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
              toPrim(item.close_box_counter) || 0,
              typeof item.extra_data === 'string' ? item.extra_data : JSON.stringify(item.extra_data || {})
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
        const stmt = db!.prepare('INSERT INTO barcodes (id, name, structure) VALUES (?, ?, ?)');
        for (const item of payload.barcodes) {
          try {
            const structure = toPrim(item.structure);
            if (!structure) {
              console.warn(`Skipping barcode ${item.id} (${item.name}): missing structure`);
              continue;
            }
            stmt.run(toPrim(item.id), toPrim(item.name), structure);
          } catch (err: any) {
            console.warn(`Skipping barcode item ${item.id} due to error:`, err.message);
          }
        }
      }

      // 5. Insert labels
      if (payload.labels && Array.isArray(payload.labels)) {
        const stmt = db!.prepare('INSERT INTO labels (id, name, structure, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
        for (const item of payload.labels) {
          try {
            const structure = toPrim(item.structure);
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
          } catch (err: any) {
            console.warn(`Skipping label item ${item.id} due to error:`, err.message);
          }
        }
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
