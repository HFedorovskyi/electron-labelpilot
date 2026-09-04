const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src-tauri/slint/ui/weighing.slint'), 'utf8');

assert.match(
  source,
  /property <int> operator-pin-length: root\.operator-pin\.character-count;/,
  'PIN length must follow the actual entered value',
);
assert.match(
  source,
  /for _\[index\] in root\.operator-pin-length: Text \{[\s\S]*?text: "•";/,
  'PIN field must render one mask symbol for every entered character',
);
assert.doesNotMatch(
  source,
  /operator-pin == "" \? "—" : "•{2,}"/,
  'PIN field must not use a fixed mask',
);
assert.match(source, /text: "ОЧИСТИТЬ"; clicked => \{ root\.operator-pin = "";/);

assert.match(source, /if root\.operator-pin != "": HorizontalLayout \{\s*width: parent\.width;\s*height: parent\.height;/);
assert.match(source, /root\.operator-login-busy \? "Проверка PIN…"/);
assert.match(source, /"Введено цифр: " \+ root\.operator-pin-length/);
assert.match(source, /KeyButton \{ horizontal-stretch: 1; enabled: !root\.operator-login-busy;/);

console.log('Slint PIN feedback: visible dynamic mask, count, busy state and clear behavior verified');