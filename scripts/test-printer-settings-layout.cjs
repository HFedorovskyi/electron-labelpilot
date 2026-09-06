'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const settings = fs.readFileSync('src/renderer/components/Settings.tsx', 'utf8');
const printer = fs.readFileSync('src/renderer/components/PrinterSettings.tsx', 'utf8');
const translations = fs.readFileSync('src/shared/i18n_data.ts', 'utf8');

assert.match(settings, /expandedPrinterId/);
assert.match(settings, /className="flex flex-col gap-3"/);
assert.doesNotMatch(settings, /lg:grid-cols-2 xl:grid-cols-3 gap-6/);
assert.equal((settings.match(/expanded=\{expandedPrinterId ===/g) || []).length, 3);
assert.equal((settings.match(/onToggle=\{/g) || []).length, 3);

assert.match(printer, /aria-expanded=\{expanded\}/);
assert.match(printer, /aria-controls=\{`printer-settings-\$\{config\.id\}`\}/);
assert.match(printer, /min-h-\[76px\]/);
assert.match(printer, /touch-manipulation/);
assert.match(printer, /grid grid-cols-1 xl:grid-cols-2 gap-4/);
assert.match(printer, /data-printer-section="connection"/);
assert.match(printer, /data-printer-section="language"/);
assert.match(printer, /data-printer-section="parameters"/);
assert.doesNotMatch(printer, /id=\{`printer-settings-\$\{config\.id\}`\} className="grid/);
assert.match(printer, /settings\.showPrinterSettings/);
assert.match(printer, /settings\.hidePrinterSettings/);
assert.equal((translations.match(/'settings\.showPrinterSettings'/g) || []).length, 4);
assert.equal((translations.match(/'settings\.hidePrinterSettings'/g) || []).length, 4);
assert.equal((translations.match(/'settings\.printerSectionConnection'/g) || []).length, 4);
assert.equal((translations.match(/'settings\.printerSectionLanguage'/g) || []).length, 4);
assert.equal((translations.match(/'settings\.printerSectionParameters'/g) || []).length, 4);
assert.equal((translations.match(/'settings\.printerSectionGraphics'/g) || []).length, 4);

console.log('printer settings layout: accordion + fixed semantic sections + touch targets validated');
