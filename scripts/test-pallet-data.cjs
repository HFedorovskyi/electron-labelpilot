// Pallet lifecycle test: mid-work items, hasOpenBox gating (content-aware),
// empty-open-box does NOT block, closeCurrentPallet closes orphan empty boxes.
const { app } = require('electron');
const os = require('os'); const path = require('path'); const fs = require('fs');
const tmp = path.join(os.tmpdir(), 'lp_pallet_test_' + process.pid);
fs.mkdirSync(tmp, { recursive: true });
app.setPath('userData', tmp);
app.disableHardwareAcceleration();

app.whenReady().then(() => {
    try {
        const db = require(path.join(process.cwd(), 'dist-electron/main/database.js'));
        const raw = db.initDatabase();
        raw.prepare("INSERT INTO nomenclature (id,name,article,exp_date) VALUES (1,'Колбаса Молочная','ART-1',10)").run();
        raw.prepare("INSERT INTO nomenclature (id,name,article,exp_date) VALUES (2,'Сосиски','ART-2',10)").run();

        let n = 0;
        const mk = (nom, batch, boxNum) => ({
            number: String(++n), box_number: boxNum, nomenclature_id: nom,
            weight_netto: 1.0, weight_brutto: 1.1, barcode_value: 'X' + n,
            station_number: '01', production_date: new Date().toISOString(),
            expiration_date: new Date().toISOString(), batch,
        });

        let pass = 0, fail = 0;
        const check = (label, cond, extra = '') => { if (cond) { pass++; console.log('  OK   ' + label + ' ' + extra); } else { fail++; console.log('  FAIL ' + label + ' ' + extra); } };
        const openBoxes = () => raw.prepare("SELECT id FROM boxes WHERE status='Open'").all();

        // ---- Scenario 1: mid-work with an OPEN box that has content -> blocks ----
        db.recordPack(mk(1, 'LOT-1', 'B1'));
        db.recordPack(mk(1, 'LOT-1', 'B1'));
        db.recordPack(mk(2, 'LOT-1', 'B2'));
        const d1 = db.getPalletRenderData({ operator_name: '01' });
        check('mid-work: items present', d1 && d1.items.length === 2, d1 ? `(items=${d1.items.length})` : '');
        check('mid-work: hasOpenBox = true (boxes have content)', d1 && d1.hasOpenBox === true, d1 ? `(hasOpenBox=${d1.hasOpenBox})` : '');

        // Close both content boxes
        openBoxes().forEach((b) => db.closeBox(b.id, 2.0, 2.2));
        const d2 = db.getPalletRenderData({ operator_name: '01' });
        check('after closing boxes: hasOpenBox = false', d2 && d2.hasOpenBox === false, d2 ? `(hasOpenBox=${d2.hasOpenBox})` : '');
        check('after closing boxes: items still present', d2 && d2.items.length === 2, d2 ? `(items=${d2.items.length})` : '');

        // ---- Scenario 2: the real bug — an EMPTY open box must NOT block ----
        // Open a fresh box B3, then delete its only pack -> box stays Open with 0 active packs.
        const r3 = db.recordPack(mk(1, 'LOT-1', 'B3'));
        const packInB3 = raw.prepare("SELECT id FROM pack WHERE box_id = ?").get(r3.boxId);
        db.deletePack(packInB3.id);
        const emptyBox = raw.prepare("SELECT status FROM boxes WHERE id = ?").get(r3.boxId);
        check('empty box B3 is still Open in DB', emptyBox && emptyBox.status === 'Open', `(status=${emptyBox && emptyBox.status})`);
        const d3 = db.getPalletRenderData({ operator_name: '01' });
        check('EMPTY open box does NOT block: hasOpenBox = false', d3 && d3.hasOpenBox === false, d3 ? `(hasOpenBox=${d3.hasOpenBox})` : '');
        check('pallet still has content from closed boxes', d3 && d3.items.length === 2, d3 ? `(items=${d3.items.length})` : '');

        // ---- Scenario 3: print closes pallet AND cleans up the orphan empty box ----
        const closed = db.closeCurrentPallet();
        check('closeCurrentPallet success', closed && closed.success === true);
        const orphan = raw.prepare("SELECT status FROM boxes WHERE id = ?").get(r3.boxId);
        check('orphan empty box closed by closeCurrentPallet', orphan && orphan.status === 'Closed', `(status=${orphan && orphan.status})`);
        const d4 = db.getPalletRenderData({ operator_name: '01' });
        check('after closePallet: no open pallet (null)', d4 === null, `(got ${d4 === null ? 'null' : 'object'})`);

        // ---- Scenario 4: next pack starts a FRESH pallet (no orphan reuse) ----
        db.recordPack(mk(1, 'LOT-2', 'B4'));
        const d5 = db.getPalletRenderData({ operator_name: '01' });
        check('new pallet after close: items=1, hasOpenBox=true', d5 && d5.items.length === 1 && d5.hasOpenBox === true, d5 ? `(items=${d5.items.length}, open=${d5.hasOpenBox})` : '');
        // The new pack must NOT be on the orphan box.
        const newBoxId = raw.prepare("SELECT box_id FROM pack WHERE status != 'Deleted' ORDER BY id DESC LIMIT 1").get();
        check('new pack is on a brand-new box (not the orphan)', newBoxId && newBoxId.box_id !== r3.boxId, `(boxId=${newBoxId && newBoxId.box_id}, orphan=${r3.boxId})`);

        console.log(`\nResult: ${pass} passed, ${fail} failed`);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
        app.exit(fail === 0 ? 0 : 1);
    } catch (e) {
        console.error('ERR', e);
        app.exit(1);
    }
});
