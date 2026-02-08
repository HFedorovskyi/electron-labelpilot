import Database from 'better-sqlite3';
import path from 'path';
import { app } from 'electron';

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

import { randomUUID } from 'crypto';

export function getOrCreateClientUUID(): string {
  const db = initDatabase();

  const row = db.prepare('SELECT uuid_client FROM uuid LIMIT 1').get() as { uuid_client: string } | undefined;

  if (row) {
    return row.uuid_client;
  } else {
    const newUuid = randomUUID();
    db.prepare('INSERT INTO uuid (uuid_client) VALUES (?)').run(newUuid);
    console.log('Generated new Client UUID:', newUuid);
    return newUuid;
  }
}

