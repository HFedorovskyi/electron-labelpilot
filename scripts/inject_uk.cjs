// Surgically insert a `uk: { ... }` block into the translations object (preserving
// ru/en/de and their comments verbatim), in the SAME key order as ru, and extend
// `type Lang`. Args: srcPath ukJson dumpJson [outPath].
const fs = require('fs');
const [srcPath, ukPath, dumpPath, outPath = srcPath] = process.argv.slice(2);
let src = fs.readFileSync(srcPath, 'utf8');
const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
const uk = JSON.parse(fs.readFileSync(ukPath, 'utf8'));

// Balance-find the outer translations object braces.
const eq = src.indexOf('=', src.indexOf('translations'));
let i = src.indexOf('{', eq), depth = 0, inStr = false, ch = '', esc = false, objEnd = -1;
for (; i < src.length; i++) {
  const c = src[i];
  if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === ch) inStr = false; continue; }
  if (c === "'" || c === '"' || c === '`') { inStr = true; ch = c; }
  else if (c === '{') depth++;
  else if (c === '}') { if (--depth === 0) { objEnd = i; break; } }
}
if (objEnd < 0) throw new Error('translations object end not found');

const order = Object.keys(dump.translations.ru); // mirror ru source order
const missing = order.filter(k => !(k in uk));
const extra = Object.keys(uk).filter(k => !order.includes(k));
if (missing.length) console.error(`WARN: ${missing.length} uk keys missing -> ${missing.slice(0, 12)}`);
if (extra.length) console.error(`WARN: ${extra.length} uk keys not in ru -> ${extra.slice(0, 12)}`);

const esq = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n');
const lines = order.map(k => `        '${esq(k)}': '${esq(uk[k] ?? dump.translations.ru[k])}',`);
const block = `    uk: {\r\n` + lines.join('\r\n') + `\r\n    },\r\n`;

let out = src.slice(0, objEnd) + block + src.slice(objEnd);
out = out.replace(/export type Lang\s*=\s*'ru'\s*\|\s*'en'\s*\|\s*'de'\s*;/, "export type Lang = 'ru' | 'en' | 'de' | 'uk';");
if (!/\|\s*'uk'/.test(out)) console.error('WARN: Lang type not updated');

fs.writeFileSync(outPath, out);
console.log(`wrote ${outPath}; uk keys: ${order.length}, missing: ${missing.length}, extra: ${extra.length}`);
