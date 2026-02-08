import { BrowserWindow } from 'electron';
import axios from 'axios';
import { initDatabase } from './database';

export interface SyncData {
    barcodes: any[];
    labels: any[];
    containers: any[];
    nomenclature: any[];
    packs: any[];
}

export function importDataToDB(data: SyncData) {
    const db = initDatabase();
    if (!data || !data.nomenclature) {
        throw new Error('Invalid data received');
    }

    // Transactional Import
    const syncTx = db.transaction(() => {
        console.log('Sync Client: Starting transaction...');

        // 1. Clear existing data
        db.prepare('DELETE FROM pack').run();
        db.prepare('DELETE FROM nomenclature').run();
        db.prepare('DELETE FROM container').run();
        db.prepare('DELETE FROM labels').run();
        db.prepare('DELETE FROM barcodes').run();

        // 2. Insert new data (Dependency Order)

        // Barcodes
        const insertBarcode = db.prepare('INSERT INTO barcodes (id, name, structure) VALUES (@id, @name, @structure)');
        let barcodeCount = 0;
        for (const item of data.barcodes) {
            insertBarcode.run(item);
            barcodeCount++;
        }

        // Labels
        const insertLabel = db.prepare('INSERT INTO labels (id, name, structure, created_at, updated_at) VALUES (@id, @name, @structure, @created_at, @updated_at)');
        let labelCount = 0;
        for (const item of data.labels) {
            insertLabel.run(item);
            labelCount++;
        }

        // Containers
        const insertContainer = db.prepare('INSERT INTO container (id, name, weight) VALUES (@id, @name, @weight)');
        let containerCount = 0;
        for (const item of data.containers) {
            insertContainer.run(item);
            containerCount++;
        }

        // Nomenclature
        const insertNom = db.prepare(`
            INSERT INTO nomenclature (
                id, name, article, exp_date, 
                portion_container_id, box_container_id, 
                templates_pack_label, templates_box_label, 
                close_box_counter
            ) VALUES (
                @id, @name, @article, @exp_date, 
                @portion_container, @box_container, 
                @templates_pack_label, @templates_box_label, 
                @close_box_counter
            )
        `);
        let nomCount = 0;
        for (const item of data.nomenclature) {
            try {
                insertNom.run(item);
                nomCount++;
            } catch (err: any) {
                console.error(`Sync Client: Failed to insert nomenclature "${item.name}" (ID: ${item.id}):`, err.message);
                console.log('Problematic item:', JSON.stringify(item, null, 2));
                throw err;
            }
        }

        console.log(`Sync Client: Imported ${barcodeCount} barcodes, ${labelCount} labels, ${containerCount} containers, ${nomCount} products.`);
    });

    syncTx();
    console.log('Sync Client: Transaction committed successfully.');

    // Notify all windows that data has changed
    BrowserWindow.getAllWindows().forEach(win => {
        win.webContents.send('data-updated');
    });

    return true;
}

export async function syncDataFromServer(serverIp: string): Promise<boolean> {
    if (!serverIp) throw new Error('Server IP not provided');
    initDatabase(); // Ensure DB is ready

    // Use default Django port 8000 for server if not specified differently
    const url = `http://${serverIp}:8000/api/full_sync`;
    console.log(`Sync Client: Requesting data from ${url}`);

    try {
        const response = await axios.get<SyncData>(url, { timeout: 5000 });
        return importDataToDB(response.data);

    } catch (err: any) {
        console.error('Sync Client Error:', err.message);
        throw err;
    }
}
