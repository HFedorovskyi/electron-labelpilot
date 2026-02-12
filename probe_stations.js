const axios = require('axios');

const URL = 'http://192.168.178.34:8000/api/v1/stations/';

async function probe() {
    console.log(`GET ${URL}...`);
    try {
        const response = await axios.get(URL, { timeout: 3000 });
        console.log(`[SUCCESS] Status: ${response.status}`);
        if (Array.isArray(response.data)) {
            console.log(`Type: Array`);
            console.log(`Count: ${response.data.length}`);
            if (response.data.length > 0) {
                console.log('First item:', response.data[0]);
            }
        } else {
            console.log('Data:', response.data);
        }
    } catch (err) {
        console.log(`[ERROR] ${err.message}`);
    }
}

probe();
