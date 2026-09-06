// Round-trip test: does loadPrinterConfig/savePrinterConfig persist palletPrinter to disk?
const os = require('os'); const path = require('path'); const fs = require('fs'); const Module = require('module');
const tmp = path.join(os.tmpdir(), 'lp_cfg_test_' + process.pid);
fs.mkdirSync(tmp, { recursive: true });
const origLoad = Module._load;
Module._load = function (request) {
    if (request === 'electron') return { app: { isPackaged: false, getPath: () => tmp, getAppPath: () => process.cwd() }, BrowserWindow: function () { } };
    return origLoad.apply(this, arguments);
};
const cfg = require(path.join(process.cwd(), 'dist-electron/main/config.js'));

let pass = 0, fail = 0;
const check = (n, c, extra = '') => { if (c) { pass++; console.log('  OK   ' + n + ' ' + extra); } else { fail++; console.log('  FAIL ' + n + ' ' + extra); } };

// Simulate a LEGACY on-disk config without palletPrinter
const file = path.join(tmp, 'printer-config.json');
fs.writeFileSync(file, JSON.stringify({
    packPrinter: { id: 'pack_default', name: 'Pack', connection: 'tcp', protocol: 'image', ip: '127.0.0.1', port: 9100, active: true },
    boxPrinter: { id: 'box_default', name: 'Box', connection: 'tcp', protocol: 'image', ip: '127.0.0.1', port: 9100, active: true },
    autoPrintOnStable: true, serverIp: '', language: 'ru'
}, null, 2));

// 1. Load back-fills palletPrinter even though disk lacked it
const c1 = cfg.loadPrinterConfig();
check('load back-fills palletPrinter', !!c1.palletPrinter && c1.palletPrinter.id === 'pallet_default', JSON.stringify(c1.palletPrinter));

// 2. User configures pallet printer + save
c1.palletPrinter.connection = 'windows_driver';
c1.palletPrinter.driverName = 'Microsoft Print to PDF';
c1.palletPrinter.protocol = 'browser';
c1.palletPrinter.active = true;
cfg.savePrinterConfig(c1);

// 3. On-disk file must now contain palletPrinter with our values
const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
check('disk has palletPrinter.driverName', onDisk.palletPrinter?.driverName === 'Microsoft Print to PDF', JSON.stringify(onDisk.palletPrinter));
check('disk has palletPrinter.protocol browser', onDisk.palletPrinter?.protocol === 'browser');
check('disk has palletPrinter.active', onDisk.palletPrinter?.active === true);

// 4. loadPrinterConfig returns it (cache)
const c2 = cfg.loadPrinterConfig();
check('reload returns saved driverName', c2.palletPrinter?.driverName === 'Microsoft Print to PDF');

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
