const axios = require('axios');

const IP = '192.168.178.34';
const PORT = 8000;
const BASE_URL = `http://${IP}:${PORT}`;

const PATHS = [
    '/api/full_sync',
    '/api/sync_db',
    '/api/sync',
    '/api/data',
    '/api/dump',
    '/api/v1/sync',
    '/api/products',
    '/api/export'
];

async function probe() {
    console.log(`Probing ${BASE_URL}...`);

    for (const path of PATHS) {
        const url = `${BASE_URL}${path}`;
        try {
            console.log(`Checking ${url}...`);
            const response = await axios.get(url, { timeout: 2000 });
            console.log(`[SUCCESS] ${url} returned ${response.status}`);
            console.log('Keys:', Object.keys(response.data));
            return; // Found it!
        } catch (err) {
            if (err.response) {
                console.log(`[FAILED] ${url} returned ${err.response.status}`);
            } else {
                console.log(`[ERROR] ${url} - ${err.message}`);
            }
        }
    }
    console.log('Probe finished. No valid endpoints found.');
}

probe();
