// Verifies the demo seed also creates demo print jobs (for the "По заданию" tab).
const { app } = require('electron');
const os = require('os'); const path = require('path'); const fs = require('fs');
const tmp = path.join(os.tmpdir(), 'lp_demojobs_' + process.pid);
fs.mkdirSync(tmp, { recursive: true });
app.setPath('userData', tmp);
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
    let pass = 0, fail = 0;
    const check = (label, cond, extra = '') => { if (cond) { pass++; console.log('  OK   ' + label + ' ' + extra); } else { fail++; console.log('  FAIL ' + label + ' ' + extra); } };
    try {
        const { seedDemoData } = require(path.join(process.cwd(), 'dist-electron/main/demo_seed.js'));
        const db = require(path.join(process.cwd(), 'dist-electron/main/database.js'));

        const res = await seedDemoData();
        check('seedDemoData success', res && res.success === true, JSON.stringify(res));

        const jobs = db.getPrintJobs();
        check('3 demo print jobs seeded', jobs.length === 3, `got ${jobs.length}`);
        check('job 9001 = Творог, 50 pcs', jobs.some(j => j.job_id === 9001 && j.quantity_unit === 'pcs' && j.quantity === 50));
        check('job 9002 = Сыр, 30 kg', jobs.some(j => j.job_id === 9002 && j.quantity_unit === 'kg' && j.quantity === 30));
        check('job 9003 = Масло, 40 pcs', jobs.some(j => j.job_id === 9003 && j.quantity_unit === 'pcs' && j.quantity === 40));
        check('all start pending with printed_qty 0', jobs.every(j => j.status === 'pending' && j.printed_qty === 0));
        // Jobs must point at real demo nomenclature (so the station can resolve templates).
        const nomIds = new Set(db.initDatabase().prepare('SELECT id FROM nomenclature').all().map(n => n.id));
        check('all jobs reference existing demo nomenclature', jobs.every(j => nomIds.has(j.nomenclature_id)), `noms=${[...nomIds].join(',')}`);

        // Re-seeding stays deterministic (no duplicates).
        await seedDemoData();
        check('re-seed keeps exactly 3 jobs', db.getPrintJobs().length === 3, `got ${db.getPrintJobs().length}`);

        console.log(`\nResult: ${pass} passed, ${fail} failed`);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
        app.exit(fail === 0 ? 0 : 1);
    } catch (e) {
        console.error('ERR', e);
        app.exit(1);
    }
});
