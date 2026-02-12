const axios = require('axios');

const IP = '192.168.178.34';
const PORT = 8000;
const URLS = [
    `http://${IP}:${PORT}/api/v1/`,
];

async function probe() {
    console.log(`Probing root of ${IP}:${PORT}...`);

    for (const url of URLS) {
        try {
            console.log(`GET ${url}...`);
            const response = await axios.get(url, { timeout: 3000 });
            console.log(`[SUCCESS] ${url} - ${response.status}`);
            console.log('--- BODY START ---');
            console.log(response.data); // Print specific hints if possible
            console.log('--- BODY END ---');
        } catch (err) {
            if (err.response) {
                console.log(`[FAILED] ${url} - ${err.response.status}`);
                console.log('--- ERROR BODY START ---');
                console.log(err.response.data);
                console.log('--- ERROR BODY END ---');
            } else {
                console.log(`[ERROR] ${url} - ${err.message}`);
                // Try to ping?
            }
        }
    }
}

probe();
