// Render the sample pallet scheme + data through the real generator and validate the ZPL.
const os = require('os'); const path = require('path'); const fs = require('fs'); const Module = require('module');
const origLoad = Module._load;
Module._load = function (request) {
    if (request === 'electron') return { app: { isPackaged: false, getPath: () => os.tmpdir(), getAppPath: () => process.cwd() }, BrowserWindow: function () { } };
    return origLoad.apply(this, arguments);
};
const { CanvasBitmapGenerator } = require(path.join(process.cwd(), 'dist-electron/main/printer/generator/CanvasBitmapGenerator.js'));

const REF = path.join(process.cwd(), 'docs/server-handoff/reference');
const scheme = JSON.parse(fs.readFileSync(path.join(REF, 'sample-pallet-scheme.json'), 'utf8'));
const data = JSON.parse(fs.readFileSync(path.join(REF, 'sample-pallet-data.json'), 'utf8'));

(async () => {
    const gen = new CanvasBitmapGenerator();
    let pass = 0, fail = 0;
    const check = (n, c, extra = '') => { if (c) { pass++; console.log('  OK   ' + n + ' ' + extra); } else { fail++; console.log('  FAIL ' + n + ' ' + extra); } };

    const buf = await gen.generate(scheme, data, { dpi: 203, widthMm: 148, heightMm: 210, printerId: 'pallet-test', cacheMode: 'inline' });
    const zpl = buf.toString('utf8');

    check('starts ^XA', zpl.startsWith('^XA'));
    check('ends ^XZ', zpl.trimEnd().endsWith('^XZ'));
    check('single label', (zpl.match(/\^XA/g) || []).length === 1 && (zpl.match(/\^XZ/g) || []).length === 1);
    check('no malformed "^ X"', !/\^ [A-Z]/.test(zpl));
    const gfaCount = (zpl.match(/\^GFA,/g) || []).length;
    check('has ^GFA overlays (table + text clips)', gfaCount >= 1, `(${gfaCount} GFA)`);
    check('buffer non-trivial (table rendered)', buf.length > 2000, `(${buf.length}B)`);

    // Empty-pallet path: table with no items still renders header/borders (no crash).
    const emptyBuf = await gen.generate(scheme, { ...data, items: [] }, { dpi: 203, widthMm: 148, heightMm: 210, printerId: 'pallet-test', cacheMode: 'inline' });
    check('empty items renders without crash', emptyBuf.length > 0 && emptyBuf.toString('utf8').includes('^XZ'));

    console.log(`\nResult: ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})();
