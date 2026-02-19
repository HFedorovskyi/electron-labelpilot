const fs = require('fs');
const path = require('path');
const os = require('os');

const logPath = path.join(os.homedir(), 'AppData', 'Roaming', 'electron-labelpilot', 'logs', 'main.log');
const logContent = fs.readFileSync(logPath, 'utf8');

const regex = /DEBUG: Full Labels Dump: (\[.*\])/;
const match = logContent.match(regex);

if (match) {
    try {
        const labels = JSON.parse(match[1]);
        fs.writeFileSync('labels_dump.json', JSON.stringify(labels, null, 2));
        console.log('Successfully extracted labels to labels_dump.json');
    } catch (e) {
        console.error('Failed to parse labels JSON', e);
        // If JSON is too big it might be truncated in logs
        console.log('Partial string length:', match[1].length);
        fs.writeFileSync('labels_dump_partial.txt', match[1]);
    }
} else {
    console.log('No labels dump found in logs');
}
