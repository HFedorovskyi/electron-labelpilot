'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ui = fs.readFileSync(process.argv[2] || 'src-tauri/slint/ui/weighing.slint', 'utf8');
const catalog = JSON.parse(fs.readFileSync('src-tauri/locales/slint.json', 'utf8').replace(/^\uFEFF/, ''));
const normalized = new Set(Object.keys(catalog).map(s => s.trim().toLowerCase()));
let count = 0;
for (const [index, line] of ui.split('\n').entries()) {
    if (line.includes('ui-language ==') || line.trim().startsWith('//')) continue;
    // Keyboard alphabets are input, and catalog-mode is an internal legacy enum.
    if (/\[.*"[А-Яа-я]|catalog-mode/.test(line)) continue;
    for (const literal of line.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
        const text = JSON.parse(literal[0]);
        if (!/[А-Яа-яЁё]/.test(text) || (text.trim().length < 2 && text !== ' г') || text === 'АБВ') continue;
        assert(normalized.has(text.trim().toLowerCase()), `Untranslated caption at ${index + 1}: ${text}`);
        assert(line.slice(0, literal.index).endsWith('UiText.translate(UiText.language, '), `Unbound caption at ${index + 1}: ${text}`);
        count++;
    }
}
for (const field of ['scale-status', 'printer-status', 'fixed-status', 'license-status', 'settings-status', 'update-status', 'operator-login-error']) {
    assert(ui.includes(`UiText.translate(UiText.language, root.${field})`), `Missing dynamic field ${field}`);
}
for (const field of ['job.state-label', 'job.updated', 'job.error', 'device.status-label']) {
    assert(ui.includes(`UiText.translate(UiText.language, ${field})`), `Missing row field ${field}`);
}
for (const field of ['root.product-name', 'job.printer-name', 'root.license-customer', 'root.license-id']) {
    assert(!ui.includes(`UiText.translate(UiText.language, ${field})`), `Data must not be translated: ${field}`);
}
assert(ui.includes('root.catalog-mode == "Фиксированный"'));
assert(!/root\.catalog-mode == UiText/.test(ui));
for (const [source, values] of Object.entries(catalog)) {
    assert.equal(values.length, 3, source);
    const slots = s => [...s.matchAll(/\{\d+\}/g)].map(m => m[0]).sort();
    for (const [i, value] of values.entries()) {
        assert(value.trim(), source);
        assert.deepEqual(slots(value), slots(source), source);
        if (i !== 2) assert(!/[\u0400-\u04ff]/.test(value), `${source}: Cyrillic in EN/DE`);
    }
}
console.log(`Native locales: ${count} bound captions, ${Object.keys(catalog).length} complete EN/DE/UK entries; dynamic rows and data boundaries verified`);
