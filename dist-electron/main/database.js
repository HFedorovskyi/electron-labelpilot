"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initDatabase = initDatabase;
exports.getProducts = getProducts;
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
        close_box_counter INTEGER
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
        weight_brutto REAL
      );

      CREATE TABLE IF NOT EXISTS pack (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        number TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        box_id INTEGER NOT NULL REFERENCES boxes(id),
        nomenclature_id INTEGER NOT NULL REFERENCES nomenclature(id),
        weight_netto REAL NOT NULL,
        weight_brutto REAL NOT NULL,
        status TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS uuid (
        uuid_client TEXT PRIMARY KEY NOT NULL,
        station_number TEXT
      );

      CREATE TABLE IF NOT EXISTS stations_number (
        station_number TEXT PRIMARY KEY NOT NULL
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
    return db;
}
function getProducts(search = '') {
    if (!db)
        return [];
    if (search) {
        const query = `
      SELECT * FROM nomenclature 
      WHERE name LIKE @search OR article LIKE @search
      ORDER BY name ASC
      LIMIT 50
    `;
        return db.prepare(query).all({ search: `%${search}%` });
    }
    else {
        return db.prepare('SELECT * FROM nomenclature ORDER BY name ASC LIMIT 50').all();
    }
}
exports.default = db;
