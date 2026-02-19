const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

const dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'electron-labelpilot', 'client_data.db');
const db = new Database(dbPath);

try {
    const products = db.prepare('SELECT id, name, extra_data FROM nomenclature').all();
    console.log('Products found:', products.length);
    for (const p of products) {
        console.log(`ID: ${p.id}, Name: ${p.name}`);
        console.log(`Extra Data: ${p.extra_data}`);
    }
} catch (e) {
    console.error(e);
} finally {
    db.close();
}
