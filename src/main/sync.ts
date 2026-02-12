import axios from 'axios';

export interface SyncData {
    barcodes?: any[];
    barcode_templates?: any[];
    labels?: any[];
    label_templates?: any[];
    containers?: any[];
    packs?: any[];
    nomenclature?: any[];
    nomenclatures?: any[];
    station_number?: number;
}

// Remove database import logic for now as user requested only connection test
// export function importDataToDB(data: SyncData) { ... }

// importDataToDB logic removed as per user request to only test connection

export async function testConnection(serverIp: string): Promise<boolean> {
    if (!serverIp) throw new Error('Server IP not provided');

    const baseUrl = `http://${serverIp}:8000/api/v1`;
    try { console.log(`Connection Test: Probing ${baseUrl}...`); } catch (e) { }

    try {
        // Just ping one endpoint to verify connection
        await axios.get(`${baseUrl}/stations/`, { timeout: 5000 });
        try { console.log('Connection Test: Success!'); } catch (e) { }
        return true;
    } catch (err: any) {
        if (err.response) {
            try { console.error(`Connection Test Server Error: ${err.response.status}`); } catch (e) { }
        } else {
            try { console.error('Connection Test Error:', err.message); } catch (e) { }
        }
        throw err;
    }
}
