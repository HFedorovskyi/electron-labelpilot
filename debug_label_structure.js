const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(process.env.APPDATA, 'electron-labelpilot', 'client_data.db');
console.log('Opening DB:', dbPath);

if (!fs.existsSync(dbPath)) {
    console.error('DB not found!');
    process.exit(1);
}

const db = new Database(dbPath);

try {
    const row = db.prepare('SELECT name, structure FROM labels LIMIT 1').get();
    if (row) {
        console.log('Label Name:', row.name);
        // console.log('Structure:', row.structure);
        const dumpPath = path.join(__dirname, 'debug_label_dump.json');
        fs.writeFileSync(dumpPath, row.structure);
        console.log('Structure written to:', dumpPath);
    } else {
        console.log('No labels found in DB.');
    }
} catch (e) {
    console.error('Error querying DB:', e);
} finally {
    db.close();
}
