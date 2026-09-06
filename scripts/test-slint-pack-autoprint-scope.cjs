const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'src-tauri/slint/ui/weighing.slint'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'src-tauri/src/slint_runtime.rs'), 'utf8');
const nativePrint = fs.readFileSync(path.join(root, 'src-tauri/src/native_print.rs'), 'utf8');

const pageStart = ui.indexOf('if root.active-page == 3: Rectangle {');
const pageEnd = ui.indexOf('if root.active-page == 4: Rectangle {', pageStart);
assert.ok(pageStart >= 0 && pageEnd > pageStart, 'printer settings page missing');
const page = ui.slice(pageStart, pageEnd);

assert.equal((page.match(/text: root\.settings-auto-print-label/g) || []).length, 1);
assert.match(page, /if root\.settings-selected-role == "packPrinter": Rectangle \{[\s\S]*?text: root\.settings-auto-print-label/);
assert.doesNotMatch(page, /if root\.settings-selected-role == "(boxPrinter|palletPrinter)"[\s\S]{0,500}settings-auto-print-label/);

for (const expected of [
  'PACKAGE AUTO PRINT',
  'VERPACKUNGS-AUTODRUCK',
  'АВТОДРУК УПАКОВОК',
  'АВТОПЕЧАТЬ УПАКОВОК',
  'Print a package label when weight is stable and within tolerance',
  'Печатать этикетку упаковки после стабилизации веса в пределах допуска',
]) assert.ok(ui.includes(expected), 'missing scoped auto-print copy: ' + expected);

const targetStart = runtime.indexOf('enum AutoPrintTarget {');
const targetEnd = runtime.indexOf('\n}', targetStart);
const targets = runtime.slice(targetStart, targetEnd);
assert.match(targets, /ProductionPack\(i64\)/);
assert.match(targets, /FixedWeightPack\(i64\)/);
assert.doesNotMatch(targets, /Box|Pallet/);

const packStart = nativePrint.indexOf('pub fn record_and_print_pack(');
const closeStart = nativePrint.indexOf('pub fn close_box(', packStart);
const packBody = nativePrint.slice(packStart, closeStart);
assert.match(packBody, /close_box_counter/);
assert.match(packBody, /unitsInBox/);
assert.match(packBody, /close_box_internal\(/);

const closeBodyStart = nativePrint.indexOf('fn close_box_internal(', closeStart);
const palletStart = nativePrint.indexOf('pub fn print_pallet(', closeBodyStart);
const closeBody = nativePrint.slice(closeBodyStart, palletStart);
assert.match(closeBody, /templates_box_label/);
assert.match(closeBody, /operational\.close_box/);
assert.match(closeBody, /prepare_delivery/);
assert.match(closeBody, /close_box_with_outbox/);
assert.match(closeBody, /submit_committed_with_sink/);
assert.ok(closeBody.indexOf('close_box_with_outbox') < closeBody.indexOf('submit_committed_with_sink'));

const repeatStart = nativePrint.indexOf('pub fn repeat_last(', palletStart);
const palletBody = nativePrint.slice(palletStart, repeatStart);
assert.match(palletBody, /send_prepared/);
assert.match(palletBody, /operational\.close_current_pallet/);
assert.ok(palletBody.indexOf('send_prepared') < palletBody.indexOf('close_current_pallet'));
assert.doesNotMatch(closeBody + palletBody, /autoPrintOnStable/);

console.log('Pack auto-print scope: toggle shown only for package labels; box close and pallet close printing remain event-driven');
