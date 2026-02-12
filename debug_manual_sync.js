const axios = require('axios');
const fs = require('fs');
const path = require('path');

const IP = '192.168.1.100';
const PORT = 8000;
const URL = `http://${IP}:${PORT}/api/full_sync`;

async function debugSync() {
    console.log(`Requesting ${URL}...`);
    try {
        const response = await axios.get(URL, { timeout: 5000 });
        console.log(`[SUCCESS] Status: ${response.status}`);
        console.log('Data keys:', Object.keys(response.data));
    } catch (err) {
        if (err.response) {
            console.log(`[FAILED] Status: ${err.response.status}`);
            console.log('--- ERROR DATA START ---');
            console.log(typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data, null, 2));
            console.log('--- ERROR DATA END ---');

            // Save to local file for inspection
            fs.writeFileSync('manual_sync_error.html', typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data));
            console.log('Saved error to manual_sync_error.html');
        } else {
            console.log(`[ERROR] ${err.message}`);
        }
    }
}

debugSync();
