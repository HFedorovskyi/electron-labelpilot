'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const registry = fs.readFileSync(path.join(root, 'src', 'shared', 'labelFonts.ts'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src', 'index.css'), 'utf8');
const tauri = fs.readFileSync(path.join(root, 'src', 'renderer', 'platform', 'tauriBitmapFallback.ts'), 'utf8');
const preview = fs.readFileSync(path.join(root, 'src', 'renderer', 'components', 'LabelRenderer.tsx'), 'utf8');

const families = [
    'Inter', 'Roboto', 'Arial', 'Times New Roman', 'Courier New',
    'Montserrat', 'Ubuntu', 'Georgia', 'Verdana',
];
for (const family of families) assert.ok(registry.includes("'" + family + "'"), 'missing family: ' + family);

const hashes = {
    'Inter-Regular.ttf': '41AB0F707A2BFAB8133CCDFCDAB52282F5F79E5751F43A264805451C7BB95FB8',
    'Inter-Bold.ttf': '790C108BEFE859DAC2DDBD20AF3FBB6917C601B3D544C8A05761519F3B5508FE',
    'Roboto-Variable.ttf': 'D7598E12C5DBEF095FF8272CFC55DA0250BD07FBDECBAC8A530B9B277872A134',
    'Montserrat-Variable.ttf': '0F7B311B2F3279E4EEF9B2F968BCDBAB6E28F4DAEB1F049F4F278A902BCD82F7',
    'Ubuntu-Regular.ttf': '3128DF86A31805618436D0AE5651BA4285D0C9DE0A39057D025F64EE33BCEB64',
    'Ubuntu-Bold.ttf': '679B5C1E09CAB3156BB8EF529735F9382BF31CA7AC737382AB959297F8D82AD4',
};
for (const [name, expected] of Object.entries(hashes)) {
    const file = path.join(root, 'public', 'fonts', 'label-fonts', name);
    assert.ok(fs.existsSync(file), 'missing bundled font: ' + name);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
    assert.equal(actual, expected, 'server font hash mismatch: ' + name);
    assert.ok(css.includes("/fonts/label-fonts/" + name), 'font-face missing: ' + name);
}
assert.match(tauri, /labelFontStack\(element\.fontFamily, 'Arial'\)/);
assert.match(tauri, /normalizeLabelFontFamily\(element\.fontFamily, 'Arial'\)/);
assert.match(preview, /fontFamily: labelFontStack\(el\.fontFamily\)/);

console.log('Label fonts: 9 server families, 6 bundled files, hashes and both renderers match');
