// One-off i18n auditor: evals the translations object literal and reports
// structural issues across locales, then dumps {keys, translations} to JSON.
const fs = require('fs');
const srcPath = process.argv[2];
const dumpPath = process.argv[3];
let src = fs.readFileSync(srcPath, 'utf8');

// Brace-balance out the translations object literal (string-aware).
const eq = src.indexOf('=', src.indexOf('translations'));
let i = src.indexOf('{', eq), start = i, depth = 0, inStr = false, strCh = '', esc = false;
for (; i < src.length; i++) {
  const c = src[i];
  if (inStr) {
    if (esc) esc = false; else if (c === '\\') esc = true; else if (c === strCh) inStr = false;
    continue;
  }
  if (c === "'" || c === '"' || c === '`') { inStr = true; strCh = c; }
  else if (c === '{') depth++;
  else if (c === '}') { if (--depth === 0) { i++; break; } }
}
const translations = eval('(' + src.slice(start, i) + ')');

const locales = Object.keys(translations);
console.log('locales:', locales.join(', '));
for (const l of locales) console.log(`  ${l}: ${Object.keys(translations[l]).length} keys`);

const allKeys = new Set();
for (const l of locales) for (const k of Object.keys(translations[l])) allKeys.add(k);
console.log('union keys:', allKeys.size);

for (const l of locales) {
  const miss = [...allKeys].filter(k => !(k in translations[l]));
  if (miss.length) console.log(`  !! ${l} MISSING ${miss.length}: ${miss.slice(0, 15).join(', ')}`);
}

const ph = s => (String(s).match(/\{\{?(\w+)\}?\}/g) || []).sort().join(',');
let mm = 0;
for (const k of allKeys) {
  const present = locales.filter(l => k in translations[l]);
  if (new Set(present.map(l => ph(translations[l][k]))).size > 1) {
    mm++;
    if (mm <= 25) console.log(`  ~ placeholder mismatch [${k}]: ` + present.map(l => `${l}=[${ph(translations[l][k])}]`).join(' '));
  }
}
console.log('placeholder mismatches:', mm);

if (translations.ru && translations.en) {
  const same = [...allKeys].filter(k => translations.ru[k] && translations.ru[k] === translations.en[k] && /[A-Za-zА-Яа-я]{3,}/.test(translations.ru[k]));
  console.log(`ru==en identical (${same.length}):`, same.slice(0, 20).join(', '));
}
if (translations.de) {
  const cyr = [...allKeys].filter(k => translations.de[k] && /[А-Яа-яЁё]/.test(translations.de[k]));
  console.log(`de still Cyrillic (${cyr.length}):`, cyr.slice(0, 20).join(', '));
  const sameEnDe = [...allKeys].filter(k => translations.en[k] && translations.de[k] && translations.en[k] === translations.de[k] && /[A-Za-z]{4,}/.test(translations.en[k]));
  console.log(`en==de identical (${sameEnDe.length}):`, sameEnDe.slice(0, 20).join(', '));
}

if (dumpPath) {
  fs.writeFileSync(dumpPath, JSON.stringify({ keys: [...allKeys], translations }));
  console.log('dumped ->', dumpPath);
}
