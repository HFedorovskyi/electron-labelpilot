"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.importDataToDB = importDataToDB;
exports.syncDataFromServer = syncDataFromServer;
const electron_1 = require("electron");
const axios_1 = __importDefault(require("axios"));
const database_1 = require("./database");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const electron_2 = require("electron");
function importDataToDB(data) {
    const db = (0, database_1.initDatabase)();
    // Resolve aliases from server payload
    const barcodes = data.barcodes || data.barcode_templates || [];
    const labels = data.labels || data.label_templates || [];
    const containers = data.containers || data.packs || [];
    const nomenclatures = data.nomenclature || data.nomenclatures || [];
    try {
        console.log('Sync Client: Payload structure keys:', Object.keys(data));
        console.log('Sync Client: Found counts - Barcodes:', barcodes.length, 'Labels:', labels.length, 'Containers:', containers.length, 'Products:', nomenclatures.length);
    }
    catch (e) { /* ignore log errors */ }
    if (!nomenclatures || nomenclatures.length === 0) {
        try {
            console.warn('Sync Client: No nomenclature found in payload');
        }
        catch (e) { }
    }
    // Transactional Import
    const syncTx = db.transaction(() => {
        try {
            console.log('Sync Client: Starting transaction...');
        }
        catch (e) { }
        // 0. Update Station Number if present
        if (data.station_number !== undefined) {
            const stationNum = String(data.station_number);
            try {
                console.log('Sync Client: Updating station number to', stationNum);
            }
            catch (e) { }
            const row = db.prepare('SELECT uuid_client FROM uuid LIMIT 1').get();
            if (row) {
                db.prepare('UPDATE uuid SET station_number = ?').run(stationNum);
            }
            else {
                const { randomUUID } = require('crypto');
                db.prepare('INSERT INTO uuid (uuid_client, station_number) VALUES (?, ?)').run(randomUUID(), stationNum);
            }
        }
        // 1. Clear existing data
        db.prepare('DELETE FROM pack').run();
        db.prepare('DELETE FROM boxes').run();
        db.prepare('DELETE FROM pallet').run();
        db.prepare('DELETE FROM nomenclature').run();
        db.prepare('DELETE FROM container').run();
        db.prepare('DELETE FROM labels').run();
        db.prepare('DELETE FROM barcodes').run();
        // 2. Insert new data (Dependency Order)
        // Barcodes
        const insertBarcode = db.prepare('INSERT INTO barcodes (id, name, structure) VALUES (@id, @name, @structure)');
        let barcodeCount = 0;
        for (const item of barcodes) {
            const row = { ...item };
            if (typeof row.structure === 'object') {
                row.structure = JSON.stringify(row.structure);
            }
            insertBarcode.run(row);
            barcodeCount++;
        }
        // Labels
        const insertLabel = db.prepare('INSERT INTO labels (id, name, structure, created_at, updated_at) VALUES (@id, @name, @structure, @created_at, @updated_at)');
        let labelCount = 0;
        for (const item of labels) {
            const row = { ...item };
            if (typeof row.structure === 'object') {
                row.structure = JSON.stringify(row.structure);
            }
            insertLabel.run(row);
            labelCount++;
        }
        // Containers
        const insertContainer = db.prepare('INSERT INTO container (id, name, weight) VALUES (@id, @name, @weight)');
        let containerCount = 0;
        for (const item of containers) {
            insertContainer.run({
                id: item.id,
                name: item.name,
                weight: item.weight || 0
            });
            containerCount++;
        }
        // Nomenclature
        const insertNom = db.prepare(`
            INSERT INTO nomenclature (
                id, name, article, exp_date, 
                portion_container_id, box_container_id, 
                templates_pack_label, templates_box_label, 
                close_box_counter, extra_data
            ) VALUES (
                @id, @name, @article, @exp_date, 
                @portion_container, @box_container, 
                @templates_pack_label, @templates_box_label, 
                @close_box_counter, @extra_data
            )
        `);
        // PRE-CREATE MAPS for performance (move outside the nomenclature loop)
        const containerMap = new Map(containers.map((c) => [c.name, c.id]));
        const labelMap = new Map(labels.map((l) => [l.name, l.id]));
        let nomCount = 0;
        for (const item of nomenclatures) {
            try {
                // Pre-process extra_data to include Russian keys translation
                let extra = {};
                if (item.extra_data) {
                    try {
                        extra = typeof item.extra_data === 'string' ? JSON.parse(item.extra_data) : item.extra_data;
                    }
                    catch (e) {
                        try {
                            console.warn('Sync Client: Failed to parse extra_data for item', item.id, e);
                        }
                        catch (err) { }
                    }
                }
                const mapping = {
                    'protein': 'белки',
                    'fat': 'жиры',
                    'carbohydrates': 'углеводы',
                    'energy': 'ккал'
                };
                for (const [eng, rus] of Object.entries(mapping)) {
                    if (Object.prototype.hasOwnProperty.call(extra, eng) && !Object.prototype.hasOwnProperty.call(extra, rus)) {
                        extra[rus] = String(extra[eng]).replace('g', 'г').replace('kcal', '');
                    }
                }
                let portionId = item.portion_container_id;
                if (!portionId && item.portion_container_name) {
                    portionId = containerMap.get(item.portion_container_name) || null;
                }
                let boxId = item.box_container_id;
                if (!boxId && item.box_container_name) {
                    boxId = containerMap.get(item.box_container_name) || null;
                }
                let packLabelId = item.templates_pack_label;
                if (!packLabelId && (item.pack_label_name || item.templates_pack_label_name)) {
                    packLabelId = labelMap.get(item.pack_label_name || item.templates_pack_label_name) || null;
                }
                let boxLabelId = item.templates_box_label;
                if (!boxLabelId && (item.box_label_name || item.templates_box_label_name)) {
                    boxLabelId = labelMap.get(item.box_label_name || item.templates_box_label_name) || null;
                }
                const row = {
                    id: item.id,
                    name: item.name,
                    article: item.article,
                    exp_date: item.exp_date,
                    portion_container: portionId,
                    box_container: boxId,
                    templates_pack_label: packLabelId,
                    templates_box_label: boxLabelId,
                    close_box_counter: item.close_box_counter || 0,
                    extra_data: JSON.stringify(extra)
                };
                insertNom.run(row);
                nomCount++;
            }
            catch (err) {
                try {
                    console.error(`Sync Client: Failed to insert nomenclature "${item.name}" (ID: ${item.id}):`, err.message);
                }
                catch (e) { }
                throw err;
            }
        }
        try {
            console.log(`Sync Client: Imported ${barcodeCount} barcodes, ${labelCount} labels, ${containerCount} containers, ${nomCount} products.`);
        }
        catch (e) { }
        const stats = {
            barcodes: barcodeCount,
            labels: labelCount,
            containers: containerCount,
            products: nomCount
        };
        // Notify all windows that data has changed
        electron_1.BrowserWindow.getAllWindows().forEach(win => {
            win.webContents.send('data-updated');
            win.webContents.send('sync-complete', {
                success: true,
                stats: stats,
                // Send raw data for debugging (trimming large lists to avoid IPC overload)
                rawData: {
                    ...data,
                    nomenclatures: nomenclatures.slice(0, 10),
                    label_templates: labels.length // Just send count to avoid huge images in IPC
                }
            });
        });
    });
    syncTx();
    try {
        console.log('Sync Client: Transaction committed successfully.');
    }
    catch (e) { }
    return true;
}
async function syncDataFromServer(serverIp) {
    if (!serverIp)
        throw new Error('Server IP not provided');
    const db = (0, database_1.initDatabase)();
    const baseUrl = `http://${serverIp}:8000/api/v1`;
    try {
        console.log(`Sync Client: Requesting data from ${baseUrl}...`);
    }
    catch (e) { }
    try {
        // Fetch all data in parallel
        const [nomRes, packsRes, labelsRes, barcodesRes, stationsRes] = await Promise.all([
            axios_1.default.get(`${baseUrl}/nomenclature/`, { timeout: 10000 }),
            axios_1.default.get(`${baseUrl}/packs/`, { timeout: 10000 }),
            axios_1.default.get(`${baseUrl}/labels/`, { timeout: 10000 }),
            axios_1.default.get(`${baseUrl}/barcodes/`, { timeout: 10000 }),
            axios_1.default.get(`${baseUrl}/stations/`, { timeout: 5000 }).catch(err => {
                try {
                    console.warn('Sync Client: Failed to fetch stations, skipping station number update.', err.message);
                }
                catch (e) { }
                return { data: [] };
            })
        ]);
        try {
            console.log(`Sync Client: Fetched ${nomRes.data.length} products, ${packsRes.data.length} packs, ${labelsRes.data.length} labels, ${barcodesRes.data.length} barcodes.`);
        }
        catch (e) { }
        // Resolve Station Number via UUID
        let stationNumber;
        try {
            const uuidRow = db.prepare('SELECT uuid_client FROM uuid LIMIT 1').get();
            if (uuidRow && Array.isArray(stationsRes.data)) {
                try {
                    console.log('Sync Client: Local UUID:', uuidRow.uuid_client);
                }
                catch (e) { }
                const myStation = stationsRes.data.find((s) => s.station_uuid === uuidRow.uuid_client);
                if (myStation) {
                    stationNumber = myStation.station_number;
                    try {
                        console.log('Sync Client: Matched station number:', stationNumber);
                    }
                    catch (e) { }
                }
                else {
                    try {
                        console.log('Sync Client: Station not found in server list by UUID.');
                    }
                    catch (e) { }
                }
            }
        }
        catch (e) {
            try {
                console.warn('Sync Client: Error resolving station number:', e);
            }
            catch (err) { }
        }
        const syncData = {
            nomenclatures: nomRes.data,
            containers: packsRes.data, // Map packs to containers
            labels: labelsRes.data,
            barcodes: barcodesRes.data,
            station_number: stationNumber
        };
        return importDataToDB(syncData);
    }
    catch (err) {
        if (err.response) {
            try {
                console.error(`Sync Client Server Error: ${err.response.status} at ${err.config?.url}`);
            }
            catch (e) { }
            try {
                const debugPath = path_1.default.join(electron_2.app.getPath('userData'), 'sync_error_response.html');
                fs_1.default.writeFileSync(debugPath, typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data, null, 2));
                try {
                    console.log(`Sync Client: Saved error response to ${debugPath}`);
                }
                catch (e) { }
            }
            catch (e) { /* ignore */ }
        }
        else if (err.request) {
            try {
                console.error('Sync Client Network Error (No response received)');
            }
            catch (e) { }
        }
        else {
            try {
                console.error('Sync Client Error:', err.message);
            }
            catch (e) { }
        }
        throw err;
    }
}
