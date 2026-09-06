'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'src', 'renderer', 'App.tsx'), 'utf8');
const stations = ['WeighingStation.tsx', 'FixedWeightStation.tsx', 'PrintJobStation.tsx'].map(name => fs.readFileSync(path.join(root, 'src', 'renderer', 'components', name), 'utf8')).join('\\n');
const assets = path.join(root, 'dist', 'assets');
const jsFiles = fs.readdirSync(assets).filter(name => name.endsWith('.js'));
const one = prefix => {
    const matches = jsFiles.filter(name => name.startsWith(prefix));
    assert.equal(matches.length, 1, 'Expected one built chunk for ' + prefix + ', got ' + matches.join(','));
    return { name: matches[0], bytes: fs.statSync(path.join(assets, matches[0])).size };
};

for (const component of ['WeighingStation', 'FixedWeightStation', 'PrintJobStation']) {
    assert.doesNotMatch(app, new RegExp("import " + component + " from"), component + ' must not be an eager import');
    assert.match(app, new RegExp("const " + component + " = lazy\\(\\(\\) => import"), component + ' must be lazy');
}
assert.match(app, /new Set\(\['weighing'\]\)/, 'Only the default station may mount initially');
assert.match(app, /mountedStationTabs\.has\('fixedWeight'\)/);
assert.match(app, /mountedStationTabs\.has\('printJob'\)/);
assert.match(app, /const next = new Set\(previous\)/, 'Visited station state must be retained');
assert.doesNotMatch(app, /import\('bwip-js'\)/, 'The shell must not directly load bwip-js');
assert.doesNotMatch(stations, /import DatePickerModal from/, 'Date picker must stay lazy');
assert.doesNotMatch(stations, /import ProductSelectionModal from/, 'Product selector must stay lazy');
assert.match(stations, /LazyDeleteItemsModal/, 'Delete modal must use the conditional lazy wrapper');
assert.match(stations, /LazyNumericKeypad/, 'Numeric keypad must use the lazy wrapper');

const appChunk = one('main-');
const weighing = one('WeighingStation-');
const fixed = one('FixedWeightStation-');
const jobs = one('PrintJobStation-');
assert.ok(appChunk.bytes < 160 * 1024, 'Initial App chunk exceeds 160 KiB: ' + appChunk.bytes);
for (const chunk of [weighing, fixed, jobs]) {
    assert.ok(chunk.bytes < 50 * 1024, chunk.name + ' exceeds 50 KiB: ' + chunk.bytes);
}
const bwip = one('bwip-js-');
assert.ok(bwip.bytes > 500 * 1024, 'bwip-js check did not find the isolated heavy chunk');

console.log(JSON.stringify({
    appChunk,
    lazyStationChunks: [weighing, fixed, jobs],
    isolatedBarcodeChunk: bwip,
    initialMountedStations: ['weighing'],
}, null, 2));
