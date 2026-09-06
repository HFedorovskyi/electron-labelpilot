// Smoke test: run under the REAL Electron runtime and confirm every native module
// loads against Electron's ABI. Usage: npx electron scripts/test-native-load.cjs
const { app } = require('electron');
app.disableHardwareAcceleration();

async function run() {
    const results = {};

    try {
        const Database = require('better-sqlite3');
        const db = new Database(':memory:');
        db.exec('CREATE TABLE t(x)');
        db.prepare('INSERT INTO t VALUES (?)').run(42);
        const row = db.prepare('SELECT x FROM t').get();
        db.close();
        results.betterSqlite3 = row && row.x === 42 ? 'OK' : 'BAD';
    } catch (e) { results.betterSqlite3 = 'FAIL: ' + e.message; }

    try {
        const { createCanvas } = require('@napi-rs/canvas');
        const c = createCanvas(20, 20);
        const ctx = c.getContext('2d');
        ctx.fillRect(0, 0, 10, 10);
        results.canvas = c.toBuffer('image/png').length > 0 ? 'OK' : 'BAD';
    } catch (e) { results.canvas = 'FAIL: ' + e.message; }

    try {
        const { SerialPort } = require('serialport');
        await SerialPort.list();
        results.serialport = 'OK';
    } catch (e) { results.serialport = 'FAIL: ' + e.message; }

    try {
        const bwip = require('bwip-js/node');
        const png = await bwip.toBuffer({ bcid: 'code128', text: 'TEST', scale: 2, height: 10 });
        results.bwip = png && png.length > 0 ? 'OK' : 'BAD';
    } catch (e) { results.bwip = 'FAIL: ' + e.message; }

    console.log('NATIVE_LOAD_RESULTS ' + JSON.stringify(results));
    const ok = Object.values(results).every(v => v === 'OK');
    console.log(ok ? 'ALL_OK' : 'SOME_FAILED');
    app.exit(ok ? 0 : 1);
}

app.whenReady().then(run);
