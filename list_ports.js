const { SerialPort } = require('serialport');

async function list() {
    console.log('--- Serial Ports Discovery ---');
    try {
        const ports = await SerialPort.list();
        if (ports.length === 0) {
            console.log('No serial ports found.');
            return;
        }
        ports.forEach(p => {
            console.log(`Port: ${p.path}`);
            console.log(`  Manufacturer: ${p.manufacturer || 'N/A'}`);
            console.log(`  Description:  ${p.friendlyName || 'N/A'}`);
            console.log(`  PnP ID:       ${p.pnpId || 'N/A'}`);
            console.log(`  Location ID:  ${p.locationId || 'N/A'}`);
            console.log('---------------------------');
        });
    } catch (err) {
        console.error('Error listing ports:', err);
    }
}

list();
