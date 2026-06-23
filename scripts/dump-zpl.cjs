// Dump a REAL generated label's ZPL to verify the production path emits valid ZPL.
const os = require('os'); const path = require('path'); const Module = require('module');
const origLoad = Module._load;
Module._load = function (request) {
    if (request === 'electron') return { app: { isPackaged: false, getPath: () => os.tmpdir(), getAppPath: () => process.cwd() }, BrowserWindow: function () { } };
    return origLoad.apply(this, arguments);
};
const { CanvasBitmapGenerator } = require(path.join(process.cwd(), 'dist-electron/main/printer/generator/CanvasBitmapGenerator.js'));

(async () => {
    const gen = new CanvasBitmapGenerator();
    const doc = {
        widthMm: 58, heightMm: 40,
        canvas: { width: 464, height: 320 },
        elements: [
            { id: 't1', type: 'text', text: 'Молоко 3.2%', x: 20, y: 20, w: 420, h: 40, fontSize: 30, fontWeight: 'bold' },
            { id: 't2', type: 'text', text: 'Вес: {{weight}} кг', x: 20, y: 80, w: 420, h: 34, fontSize: 26 },
            { id: 'b1', type: 'barcode', value: '{{barcode}}', x: 20, y: 130, w: 300, h: 110, barcodeType: 'code128', showText: true },
        ],
    };
    const data = { weight: '0.532', barcode: '2000000005324' };
    const buf = await gen.generate(doc, data, { dpi: 203, widthMm: 58, heightMm: 40, printerId: 'dump', cacheMode: 'inline' });
    const zpl = buf.toString('utf8');
    console.log('--- VALIDITY ---');
    console.log('length:', zpl.length);
    console.log('startsWith ^XA:', zpl.startsWith('^XA'));
    console.log('endsWith ^XZ:', zpl.trimEnd().endsWith('^XZ'));
    console.log('has malformed "^ X":', /\^ [A-Z]/.test(zpl));
    console.log('XA count:', (zpl.match(/\^XA/g) || []).length, 'XZ count:', (zpl.match(/\^XZ/g) || []).length);
    console.log('--- HEAD (120) ---'); console.log(zpl.slice(0, 120));
    console.log('--- TAIL (160) ---'); console.log(zpl.slice(-160));
})();
