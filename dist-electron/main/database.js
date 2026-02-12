"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initDatabase = initDatabase;
exports.getProducts = getProducts;
exports.getContainers = getContainers;
exports.getLabelById = getLabelById;
exports.getBarcodeTemplateById = getBarcodeTemplateById;
exports.getTables = getTables;
exports.getTableData = getTableData;
exports.getOrCreateClientUUID = getOrCreateClientUUID;
exports.getStationInfo = getStationInfo;
exports.recordPack = recordPack;
exports.closeBox = closeBox;
exports.getLatestCounters = getLatestCounters;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
let db = null;
function initDatabase() {
    if (db)
        return db;
    const dbPath = path_1.default.join(electron_1.app.getPath('userData'), 'client_data.db');
    console.log('Initializing database at:', dbPath);
    db = new better_sqlite3_1.default(dbPath);
    // Use a transaction for schema creation to ensure atomicity
    const init = db.transaction(() => {
        db.exec(`
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

      CREATE TABLE IF NOT EXISTS uuid (
        uuid_client TEXT PRIMARY KEY NOT NULL,
        station_number TEXT
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
    runSelfRepairMigration(db);
    return db;
}
// Migration: Ensure extra_data has Russian keys (Self-Repair)
function runSelfRepairMigration(db) {
    try {
        const products = db.prepare('SELECT id, extra_data FROM nomenclature').all();
        const updateStmt = db.prepare('UPDATE nomenclature SET extra_data = ? WHERE id = ?');
        const mapping = {
            'protein': 'белки',
            'fat': 'жиры',
            'carbohydrates': 'углеводы',
            'energy': 'ккал'
        };
        let outputCount = 0;
        for (const prod of products) {
            if (!prod.extra_data)
                continue;
            try {
                let extra = JSON.parse(prod.extra_data);
                let changed = false;
                for (const [eng, rus] of Object.entries(mapping)) {
                    if (extra[eng] && !extra[rus]) {
                        extra[rus] = String(extra[eng]).replace('g', 'г').replace('kcal', '');
                        changed = true;
                    }
                }
                if (changed) {
                    updateStmt.run(JSON.stringify(extra), prod.id);
                    outputCount++;
                }
            }
            catch (e) { }
        }
        if (outputCount > 0)
            console.log(`Migration: Added Russian keys to ${outputCount} products.`);
    }
    catch (err) {
        // This is expected if table doesn't exist yet before first sync
    }
}
function getProducts(search = '') {
    const db = initDatabase();
    if (!db)
        return [];
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
    }
    else {
        const results = db.prepare(`${baseQuery} ORDER BY n.name ASC LIMIT 50`).all();
        console.log('getProducts(all) results:', results.length);
        return results;
    }
}
function getContainers() {
    const db = initDatabase();
    if (!db)
        return [];
    return db.prepare('SELECT * FROM container').all();
}
function getLabelById(id) {
    const db = initDatabase();
    if (!db)
        return null;
    return db.prepare('SELECT * FROM labels WHERE id = ?').get(id);
}
function getBarcodeTemplateById(id) {
    const db = initDatabase();
    if (!db)
        return null;
    return db.prepare('SELECT * FROM barcodes WHERE id = ?').get(id);
}
function getTables() {
    const db = initDatabase();
    if (!db)
        return [];
    // Exclude sqlite internal tables
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
}
function getTableData(tableName) {
    const db = initDatabase();
    if (!db)
        return [];
    // Security check: ensure tableName is a valid table name from our list
    const tables = getTables();
    if (!tables.some(t => t.name === tableName)) {
        throw new Error(`Invalid table name: ${tableName}`);
    }
    return db.prepare(`SELECT * FROM ${tableName}`).all();
}
const crypto_1 = require("crypto");
function getOrCreateClientUUID() {
    const db = initDatabase();
    const row = db.prepare('SELECT uuid_client FROM uuid LIMIT 1').get();
    if (row) {
        return row.uuid_client;
    }
    else {
        const newUuid = (0, crypto_1.randomUUID)();
        db.prepare('INSERT INTO uuid (uuid_client) VALUES (?)').run(newUuid);
        console.log('Generated new Client UUID:', newUuid);
        return newUuid;
    }
}
function getStationInfo() {
    const db = initDatabase();
    const row = db.prepare('SELECT uuid_client, station_number FROM uuid LIMIT 1').get();
    // If only uuid exists but no station_number, row returned will have station_number: null
    return row ? {
        ...row,
        station_number: row.station_number || null
    } : {
        uuid_client: getOrCreateClientUUID(),
        station_number: null
    };
}
function recordPack(data) {
    const db = initDatabase();
    return db.transaction(() => {
        // 1. Find or create an open box for this nomenclature
        let box = db.prepare("SELECT id FROM boxes WHERE status = 'Open' AND nomenclature_id = ? ORDER BY id DESC LIMIT 1").get(data.nomenclature_id);
        if (!box) {
            // Need a default pallet if none exists
            let pallet = db.prepare("SELECT id FROM pallet WHERE status = 'Open' ORDER BY id DESC LIMIT 1").get();
            if (!pallet) {
                const palletInfo = { number: `P${Date.now()}`, status: 'Open' };
                const result = db.prepare('INSERT INTO pallet (number, status) VALUES (?, ?)').run(palletInfo.number, palletInfo.status);
                pallet = { id: result.lastInsertRowid };
            }
            const boxResult = db.prepare("INSERT INTO boxes (pallete_id, number, status, nomenclature_id) VALUES (?, ?, 'Open', ?)").run(pallet.id, data.box_number, data.nomenclature_id);
            box = { id: boxResult.lastInsertRowid };
        }
        // 2. Insert the pack
        db.prepare(`
      INSERT INTO pack (number, box_id, nomenclature_id, weight_netto, weight_brutto, barcode_value, station_number, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Printed')
    `).run(data.number, box.id, data.nomenclature_id, data.weight_netto, data.weight_brutto, data.barcode_value, data.station_number || null);
        return { success: true, boxId: box.id };
    })();
}
function closeBox(boxId, weightNetto, weightBrutto) {
    const db = initDatabase();
    db.prepare("UPDATE boxes SET status = 'Closed', weight_netto = ?, weight_brutto = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(weightNetto, weightBrutto, boxId);
    return { success: true };
}
function getLatestCounters() {
    const db = initDatabase();
    // We use the uuid table as a starting point, but we could also MAX() from packs/boxes
    // The user wants to derive it from records.
    const lastPack = db.prepare('SELECT number FROM pack ORDER BY id DESC LIMIT 1').get();
    const lastBox = db.prepare('SELECT number FROM boxes ORDER BY id DESC LIMIT 1').get();
    const totalUnits = db.prepare('SELECT COUNT(*) as total FROM pack').get();
    return {
        lastPackNumber: lastPack?.number || '0',
        lastBoxNumber: lastBox?.number || '0',
        totalUnits: totalUnits.total
    };
}
