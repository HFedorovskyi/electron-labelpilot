// Apply per-locale i18n patches by KEY (preserving comments, order, and every other
// value verbatim). Patch shape: { ru:{key:val,...}, en:{...}, de:{...}, uk:{...} }.
// Each value is replaced only within its own locale block, matched by key.
const fs = require('fs');
const [srcPath, patchPath] = process.argv.slice(2);
let src = fs.readFileSync(srcPath, 'utf8');
const patch = JSON.parse(fs.readFileSync(patchPath, 'utf8'));

// Balance-find the outer object end.
const eq = src.indexOf('=', src.indexOf('translations'));
let i = src.indexOf('{', eq), depth = 0, inStr = false, ch = '', esc = false, objEnd = -1;
for (; i < src.length; i++) {
  const c = src[i];
  if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === ch) inStr = false; continue; }
  if (c === "'" || c === '"' || c === '`') { inStr = true; ch = c; }
  else if (c === '{') depth++;
  else if (c === '}') { if (--depth === 0) { objEnd = i; break; } }
}

const locales = ['ru', 'en', 'de', 'uk'];
const headers = locales.map(l => ({ l, idx: src.indexOf(`\n    ${l}:`) })).filter(h => h.idx >= 0).sort((a, b) => a.idx - b.idx);
const bounds = {};
for (let j = 0; j < headers.length; j++) {
  bounds[headers[j].l] = [headers[j].idx, j + 1 < headers.length ? headers[j + 1].idx : objEnd];
}

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escVal = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n');

let applied = 0, notFound = [];
// Apply per locale, from last block to first so earlier indices stay valid.
for (const loc of [...locales].reverse()) {
  if (!patch[loc] || !bounds[loc]) continue;
  let [a, b] = bounds[loc];
  let block = src.slice(a, b);
  for (const [key, val] of Object.entries(patch[loc])) {
    const re = new RegExp(`('${escRe(key)}'\\s*:\\s*')((?:[^'\\\\]|\\\\.)*)(')`);
    if (re.test(block)) { block = block.replace(re, (m, p1, p2, p3) => p1 + escVal(val) + p3); applied++; }
    else notFound.push(`${loc}.${key}`);
  }
  src = src.slice(0, a) + block + src.slice(b);
}

fs.writeFileSync(srcPath, src);
console.log(`applied ${applied} patches`);
if (notFound.length) console.log(`NOT FOUND (${notFound.length}): ${notFound.join(', ')}`);
