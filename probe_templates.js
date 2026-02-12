const axios = require('axios');

const BASE = 'http://192.168.178.34:8000/api/v1';

async function probe() {
    try {
        console.log(`GET ${BASE}/labels/...`);
        const labels = await axios.get(`${BASE}/labels/`, { timeout: 3000 });
        console.log(`[SUCCESS] Labels Count: ${labels.data.length}`);
        if (labels.data.length > 0) console.log('Label keys:', Object.keys(labels.data[0]));

        console.log(`GET ${BASE}/barcodes/...`);
        const barcodes = await axios.get(`${BASE}/barcodes/`, { timeout: 3000 });
        console.log(`[SUCCESS] Barcodes Count: ${barcodes.data.length}`);
        if (barcodes.data.length > 0) console.log('Barcode keys:', Object.keys(barcodes.data[0]));

    } catch (err) {
        console.log(`[ERROR] ${err.message}`);
    }
}

probe();
