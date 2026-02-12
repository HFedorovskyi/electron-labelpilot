const axios = require('axios');

const URL = 'http://192.168.178.34:8000/api/v1/nomenclature/';

async function probe() {
    console.log(`GET ${URL}...`);
    try {
        const response = await axios.get(URL, { timeout: 5000 });
        console.log(`[SUCCESS] Status: ${response.status}`);
        if (Array.isArray(response.data)) {
            console.log(`Type: Array`);
            console.log(`Count: ${response.data.length}`);
            if (response.data.length > 0) {
                console.log('First item keys:', Object.keys(response.data[0]));
            }
        } else if (response.data.results && Array.isArray(response.data.results)) {
            console.log(`Type: Paginated Object`);
            console.log(`Count: ${response.data.count}`);
            console.log(`Next: ${response.data.next}`);
            if (response.data.results.length > 0) {
                console.log('First item keys:', Object.keys(response.data.results[0]));
            }
        } else {
            console.log('Data:', response.data);
        }
    } catch (err) {
        console.log(`[ERROR] ${err.message}`);
    }
}

probe();
