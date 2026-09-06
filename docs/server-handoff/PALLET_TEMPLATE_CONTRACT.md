# Контракт передачи паллетного шаблона: Сервер → Станция (Electron)

Документ для агента, дорабатывающего Electron-клиент. Описывает **полную структуру данных и рендеринга** паллетного листа, чтобы напечатанная этикетка **точно совпадала** с превью в веб-дизайнере.

Источник истины (canonical) на сервере:
- Типы шаблона: `frontend/lib/label/types.ts`
- Рендерер (Canvas 2D, переносится 1:1): `frontend/lib/label/renderer.ts` (`processDynamicText`, `wrapText`, `drawTable`)
- Бэкенд паллет: `GET /api/v1/pallets/{id}/`

Эталонные копии вложены рядом: `./reference/label-types.ts`, `./reference/draw-table.ts`, `./reference/sample-pallet-scheme.json`, `./reference/sample-pallet-data.json`.

---

## 0. Поток данных (end-to-end)

```
Веб-дизайнер (сервер)                Станция (Electron-клиент)
─────────────────────                ─────────────────────────
1. Пользователь рисует шаблон  ──►  scheme (LabelDoc JSON) сохраняется в БД сервера
   (тип "pallet", элемент table)     отдаётся: GET /api/v1/labels/ → [{ id, name, scheme }]

2. На сервере заводятся паллеты ──►  GET /api/v1/pallets/{id}/ → { pallet_number, items[], totals }

3. Станция:
   sync.ts тянет labels + pallets ──► local SQLite
   при печати: scheme + buildRenderData(pallet) ──► renderLabel(ctx, scheme, data) ──► bitmap/ZPL ──► принтер
```

Ключевой принцип: **WYSIWYG**. Клиент должен использовать ту же модель рендеринга, что и дизайнер (Canvas 2D). Серверный `renderer.ts` переносится в `@napi-rs/canvas` без изменений (тот же API).

---

## 1. Контракт шаблона — `scheme` (LabelDoc)

JSON, который приходит в поле `scheme` из `GET /api/v1/labels/`. Полные типы — `./reference/label-types.ts`. Кратко:

```ts
interface LabelDoc {
  version: 1;
  canvas: {
    width: number; height: number;       // px (рассчитаны от см и dpi)
    widthCm: number; heightCm: number;
    dpi: number;                           // обычно 203
    background: string;                    // "#ffffff"
    showGrid: boolean; gridSize: number;   // только для дизайнера, печать игнорирует
    labelType?: 'pack' | 'box' | 'pallet';
    printedZones: PrintedZone[];
  };
  elements: LabelElement[];                // text | rect | barcode | table
}
```

Все элементы имеют базу `{ id, type, x, y, w, h, rotation }` (координаты/размеры в **px** холста; rotation в градусах вокруг центра).

### Элемент `table` (НОВОЕ для клиента)

```ts
interface TableColumn {
  id: string;
  key: string;        // ключ ПОЛЯ СТРОКИ из items[] (например "name", "weight_brutto_pack")
  title: string;      // заголовок колонки (может переноситься)
  widthRatio: number; // % ширины таблицы (сумма по колонкам ≈ 100)
}
interface TableElement extends LabelElementBase {
  type: "table";
  columns: TableColumn[];
  groupBy: 'none' | 'nomenclature' | 'batch';
  sortBy:  'none' | 'name' | 'date';
  fontSize: number;
  showHeaders: boolean;
  showBorders: boolean;
  fontFamily?: string;
  fontStyle?: 'normal' | 'italic';
  maxRows?: number;   // 0/undefined = авто (по высоте)
}
```

> `pack`/`box` шаблоны таблицы не содержат — для них клиент уже всё умеет. Таблица актуальна только для `labelType: 'pallet'`.

---

## 2. Контракт рантайм-данных — `data`

`renderLabel(ctx, scheme, data)` принимает плоский объект `data: Record<string, any>`:
- **скаляры** — подставляются в `{{key}}` любого текстового элемента (шапка паллеты);
- **`data.items: Item[]`** — массив строк для элемента `table` (каждая строка резолвится по `{{column.key}}`).

### 2.1. Скалярные ключи (шапка паллетного листа)

| Ключ | Значение | Источник (API паллеты) |
|---|---|---|
| `pallet_number` | Номер паллеты | `pallet.pallet_number` |
| `shipping_date` | Дата отгрузки | `pallet.shipping_date` |
| `production_date` | Дата производства | `pallet.production_date` |
| `operator_name` | Оператор | контекст станции |
| `total_count` | Всего единиц (Σ qty) | `totals.count` |
| `total_places` | Кол-во мест/позиций | `totals.positions` |
| `total_boxes` | Кол-во коробов | `totals.count` (или своя логика) |
| `weight_total` | Общий вес брутто | `totals.weight_brutto` |
| `weight_netto_pallet` | Вес нетто паллеты | `totals.weight_netto` |
| `weight_brutto_pallet` | Вес брутто паллеты | `totals.weight_brutto` |

### 2.2. Ключи строки `items[i]` (ячейки таблицы)

Канонический набор ключей строки (совпадает с выпадашкой «Ключ» колонок в дизайнере, `TABLE_COLUMN_KEYS`):

| Ключ строки | Значение | Источник (PalletItem) |
|---|---|---|
| `name` | Наименование | `item.name` |
| `article` | Артикул | `item.article` |
| `quantity` | Количество | `item.quantity` |
| `batch_number` | Партия | `item.batch_number` |
| `production_date_batch` | Дата производства партии | `pallet.production_date` / партия |
| `exp_date_full` | Годен до | расчёт по сроку годности |
| `weight_netto_pack` | Вес нетто (ед.) | `item.weight_netto` |
| `weight_brutto_pack` | Вес брутто (ед.) | `item.weight_brutto` |
| `weight_netto_batch` | Вес нетто партии | агрегат по партии |
| `weight_brutto_batch` | Вес брутто партии | агрегат по партии |
| `weight_netto_nomenclature` | Вес нетто номенкл. | по номенклатуре |
| `weight_brutto_nomenclature` | Вес брутто номенкл. | по номенклатуре |

> ⚠️ **Маппинг обязателен.** API `/api/v1/pallets/{id}/` отдаёт по позиции `weight_netto`/`weight_brutto`, а шаблон ждёт `weight_netto_pack`/`weight_brutto_pack` и т.д. Клиент должен собрать `data` из ответа API — см. `buildPalletRenderData()` ниже.

### 2.3. Ответ `GET /api/v1/pallets/{id}/` (то, что синкается)

```jsonc
{
  "id": 1,
  "pallet_number": "PLT-000123",
  "shipping_date": "2026-06-22",
  "production_date": "2026-06-21",
  "note": "",
  "items": [
    { "id": 10, "nomenclature": 5, "article": "ART-1001", "name": "Колбаса «Молочная»",
      "quantity": 8, "batch_number": "LOT-1001", "weight_netto": 9.5, "weight_brutto": 9.9, "order": 0 }
    // ...
  ],
  "totals": { "count": 138, "positions": 12, "weight_netto": 120.0, "weight_brutto": 132.3 }
}
```

### 2.4. Сборка `data` из паллеты (клиент реализует)

```ts
function buildPalletRenderData(p /* ответ /api/v1/pallets/{id}/ */, ctx = {}) {
  return {
    pallet_number: p.pallet_number,
    shipping_date: p.shipping_date ?? "",
    production_date: p.production_date ?? "",
    operator_name: ctx.operator ?? "",
    total_count: String(p.totals?.count ?? ""),
    total_places: String(p.totals?.positions ?? ""),
    total_boxes: String(p.totals?.count ?? ""),
    weight_total: (p.totals?.weight_brutto ?? 0).toFixed(3),
    weight_netto_pallet: (p.totals?.weight_netto ?? 0).toFixed(3),
    weight_brutto_pallet: (p.totals?.weight_brutto ?? 0).toFixed(3),
    items: (p.items ?? []).map(it => ({
      name: it.name,
      article: it.article,
      quantity: String(it.quantity ?? ""),
      batch_number: it.batch_number ?? "",
      production_date_batch: p.production_date ?? "",
      exp_date_full: "",                        // подставить по сроку годности номенклатуры
      weight_netto_pack: (it.weight_netto ?? 0).toFixed(3),
      weight_brutto_pack: (it.weight_brutto ?? 0).toFixed(3),
    })),
  };
}
```

---

## 3. Резолв плейсхолдеров

Функция `processDynamicText(text, data, { minLength? })` (см. `./reference/draw-table.ts`). Правила:
- `{{key}}` → `String(data[key])`; если ключа нет — оставляет `{{key}}` как есть.
- `pack_number` / `box_number`: если число — паддинг нулями до 12 знаков.
- `pallet_number` / `pack_counter`: паддинг до `minLength` (из `element.minLength`).
- **Ячейки таблицы**: тот же `processDynamicText(\`{{ ${column.key} }}\`, item)` — но `data` здесь это **строка `item`**, а не общий объект. Так per-row резолв и достигается (никакого спец-синтаксиса `{{items[i]...}}` не нужно).

Клиентский `processText()` уже почти такой — нужно лишь вызывать его с объектом строки при отрисовке ячеек таблицы.

---

## 4. Алгоритм отрисовки таблицы (canonical `drawTable`)

Полный код — `./reference/draw-table.ts`. Перенести в `CanvasBitmapGenerator` (и аналогично в `ZplGenerator` — текстовыми блоками + линиями). Поведение, которое обязан повторить клиент:

1. **Шапка с переносом**: заголовки колонок переносятся (`wrapText`), высота шапки = по максимуму строк среди колонок.
2. **Сортировка**: `sortBy='name'` — по `item.name` (локаль ru); `'date'` — по `item.production_date_batch`.
3. **maxRows**: если задано — обрезать массив до N до отрисовки.
4. **Группировка** (`groupBy`):
   - `'batch'` — строки группируются по `batch_number`; над каждой группой — полоса-заголовок `Партия {n} · Произв.: {дата} · Годен до: {дата}` (даты берутся из первой строки группы — они общие для партии).
   - `'nomenclature'` — группировка по `name`, заголовок группы = название.
   - `'none'` — плоский список.
5. **Перенос ячеек**: значение каждой ячейки переносится по ширине колонки; высота строки = по максимуму строк среди ячеек.
6. **Футер-индикатор страниц** (всегда виден, когда есть строки): внизу зарезервирована полоса `footerH = round(rowHeight*3)`. Текст:
   - всё влезло → `Стр. 1 / 1 · всего {N} позиций`
   - не влезло → `Стр. 1 / {K} · показано {X} из {N} позиций`, где `K = ceil(всего / показано)`.
   Строки рисуются в пределах `bodyLimit = h - footerH`.

> Координаты внутри таблицы — локальные (после `ctx.translate(x, y)`). Цвета/толщины — как в эталоне (шапка `#f8fafc`, линии `#cbd5e1`, полоса группы `#e8edf3`, футер `#e2e8f0`).

---

## 5. Штрихкоды

- Элемент `barcode`: `value` резолвится через `processDynamicText`, затем рендерится по `barcodeType`.
- Сервер использует treepoem/BWIPP; клиент — **bwip-js** (уже есть, `barcodeGenerator.ts`). Символики совпадают (code128, ean13, qrcode, datamatrix, gs1-128 и т.д.).
- Для паллетного листа штрихкод обычно один (на всю паллету), значение из `{{pallet_number}}` или агрегата.

---

## 6. Что клиенту добавить (чек-лист, по карте кода)

| Слой | Файл | Изменение |
|---|---|---|
| Типы | `src/main/printer/generator/types.ts` | Добавить `TableColumn`, `TableElement`; добавить `'table'` в union элементов |
| Рендер (raster) | `src/main/printer/generator/CanvasBitmapGenerator.ts` | Добавить `drawTable(ctx, el, data)` (порт из `./reference/draw-table.ts`); вызвать в `renderElement()` для `type==='table'` |
| Рендер (ZPL) | `src/main/printer/generator/ZplGenerator.ts` | Аналог таблицы текстовыми блоками + линиями (или растром, как barcode) |
| Резолв строк | `CanvasBitmapGenerator.ts` (`processText`) | Уметь резолвить ячейку по объекту строки (передавать `item` как data) |
| Данные | `src/renderer/components/...` (сборка print-data) | Ветка «паллета»: вызвать `buildPalletRenderData(pallet)`; положить `items[]` в data |
| Sync | `src/main/sync.ts` (`SyncData`) + `src/main/database.ts` (`importFullDump`) | Тянуть паллеты: добавить поле `pallets`, импорт в локальные таблицы `pallet/boxes/pack` (схема уже есть, `database.ts:68-89`) |
| Превью (опц.) | `src/renderer/components/LabelRenderer.tsx` | По желанию — отрисовать таблицу и в HTML-превью |
| Печать (опц.) | `src/main/printer/PrinterService.ts` | Многостраничность: если позиций > влезает, эмитить N буферов (page 1..K). На первом этапе можно не делать — индикатор «Стр. 1/K» уже честно показывает. |

Минимальный первый шаг: типы + `drawTable` в `CanvasBitmapGenerator` + `items[]` в data + sync паллет. Многостраничную печать отложить.

---

## 7. Приёмочный тест

1. Сервер: создать шаблон «Паллета» (A5) с таблицей (колонки Наименование/Партия/Кол-во/Вес), группировка «По партии».
2. Сервер: завести паллету с 12 позициями в 2 партиях → `GET /api/v1/pallets/{id}/`.
3. Клиент: `buildPalletRenderData` → `renderLabel(ctx, scheme, data)` → растр.
4. Сверить с превью дизайнера: заголовки переносятся, группы с датами в шапке группы, снизу «Стр. 1/N · показано X из 12».

Готовые образцы: `./reference/sample-pallet-scheme.json` + `./reference/sample-pallet-data.json` — можно прогнать рендер сразу, без сервера.
