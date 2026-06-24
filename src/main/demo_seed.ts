/**
 * demo_seed.ts — built-in "Демо режим".
 *
 * Seeds the local DB with bundled SAMPLE templates + products so an unlicensed
 * user can test the full flow (scale -> label -> printer) with NO server and
 * NO license. We deliberately REUSE the existing import path: this module only
 * authors an in-memory dataset in the EXACT shape processSyncData() consumes
 * (see src/main/processor.ts), then hands it over. No new DB logic.
 *
 * The dataset OMITS meta.min_client_version so the compatibility gate in
 * processSyncData() is a no-op for the demo (we never want a bundled demo to be
 * blocked by a version check).
 */

import { processSyncData } from './processor';
import type { LabelDoc } from './printer/generator/types';

const DPI = 300;

/** Convert millimetres to device pixels at the canvas DPI (px = mm * dpi / 25.4). */
const mm = (value: number): number => Math.round((value * DPI) / 25.4);

// ── Canvas presets ──────────────────────────────────────────────────────────
// Pack labels: 58 x 40 mm. Box label: 100 x 70 mm.
const PACK_W_MM = 58;
const PACK_H_MM = 40;
const BOX_W_MM = 100;
const BOX_H_MM = 70;

function packCanvas() {
    return {
        width: mm(PACK_W_MM),
        height: mm(PACK_H_MM),
        widthCm: PACK_W_MM / 10,
        heightCm: PACK_H_MM / 10,
        dpi: DPI,
        background: '#ffffff',
        labelType: 'pack',
    };
}

function boxCanvas() {
    return {
        width: mm(BOX_W_MM),
        height: mm(BOX_H_MM),
        widthCm: BOX_W_MM / 10,
        heightCm: BOX_H_MM / 10,
        dpi: DPI,
        background: '#ffffff',
        labelType: 'box',
    };
}

// LabelDoc carries a few fields the editor writes but types.ts does not declare
// (e.g. `version`, `canvas.labelType`). Author the demo docs through this helper
// so the extra design fields are preserved without tripping the excess-property
// check, while the result is still typed as a LabelDoc.
const labelDoc = (doc: LabelDoc & { version: number }): LabelDoc => doc;

// ── Template 1: weighed pack ────────────────────────────────────────────────
const PACK_WEIGHED: LabelDoc = labelDoc({
    version: 1,
    canvas: packCanvas(),
    elements: [
        {
            id: 'name', type: 'text',
            x: mm(2), y: mm(2), w: mm(54), h: mm(7), rotation: 0,
            text: '{{name}}',
            fontSize: 30, fontWeight: 700, fontFamily: 'Inter',
            textAlign: 'left', color: '#000000',
        },
        {
            id: 'article', type: 'text',
            x: mm(2), y: mm(9.5), w: mm(54), h: mm(4), rotation: 0,
            text: 'Арт.: {{article}}',
            fontSize: 18, fontWeight: 400, fontFamily: 'Inter',
            textAlign: 'left', color: '#000000',
        },
        {
            id: 'weight', type: 'text',
            x: mm(2), y: mm(14), w: mm(54), h: mm(6), rotation: 0,
            text: 'Масса нетто: {{weight_netto_pack}} кг',
            fontSize: 24, fontWeight: 700, fontFamily: 'Inter',
            textAlign: 'left', color: '#000000',
        },
        {
            id: 'prod', type: 'text',
            x: mm(2), y: mm(20), w: mm(27), h: mm(4), rotation: 0,
            text: 'Изгот.: {{production_date}}',
            fontSize: 16, fontWeight: 400, fontFamily: 'Inter',
            textAlign: 'left', color: '#000000',
        },
        {
            id: 'exp', type: 'text',
            x: mm(29), y: mm(20), w: mm(27), h: mm(4), rotation: 0,
            text: 'Годен до: {{exp_date_full}}',
            fontSize: 16, fontWeight: 400, fontFamily: 'Inter',
            textAlign: 'left', color: '#000000',
        },
        {
            id: 'barcode', type: 'barcode',
            x: mm(8), y: mm(24.5), w: mm(42), h: mm(11), rotation: 0,
            value: '{{barcode}}', barcodeType: 'ean13', showText: true,
        },
    ],
});

// ── Template 2: fixed-weight pack ───────────────────────────────────────────
const PACK_FIXED: LabelDoc = labelDoc({
    version: 1,
    canvas: packCanvas(),
    elements: [
        {
            id: 'name', type: 'text',
            x: mm(2), y: mm(2), w: mm(54), h: mm(7), rotation: 0,
            text: '{{name}}',
            fontSize: 30, fontWeight: 700, fontFamily: 'Inter',
            textAlign: 'center', color: '#000000',
        },
        {
            id: 'weight', type: 'text',
            x: mm(2), y: mm(9.5), w: mm(54), h: mm(6), rotation: 0,
            text: 'Масса нетто: {{weight_netto_pack}} кг',
            fontSize: 22, fontWeight: 700, fontFamily: 'Inter',
            textAlign: 'center', color: '#000000',
        },
        {
            id: 'protein', type: 'text',
            x: mm(2), y: mm(15.5), w: mm(54), h: mm(4), rotation: 0,
            text: 'Белки: {{Белки}}  Жиры: {{Жиры}}',
            fontSize: 16, fontWeight: 400, fontFamily: 'Inter',
            textAlign: 'center', color: '#000000',
        },
        {
            id: 'exp', type: 'text',
            x: mm(2), y: mm(19.5), w: mm(54), h: mm(4), rotation: 0,
            text: 'Изгот.: {{production_date}}   Годен до: {{exp_date_full}}',
            fontSize: 15, fontWeight: 400, fontFamily: 'Inter',
            textAlign: 'center', color: '#000000',
        },
        {
            id: 'barcode', type: 'barcode',
            x: mm(8), y: mm(24.5), w: mm(42), h: mm(11), rotation: 0,
            value: '{{barcode}}', barcodeType: 'ean13', showText: true,
        },
    ],
});

// ── Template 3: box label (100 x 70 mm) ─────────────────────────────────────
const BOX_LABEL: LabelDoc = labelDoc({
    version: 1,
    canvas: boxCanvas(),
    elements: [
        {
            id: 'title', type: 'text',
            x: mm(4), y: mm(4), w: mm(92), h: mm(10), rotation: 0,
            text: '{{name}}',
            fontSize: 44, fontWeight: 700, fontFamily: 'Inter',
            textAlign: 'left', color: '#000000',
        },
        {
            id: 'article', type: 'text',
            x: mm(4), y: mm(15), w: mm(92), h: mm(6), rotation: 0,
            text: 'Артикул: {{article}}',
            fontSize: 24, fontWeight: 400, fontFamily: 'Inter',
            textAlign: 'left', color: '#000000',
        },
        {
            id: 'weight', type: 'text',
            x: mm(4), y: mm(22), w: mm(92), h: mm(7), rotation: 0,
            text: 'Масса нетто: {{weight_netto_pack}} кг',
            fontSize: 30, fontWeight: 700, fontFamily: 'Inter',
            textAlign: 'left', color: '#000000',
        },
        {
            id: 'packnum', type: 'text',
            x: mm(4), y: mm(30), w: mm(46), h: mm(6), rotation: 0,
            text: 'Короб №: {{pack_number}}',
            fontSize: 22, fontWeight: 400, fontFamily: 'Inter',
            textAlign: 'left', color: '#000000',
        },
        {
            id: 'sku', type: 'text',
            x: mm(50), y: mm(30), w: mm(46), h: mm(6), rotation: 0,
            text: 'Код ШК: {{Код ШК}}',
            fontSize: 22, fontWeight: 400, fontFamily: 'Inter',
            textAlign: 'left', color: '#000000',
        },
        {
            id: 'prod', type: 'text',
            x: mm(4), y: mm(37), w: mm(46), h: mm(5), rotation: 0,
            text: 'Изготовлен: {{production_date}}',
            fontSize: 20, fontWeight: 400, fontFamily: 'Inter',
            textAlign: 'left', color: '#000000',
        },
        {
            id: 'exp', type: 'text',
            x: mm(50), y: mm(37), w: mm(46), h: mm(5), rotation: 0,
            text: 'Годен до: {{exp_date_full}}',
            fontSize: 20, fontWeight: 400, fontFamily: 'Inter',
            textAlign: 'left', color: '#000000',
        },
        {
            id: 'barcode', type: 'barcode',
            x: mm(20), y: mm(45), w: mm(60), h: mm(20), rotation: 0,
            value: '{{barcode}}', barcodeType: 'ean13', showText: true,
        },
    ],
});

// Label-table row ids (referenced by nomenclature.templates_*_label).
const LABEL_PACK_WEIGHED_ID = 1;
const LABEL_PACK_FIXED_ID = 2;
const LABEL_BOX_ID = 3;

/**
 * Build the demo dataset in the unified sync shape consumed by processSyncData.
 * Nested objects (label.structure, nomenclature.extra_data, barcode.structure)
 * are passed as objects — importFullDump stringifies them itself.
 */
function buildDemoDataset() {
    return {
        station: {
            uuid: 'demo-0000-0000-0000-000000000001',
            number: 1,
            name: 'Демо станция',
            server_url: '',
        },
        payload: {
            nomenclature: [
                {
                    id: 1,
                    name: 'Сыр Гауда (весовой)',
                    article: 'DEMO-001',
                    exp_date: 30,
                    portion_container_id: 1,
                    box_container_id: 2,
                    templates_pack_label: LABEL_PACK_WEIGHED_ID,
                    templates_box_label: LABEL_BOX_ID,
                    templates_pallet_label: null,
                    close_box_counter: 10,
                    is_fixed_weight: 0,
                    extra_data: {
                        'Код ШК': '2000000000015',
                        'Белки': '24 г',
                        'Жиры': '27 г',
                    },
                },
                {
                    id: 2,
                    name: 'Масло сливочное (весовое)',
                    article: 'DEMO-002',
                    exp_date: 60,
                    portion_container_id: 1,
                    box_container_id: 2,
                    templates_pack_label: LABEL_PACK_WEIGHED_ID,
                    templates_box_label: LABEL_BOX_ID,
                    templates_pallet_label: null,
                    close_box_counter: 12,
                    is_fixed_weight: 0,
                    extra_data: {
                        'Код ШК': '2000000000022',
                        'Белки': '0.5 г',
                        'Жиры': '82.5 г',
                    },
                },
                {
                    id: 3,
                    name: 'Творог 5% (фасовка 800г)',
                    article: 'DEMO-003',
                    exp_date: 14,
                    portion_container_id: 1,
                    box_container_id: 2,
                    templates_pack_label: LABEL_PACK_FIXED_ID,
                    templates_box_label: LABEL_BOX_ID,
                    templates_pallet_label: null,
                    close_box_counter: 8,
                    is_fixed_weight: 1,
                    fixed_weight_grams: 800,
                    min_weight_grams: 750,
                    max_weight_grams: 850,
                    extra_data: {
                        'Код ШК': '2000000000039',
                        'Белки': '16 г',
                        'Жиры': '5 г',
                    },
                },
            ],
            containers: [
                { id: 1, name: 'Упаковка', weight: 10.0 },
                { id: 2, name: 'Короб', weight: 0.0 },
            ],
            barcodes: [
                {
                    id: 1,
                    name: 'ean13',
                    structure: {
                        barcode_type: 'ean13',
                        barcode_name: 'ean13',
                        fields: [
                            { field_type: 'extra_data', value: 'Код ШК', length: '13' },
                        ],
                    },
                },
            ],
            labels: [
                { id: LABEL_PACK_WEIGHED_ID, name: 'Демо — упаковка (весовая)', structure: PACK_WEIGHED },
                { id: LABEL_PACK_FIXED_ID, name: 'Демо — упаковка (фикс. вес)', structure: PACK_FIXED },
                { id: LABEL_BOX_ID, name: 'Демо — короб', structure: BOX_LABEL },
            ],
            packs: [],
        },
        meta: {
            type: 'demo',
            generated_at: new Date().toISOString(),
            // NOTE: min_client_version is intentionally OMITTED so the compatibility
            // gate in processSyncData() never blocks the bundled demo dataset.
        },
    };
}

/**
 * Seed the local DB with the bundled demo dataset.
 *
 * WARNING: this routes through importFullDump (DELETE + INSERT), so it REPLACES
 * all local nomenclature/containers/barcodes/labels. The caller is responsible
 * for confirming with the user before invoking.
 */
export async function seedDemoData(): Promise<{ success: boolean; message: string }> {
    const dataset = buildDemoDataset();
    return processSyncData(dataset);
}
