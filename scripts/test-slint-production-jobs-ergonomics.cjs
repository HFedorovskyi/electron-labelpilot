const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'src-tauri/slint/ui/weighing.slint'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'src-tauri/src/slint_runtime.rs'), 'utf8');
const operational = fs.readFileSync(path.join(root, 'src-tauri/src/operational.rs'), 'utf8');
const pageStart = ui.indexOf('if root.active-page == 6: Rectangle {');
const pageEnd = ui.indexOf('if root.active-page == 7: Rectangle {', pageStart);
assert.ok(pageStart >= 0 && pageEnd > pageStart, 'production jobs page boundaries missing');
const page = ui.slice(pageStart, pageEnd);
const closeBoxStart = runtime.indexOf('ui.on_close_box({');
const closeBoxEnd = runtime.indexOf('ui.on_print_pallet({', closeBoxStart);
assert.ok(closeBoxStart >= 0 && closeBoxEnd > closeBoxStart, 'close-box callback boundaries missing');
const closeBoxCallback = runtime.slice(closeBoxStart, closeBoxEnd);
const countersStart = runtime.indexOf('fn set_production_counters(');
const countersEnd = runtime.indexOf('fn selected_fixed_product(', countersStart);
assert.ok(countersStart >= 0 && countersEnd > countersStart, 'production counters boundaries missing');
const productionCounters = runtime.slice(countersStart, countersEnd);

for (const fragment of [
  'in-out property <bool> production-job-marking-visible: false;',
  'height: root.production-job-marking-visible ? 62px : root.narrow ? 106px : 62px;',
  'if !root.production-job-marking-visible && !root.narrow: HorizontalLayout {',
  'if !root.production-job-marking-visible && root.narrow: VerticalLayout {',
  'if root.production-job-marking-visible: HorizontalLayout {',
  'if !root.production-job-marking-visible: jobs-list-card := Rectangle {',
  'if root.production-job-marking-visible: jobs-detail-card := Rectangle {',
  'jobs-workspace := Rectangle {',
  'width: min(root.page-width - root.content-padding * 2, root.wide ? 1440px : 1180px);',
]) assert.ok(ui.includes(fragment), 'missing two-stage adaptive layout contract: ' + fragment);
assert.doesNotMatch(page, /width: root\.narrow \? 288px : root\.wide \? 390px : 340px;/, 'task list must use the whole workspace');
assert.match(page, /root\.production-job-marking-visible = true;\s*root\.select-production-job\(index\);/, 'task touch must open the marking stage');
assert.match(page, /text: "‹ " \+ root\.jobs-back-label;[\s\S]*?root\.production-job-marking-visible = false;/, 'marking header must return to task selection');
assert.match(ui, /clicked => \{ root\.active-page = 6; root\.production-job-marking-visible = false;/, 'sidebar entry must always open task selection');

for (const fragment of [
  'in-out property <length> production-jobs-scroll-y: 0px;',
  'production-jobs-scroll := ScrollView {',
  'viewport-y <=> root.production-jobs-scroll-y;',
  'vertical-scrollbar-policy: ScrollBarPolicy.always-off;',
  'horizontal-scrollbar-policy: ScrollBarPolicy.always-off;',
  'mouse-drag-pan-enabled: true;',
  'enabled: root.production-jobs-scroll-y < 0px;',
  'production-jobs-scroll.viewport-height > production-jobs-scroll.visible-height',
]) assert.ok(ui.includes(fragment), 'missing touch-scroll contract: ' + fragment);
assert.equal((page.match(/TouchScrollStepButton \{/g) || []).length, 2, 'task selection needs up/down touch controls');
assert.match(page, /if root\.production-jobs\.length > 3: HorizontalLayout \{\s*height: 52px;/, 'touch step controls must stay under the list');

assert.equal((page.match(/ProductionJobMetricCard \{/g) || []).length, 3, 'plan, fact and current weight must remain visible');
assert.equal((page.match(/ProductionJobInfoCard \{/g) || []).length, 3, 'batch, date and mode must remain visible');
assert.equal((page.match(/ProductionJobFlowCard \{/g) || []).length, 3, 'package, box and pallet context must remain visible');
assert.equal((page.match(/StatusPill \{/g) || []).length, 3, 'scales, printer and weight auto-print need three status indicators');
for (const fragment of [
  'jobs-device-status-row := HorizontalLayout {',
  'height: root.short ? 30px : 38px;',
  'text: root.scale-online ? root.jobs-scale-online-label : root.jobs-scale-offline-label;',
  'text: root.printer-ready ? root.jobs-printer-online-label : root.jobs-printer-offline-state-label;',
  'text: root.auto-print-enabled ? root.jobs-auto-print-on-label : root.jobs-auto-print-off-label;',
  'neutral: !root.auto-print-enabled;',
  '@image-url("../assets/icons/scale.png")',
  '@image-url("../assets/icons/printer.png")',
  '@image-url("../assets/icons/refresh-cw.png")',
]) assert.ok(page.includes(fragment), 'operational indicator contract missing: ' + fragment);
assert.equal((page.match(/width: \(jobs-device-status-row\.width - \(root\.short \? 12px : 16px\)\) \/ 3;/g) || []).length, 3, 'status indicators must have equal adaptive widths');
assert.match(ui, /component StatusPill inherits Rectangle \{[\s\S]*?in property <bool> neutral: false;[\s\S]*?border-color: root\.neutral \? Palette\.n300/, 'disabled auto-print must use a neutral state instead of an error state');

for (const row of ['jobs-metrics-row', 'jobs-info-row', 'jobs-flow-row']) {
  assert.match(page, new RegExp(row + ' := HorizontalLayout \\{\\s*width: parent\\.width - \\(root\\.short \\? 24px : 32px\\);\\s*horizontal-stretch: 1;'), row + ' must occupy the marking width');
}
for (const fragment of [
  'root.pack-number',
  'root.box-number',
  'root.units-in-box',
  'root.box-limit',
  'root.boxes-on-pallet',
  'value: root.selected-production-job-printed;',
  'value: root.gross-weight + " kg";',
]) assert.ok(page.includes(fragment), 'marking context lost: ' + fragment);

assert.match(page, /clip: true;\s*Rectangle \{\s*x: 0px;\s*width: max\(0px, min\(parent\.width, parent\.width \* job\.progress\)\);/, 'task progress must start at the left edge');
assert.match(page, /clip: true;\s*Rectangle \{\s*x: 0px;\s*width: max\(0px, min\(parent\.width, parent\.width \* root\.selected-production-job-progress\)\);/, 'marking progress must start at the left edge');

for (const fragment of [
  'text: root.jobs-print-box-label;',
  '@image-url("../assets/icons/box.png")',
  'root.units-in-box > 0',
  'root.close-box();',
]) assert.ok(page.includes(fragment), 'box-summary action contract missing: ' + fragment);
assert.ok(closeBoxCallback.includes('ui.get_selected_production_product_id()'), 'box summary must use the task product');
assert.ok(closeBoxCallback.includes('ui.get_selected_production_job_batch()'), 'box summary must use the task batch');
assert.ok(closeBoxCallback.includes('ui.get_selected_production_job_date()'), 'box summary must use the task marking date');
assert.ok(closeBoxCallback.includes('ui.set_production_jobs_busy(true);'), 'box summary must lock repeated task actions');
assert.ok(runtime.includes('matches!(action.as_str(), "box" | "pallet")'), 'box and pallet completion must release the task busy state');

for (const fragment of [
  'text: root.jobs-print-pallet-label;',
  '@image-url("../assets/icons/layers-white.png")',
  'normal-color: Palette.a600;',
  'root.print-pallet();',
  'root.boxes-on-pallet > 0',
]) assert.ok(page.includes(fragment), 'pallet-sheet action contract missing: ' + fragment);
assert.match(page, /if root\.units-in-box > 0 \{[\s\S]*?root\.alert-text = root\.jobs-open-box-warning[\s\S]*?root\.alert-visible = true;[\s\S]*?\} else \{\s*root\.complete-production-job\(\);/, 'completion must show a localized warning while a box is open');
assert.ok(runtime.includes('if ui.get_units_in_box() > 0 {'), 'runtime callback must guard completion');
assert.ok(productionCounters.includes('.current_box_number'), 'task flow must show the current product box');
assert.ok(!productionCounters.includes('last_box_number'), 'task flow must not fall back to another product box');
assert.ok(operational.includes('SELECT nomenclature_id FROM print_jobs WHERE job_id = ?1'), 'completion guard must resolve the selected task product');
assert.ok(operational.includes('discard_empty_open_boxes_transaction(&transaction, nomenclature_id)?;'), 'empty open boxes for the task product must be discarded in the completion transaction');
assert.ok(operational.includes("status = 'Open' AND nomenclature_id = ?1"), 'nonempty open-box guard must be scoped to the task product');
assert.ok(operational.includes('"discardedEmptyBoxes": discarded_empty_boxes'), 'completion result must report discarded empty boxes');
assert.match(runtime, /let from_production_job\s*=\s*ui\.get_active_page\(\) == 6/, 'pallet printing must use the task product');
assert.ok(runtime.includes('ui.set_production_job_marking_visible(false);'), 'successful completion/delete must return to task selection');

for (const property of [
  'jobs-page-title', 'jobs-marking-title', 'jobs-back-label',
  'jobs-scale-online-label', 'jobs-scale-offline-label',
  'jobs-printer-online-label', 'jobs-printer-offline-state-label',
  'jobs-auto-print-on-label', 'jobs-auto-print-off-label',
  'jobs-active-label', 'jobs-completed-label', 'jobs-refresh-label',
  'jobs-plan-label', 'jobs-fact-label', 'jobs-current-weight-label',
  'jobs-package-label', 'jobs-box-label', 'jobs-pallet-label',
  'jobs-print-label', 'jobs-print-box-label', 'jobs-print-pallet-label',
  'jobs-complete-label', 'jobs-open-box-warning', 'jobs-open-box-units-label',
  'jobs-delete-label',
]) {
  const line = ui.split('\n').find((value) => value.includes('property <string> ' + property + ':'));
  assert.ok(line, 'missing localized property: ' + property);
  for (const locale of ['"en"', '"de"', '"uk"']) {
    assert.ok(line.includes(locale), property + ' missing locale ' + locale);
  }
}

assert.equal((ui.match(/in property <length> label-font-size: 20px;/g) || []).length, 1, 'custom action label size must belong only to MainButton');

console.log('Slint production jobs: full-width stages, equipment and auto-print indicators, touch scroll, box summary, pallet print and open-box guard verified');