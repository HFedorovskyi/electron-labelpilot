'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'platform', 'tauriBitmapFallback.ts'),
    'utf8',
);
const stylesheet = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.css'), 'utf8');

assert.match(source, /export function normalizeTauriImageSource/);
assert.match(source, /compact\.startsWith\('\/9j\/'\) \? 'image\/jpeg'/);
assert.match(source, /compact\.startsWith\('R0lGOD'\) \? 'image\/gif'/);
assert.match(source, /: 'image\/png';/);
assert.match(source, /image\.src = normalizeTauriImageSource\(source\)/);

const valuePosition = source.indexOf('const value = interpolate(element.value ?? element.text, data);');
const previewPosition = source.indexOf('if (element.imageData)', valuePosition);
assert.ok(valuePosition >= 0, 'barcode value interpolation is missing');
assert.ok(previewPosition > valuePosition, 'stored preview must only be a fallback after resolving barcode data');

const drawBarcodeStart = source.indexOf('async function drawBarcode(');
const barcodeEnd = source.indexOf('function tableRows', drawBarcodeStart);
assert.ok(drawBarcodeStart >= 0 && barcodeEnd > drawBarcodeStart);
const barcodeSource = source.slice(drawBarcodeStart, barcodeEnd);
assert.match(barcodeSource, /context\.drawImage\(barcodeCanvas, x, y, width, height\)/);
assert.match(barcodeSource, /context\.drawImage\(image, x, y, width, height\)/);
assert.doesNotMatch(barcodeSource, /drawFitted/);


assert.match(stylesheet, /@font-face\s*{[\s\S]*font-family:\s*'Inter'/);
assert.match(stylesheet, /url\('\/fonts\/label-fonts\/Inter-Regular\.ttf'\)/);
assert.match(stylesheet, /url\('\/fonts\/label-fonts\/Inter-Bold\.ttf'\)/);
assert.match(source, /await ensureLabelFonts\(elements\)/);
assert.match(source, /labelFontStack\(element\.fontFamily, 'Arial'\)/);
assert.match(source, /paragraph\.split\(' '\)/);
assert.doesNotMatch(source, /splitLongWord/);
assert.doesNotMatch(source, /context\.fillText\(line, textX, lineY, width\)/);

console.log('Tauri bitmap source: images normalized; bundled fonts and legacy text layout preserved');
