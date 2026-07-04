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

import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { processSyncData } from './processor';
import { setDemoFlag } from './demo_flag';
import { savePrintJob, clearAllPrintJobs, clearOperationalData } from './database';
import type { LabelDoc } from './printer/generator/types';

// Entering demo overwrites the local DB (incl. the station identity) with a synthetic
// "demo-" station, which the server can't recognize. To make demo NON-destructive we
// snapshot the real identity on entry and restore it on exit, so the station returns to
// the server with the exact same uuid/number it had before.
function identityBackupPath(): string {
    return path.join(app.getPath('userData'), 'identity_pre_demo.json');
}

/** Snapshot the current REAL station identity (no-op if none yet, or already a demo one). */
export function backupRealIdentity(): void {
    try {
        const { getStationIdentity } = require('./database');
        const id = getStationIdentity();
        if (id && id.uuid && !String(id.uuid).startsWith('demo-')) {
            fs.writeFileSync(identityBackupPath(), JSON.stringify({
                uuid: id.uuid, number: id.number, name: id.name || '', server_url: id.server_url || '',
            }));
        }
    } catch (e) {
        console.error('[demo] backupRealIdentity failed:', e);
    }
}

/** Leave demo: wipe demo data + clear the durable flag, then restore the real station
 *  identity (if it was backed up on entry) so the server finds the station again. */
export async function exitDemo(): Promise<{ success: boolean; restored: boolean; message?: string }> {
    try {
        const { resetDatabase, updateStationIdentity } = require('./database');
        const { clearDemoFlag } = require('./demo_flag');

        let backup: any = null;
        try { backup = JSON.parse(fs.readFileSync(identityBackupPath(), 'utf-8')); } catch { /* no backup */ }

        resetDatabase();      // recreates a clean empty schema
        clearDemoFlag();

        // Fallback for stations that entered demo BEFORE the backup existed: identity.json
        // MIGHT still hold the real identity. (Note: demo seeding can also overwrite it with
        // the demo station, so only accept a non-demo value here.)
        if (!backup || !backup.uuid || String(backup.uuid).startsWith('demo-')) {
            try {
                const { loadIdentity } = require('./identity');
                const fromFile = loadIdentity();
                if (fromFile && fromFile.station_uuid && !String(fromFile.station_uuid).startsWith('demo-')) {
                    backup = { uuid: fromFile.station_uuid, number: fromFile.station_number, name: '', server_url: fromFile.server_url || '' };
                }
            } catch { /* none */ }
        }

        let restored = false;
        if (backup && backup.uuid && !String(backup.uuid).startsWith('demo-')) {
            updateStationIdentity({
                uuid: backup.uuid,
                number: Number(backup.number) || 0,
                name: backup.name || '',
                server_url: backup.server_url || '',
            });
            restored = true;
        } else {
            // Nothing real to restore (demo overwrote identity.json too). Drop the demo
            // identity file so loadIdentity() stops reporting the demo station — the client
            // then re-registers via discovery (matched by IP) and re-syncs the real catalog.
            try { const { deleteIdentity } = require('./identity'); deleteIdentity(); } catch { /* ignore */ }
        }
        try { fs.unlinkSync(identityBackupPath()); } catch { /* ignore */ }
        return { success: true, restored };
    } catch (e: any) {
        return { success: false, restored: false, message: e?.message || String(e) };
    }
}

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
            text: 'Art.: {{article}}',
            fontSize: 18, fontWeight: 400, fontFamily: 'Inter',
            textAlign: 'left', color: '#000000',
        },
        {
            id: 'weight', type: 'text',
            x: mm(2), y: mm(14), w: mm(54), h: mm(6), rotation: 0,
            text: 'Net weight: {{weight_netto_pack}} kg',
            fontSize: 24, fontWeight: 700, fontFamily: 'Inter',
            textAlign: 'left', color: '#000000',
        },
        {
            id: 'prod', type: 'text',
            x: mm(2), y: mm(20), w: mm(27), h: mm(4), rotation: 0,
            text: 'Prod.: {{production_date}}',
            fontSize: 16, fontWeight: 400, fontFamily: 'Inter',
            textAlign: 'left', color: '#000000',
        },
        {
            id: 'exp', type: 'text',
            x: mm(29), y: mm(20), w: mm(27), h: mm(4), rotation: 0,
            text: 'Best before: {{exp_date_full}}',
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
            text: 'Net weight: {{weight_netto_pack}} kg',
            fontSize: 22, fontWeight: 700, fontFamily: 'Inter',
            textAlign: 'center', color: '#000000',
        },
        {
            id: 'protein', type: 'text',
            x: mm(2), y: mm(15.5), w: mm(54), h: mm(4), rotation: 0,
            text: 'Protein: {{Белки}}  Fat: {{Жиры}}',
            fontSize: 16, fontWeight: 400, fontFamily: 'Inter',
            textAlign: 'center', color: '#000000',
        },
        {
            id: 'exp', type: 'text',
            x: mm(2), y: mm(19.5), w: mm(54), h: mm(4), rotation: 0,
            text: 'Prod.: {{production_date}}   Best before: {{exp_date_full}}',
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
            text: 'Article: {{article}}',
            fontSize: 24, fontWeight: 400, fontFamily: 'Inter',
            textAlign: 'left', color: '#000000',
        },
        {
            id: 'weight', type: 'text',
            x: mm(4), y: mm(22), w: mm(92), h: mm(7), rotation: 0,
            text: 'Net weight: {{weight_netto_pack}} kg',
            fontSize: 30, fontWeight: 700, fontFamily: 'Inter',
            textAlign: 'left', color: '#000000',
        },
        {
            id: 'packnum', type: 'text',
            x: mm(4), y: mm(30), w: mm(46), h: mm(6), rotation: 0,
            text: 'Box No.: {{pack_number}}',
            fontSize: 22, fontWeight: 400, fontFamily: 'Inter',
            textAlign: 'left', color: '#000000',
        },
        {
            id: 'sku', type: 'text',
            x: mm(50), y: mm(30), w: mm(46), h: mm(6), rotation: 0,
            text: 'SKU: {{Код ШК}}',
            fontSize: 22, fontWeight: 400, fontFamily: 'Inter',
            textAlign: 'left', color: '#000000',
        },
        {
            id: 'prod', type: 'text',
            x: mm(4), y: mm(37), w: mm(46), h: mm(5), rotation: 0,
            text: 'Produced: {{production_date}}',
            fontSize: 20, fontWeight: 400, fontFamily: 'Inter',
            textAlign: 'left', color: '#000000',
        },
        {
            id: 'exp', type: 'text',
            x: mm(50), y: mm(37), w: mm(46), h: mm(5), rotation: 0,
            text: 'Best before: {{exp_date_full}}',
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
            name: 'Demo Station',
            server_url: '',
        },
        payload: {
            nomenclature: [
                {
                    id: 1,
                    name: 'Gouda Cheese (by weight)',
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
                        'Белки': '24 g',
                        'Жиры': '27 g',
                    },
                },
                {
                    id: 2,
                    name: 'Butter (by weight)',
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
                        'Белки': '0.5 g',
                        'Жиры': '82.5 g',
                    },
                },
                {
                    id: 3,
                    name: 'Cottage Cheese 5% (800 g pack)',
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
                        'Белки': '16 g',
                        'Жиры': '5 g',
                    },
                },
            ],
            containers: [
                { id: 1, name: 'Wrapper', weight: 10.0 },
                { id: 2, name: 'Box', weight: 0.0 },
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
                { id: LABEL_PACK_WEIGHED_ID, name: 'Demo — Pack (by weight)', structure: PACK_WEIGHED },
                { id: LABEL_PACK_FIXED_ID, name: 'Demo — Pack (fixed weight)', structure: PACK_FIXED },
                { id: LABEL_BOX_ID, name: 'Demo — Box', structure: BOX_LABEL },
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

// Demo print jobs for the "По заданию" (task-based marking) station — so that flow
// is demonstrable without a server. They reference the demo nomenclature above and
// cover both unit modes: pieces (pcs) and weighed (kg). Print jobs live in their own
// table (not part of the sync payload), so they are seeded separately below.
const DEMO_PRINT_JOBS = [
    { job_id: 9001, nomenclature_id: 3, nomenclature_name: 'Cottage Cheese 5% (800 g pack)', nomenclature_article: 'DEMO-003', quantity: 50, quantity_unit: 'pcs', batch_number: 'DEMO-2025-01', marking_date: null },
    { job_id: 9002, nomenclature_id: 1, nomenclature_name: 'Gouda Cheese (by weight)', nomenclature_article: 'DEMO-001', quantity: 30, quantity_unit: 'kg', batch_number: 'DEMO-2025-02', marking_date: null },
    { job_id: 9003, nomenclature_id: 2, nomenclature_name: 'Butter (by weight)', nomenclature_article: 'DEMO-002', quantity: 40, quantity_unit: 'pcs', batch_number: 'DEMO-2025-03', marking_date: null },
];

/**
 * Seed the local DB with the bundled demo dataset.
 *
 * WARNING: this routes through importFullDump (DELETE + INSERT), so it REPLACES
 * all local nomenclature/containers/barcodes/labels. The caller is responsible
 * for confirming with the user before invoking.
 */
export async function seedDemoData(): Promise<{ success: boolean; message: string }> {
    // Snapshot the real station identity FIRST so exitDemo() can restore it later.
    backupRealIdentity();
    // Clear real production data: importFullDump replaces only master tables, so a real
    // Open box/pallet would otherwise survive into demo — orphaned (its product wiped)
    // and unclosable, blocking the demo pallet flow and operator-switch gate.
    try { clearOperationalData(); } catch (e) { console.error('[demo_seed] clearOperationalData failed:', e); }
    const dataset = buildDemoDataset();
    const result = await processSyncData(dataset);
    // The station is now in demo: persist the DURABLE flag so demo mode survives
    // independently of the synthetic 'demo-' station uuid (see demo_flag.ts).
    if (result.success) {
        setDemoFlag();
        // Seed demo print jobs (separate table). Non-fatal: the rest of the demo
        // still works even if this fails.
        try {
            clearAllPrintJobs();
            for (const job of DEMO_PRINT_JOBS) savePrintJob(job);
        } catch (err) {
            console.error('[demo_seed] failed to seed demo print jobs:', err);
        }
    }
    return result;
}
