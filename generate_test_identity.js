const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// Key provided by user (Hex)
const SECRET_KEY = Buffer.from('ed8c15735d90145e3caf48e1660c77d512c2e628e044a70526e3a2b4f3a39c11', 'hex');
const ALGORITHM = 'aes-256-cbc';

function encrypt(data) {
    const jsonStr = JSON.stringify(data);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, SECRET_KEY, iv);

    let encrypted = cipher.update(jsonStr, 'utf-8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);

    return Buffer.concat([iv, encrypted]);
}

const identityData = {
    station: {
        uuid: '94494230-69e3-4c15-88f0-67541061ab20',
        number: 1,
        name: 'Test Station 01',
        server_url: 'http://192.168.1.100:8000'
    },
    payload: {
        nomenclature: [
            { id: 1, name: 'Test Product 1', article: 'TP1', exp_date: 5 },
            { id: 2, name: 'Test Product 2', article: 'TP2', exp_date: 10 }
        ],
        containers: [
            { id: 1, name: 'Small Box', weight: 100 },
            { id: 2, name: 'Large Box', weight: 500 }
        ],
        barcodes: [],
        labels: []
    },
    meta: {
        type: 'OFFLINE_IDENTITY',
        version: '1.0',
        generated_at: new Date().toISOString()
    }
};

const encrypted = encrypt(identityData);
const outputPath = path.join(__dirname, 'test_identity.lpi');
fs.writeFileSync(outputPath, encrypted);

console.log(`Generated test identity file at: ${outputPath}`);
console.log('You can now use "Import Identity" in Settings to load this file.');
