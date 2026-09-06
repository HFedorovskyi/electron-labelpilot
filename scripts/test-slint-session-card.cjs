const fs = require('fs');

const ui = fs.readFileSync('src-tauri/slint/ui/weighing.slint', 'utf8');
const runtime = fs.readFileSync('src-tauri/src/slint_runtime.rs', 'utf8');

function expect(pattern, message, source = ui) {
  if (!pattern.test(source)) throw new Error(message);
}

expect(/export struct CalendarDayRow[\s\S]*in-current-month: bool,[\s\S]*selected: bool,[\s\S]*today: bool,/, 'calendar day model is missing');
expect(/label: root\.narrow \? "ДАТА ПРОИЗВ\." : "ДАТА ПРОИЗВОДСТВА";[\s\S]*root\.open-date-calendar\(\);[\s\S]*root\.date-modal-visible = true;/, 'production date row does not open calendar');
expect(/for week-index in 6: Row[\s\S]*for day-index in 7: CalendarDayButton/, 'calendar must expose a 6 by 7 touch grid');
expect(/callback shift-calendar-month\(int\);/, 'calendar month navigation callback is missing');
expect(/production-date-title:[\s\S]*"Production date"[\s\S]*"Produktionsdatum"[\s\S]*"Дата виробництва"[\s\S]*"Дата производства"/, 'calendar title must support four locales');
expect(/clip: true;[\s\S]*Rectangle \{\s*x: 0px;[\s\S]*root\.units-in-box/, 'box progress fill is not left anchored');
if (ui.includes('ПОСЛЕДНЯЯ ПЕЧАТЬ')) throw new Error('redundant last-print row is still visible');

expect(/fn calendar_day_rows\([\s\S]*\(0\.\.42\)/, 'Rust calendar does not generate 42 cells', runtime);
expect(/fn parse_display_date\([\s\S]*from_calendar_date/, 'selected production date is not validated', runtime);
expect(/if parse_display_date\(ui\.get_labeling_date\(\)\.as_str\(\)\)\.is_none\(\)[\s\S]*set_labeling_date/, 'snapshot refresh may overwrite the selected date', runtime);
expect(/ui\.on_open_date_calendar\([\s\S]*apply_calendar/, 'calendar open callback is not wired', runtime);
expect(/ui\.on_shift_calendar_month\([\s\S]*offset_calendar_month/, 'calendar navigation callback is not wired', runtime);

const editor = ui.slice(ui.indexOf('component StatEditorRow'), ui.indexOf('component KeyButton'));
expect(/spacing: 10px;[\s\S]*horizontal-stretch: 1;[\s\S]*overflow: elide;/, 'editor label and value do not have a guaranteed gap', editor);
expect(/label: root\.narrow \? "ДАТА ПРОИЗВ\." : "ДАТА ПРОИЗВОДСТВА";/, 'production date label is not adaptive');
expect(/dense-label: true;/, 'production date row does not use dense label typography');
const actions = ui.slice(ui.indexOf('text: "ПЕЧАТЬ ЭТИКЕТКИ"') - 120, ui.indexOf('text: "СТАТИСТИКА СЕССИИ"'));
expect(/border-radius: 16px;\s*text: "ПЕЧАТЬ ЭТИКЕТКИ";/, 'print action radius differs from tiles', actions);
expect(/border-radius: 16px;\s*text: "ПАЛЛЕТНЫЙ ЛИСТ";/, 'pallet action radius differs from tiles', actions);
expect(/component TileButton[\s\S]*border-radius: 16px;/, 'tile action radius is not 16px');
console.log('Slint session card: touch calendar, persistent date, left-to-right box progress, and simplified stats verified');
