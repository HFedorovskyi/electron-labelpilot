// Split the i18n dump into N coherent chunk files (sorted by key so same-prefix
// keys stay together) for parallel translation. Also emit a vocab file for glossary.
const fs = require('fs');
const path = require('path');
const dump = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const outDir = process.argv[3];
const N = parseInt(process.argv[4] || '6', 10);
fs.mkdirSync(outDir, { recursive: true });

const keys = [...dump.keys].sort();
const entries = keys.map(k => ({
  key: k, ru: dump.translations.ru[k], en: dump.translations.en[k], de: dump.translations.de[k],
}));

const size = Math.ceil(entries.length / N);
let written = 0;
for (let i = 0; i < N; i++) {
  const slice = entries.slice(i * size, (i + 1) * size);
  if (!slice.length) continue;
  fs.writeFileSync(path.join(outDir, `chunk_${i}.json`), JSON.stringify({ idx: i, entries: slice }, null, 1));
  written += slice.length;
  console.log(`chunk_${i}.json: ${slice.length} keys (${slice[0].key} .. ${slice[slice.length-1].key})`);
}
// vocab: ru+en values for glossary building
fs.writeFileSync(path.join(outDir, 'vocab.json'), JSON.stringify(entries.map(e => ({ ru: e.ru, en: e.en })), null, 0));
console.log(`total written: ${written} / ${entries.length}; chunks dir: ${outDir}`);
