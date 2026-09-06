// DB hot-path smoke test under the real Electron runtime (better-sqlite3 is built for
// Electron's ABI). Exercises the prepared-statement cache, recordPack (twice → cache reuse
// + box reuse), product search, and counters against a throwaway temp database.
const { app } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), 'lp_db_test_' + process.pid);
fs.mkdirSync(tmp, { recursive: true });
app.setPath('userData', tmp);
app.disableHardwareAcceleration();

app.whenReady().then(() => {
    try {
        const dbmod = require(path.join(process.cwd(), 'dist-electron/main/database.js'));
        const db = dbmod.initDatabase();

        db.prepare("INSERT INTO nomenclature (id, name, article, exp_date) VALUES (1, 'Test Prod', 'ART1', 10)").run();

        const all = dbmod.getProducts('');
        const search = dbmod.getProducts('Test');
        // getProducts again to exercise the cached statement path
        dbmod.getProducts('');

        const mk = (n) => ({
            number: String(n), box_number: 'B1', nomenclature_id: 1,
            weight_netto: 1, weight_brutto: 1.1, barcode_value: 'X' + n,
            station_number: '01', production_date: new Date().toISOString(),
            expiration_date: new Date().toISOString(), batch: 'L1',
        });
        const r1 = dbmod.recordPack(mk(1));
        const r2 = dbmod.recordPack(mk(2)); // reuses cached statements + same open box
        const packCount = db.prepare('SELECT COUNT(*) c FROM pack').get().c;
        const counters = dbmod.getLatestCounters(1);

        const ok = all.length === 1 && search.length === 1 && r1.success && r2.success
            && packCount === 2 && r1.boxId === r2.boxId && !!counters;
        console.log('DB_TEST ' + JSON.stringify({
            allLen: all.length, searchLen: search.length,
            r1: r1.success, r2: r2.success, sameBox: r1.boxId === r2.boxId,
            packCount, counters: !!counters,
        }));
        console.log(ok ? 'DB_OK' : 'DB_FAIL');
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
        app.exit(ok ? 0 : 1);
    } catch (e) {
        console.error('DB_TEST_ERR', e);
        app.exit(1);
    }
});
