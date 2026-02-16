const { SerialPort } = require('serialport');

const PORT = 'COM1';
const CONFIGS = [
    { baudRate: 19200, parity: 'even', stopBits: 1 },
    { baudRate: 19200, parity: 'none', stopBits: 1 },
    { baudRate: 9600, parity: 'even', stopBits: 1 },
    { baudRate: 9600, parity: 'none', stopBits: 1 },
    { baudRate: 4800, parity: 'none', stopBits: 1 }
];

const COMMANDS = [
    { name: 'Protocol 2 (0xA0)', data: Buffer.from([0xF8, 0x55, 0xCE, 0x01, 0x00, 0xA0, 0x20, 0x78]) },
    { name: 'Protocol 2 (0x24)', data: Buffer.from([0xF8, 0x55, 0xCE, 0x01, 0x00, 0x24, 0x30, 0x64]) },
    { name: 'Protocol 2 (Addr 0, 0xA0)', data: Buffer.from([0xF8, 0x55, 0xCE, 0x00, 0x01, 0x00, 0xA0, 0x20, 0xC8]) },
    { name: 'Protocol 1 (W\\r\\n)', data: Buffer.from('W\r\n') },
    { name: 'Protocol 3 (0x05)', data: Buffer.from([0x05]) },
    { name: 'Protocol Text (P\\r\\n)', data: Buffer.from('P\r\n') }
];

async function runDiag() {
    console.log(`Starting Massa-K Diagnostics on ${PORT}...`);

    for (const config of CONFIGS) {
        console.log(`\n--- Testing Config: ${config.baudRate}, ${config.parity} ---`);

        const port = new SerialPort({
            path: PORT,
            baudRate: config.baudRate,
            parity: config.parity,
            stopBits: config.stopBits,
            autoOpen: false
        });

        await new Promise((resolve) => {
            port.open((err) => {
                if (err) {
                    console.error(`  Failed to open: ${err.message}`);
                    return resolve();
                }

                console.log(`  Port opened. Pulsing signals...`);
                port.set({ dtr: true, rts: true }, () => {
                    setTimeout(() => {
                        port.set({ dtr: false }, () => {
                            setTimeout(() => port.set({ dtr: true }), 50);
                        });
                    }, 100);
                });

                port.on('data', (data) => {
                    console.log(`  >>> RECEIVED RAW (HEX): ${data.toString('hex').toUpperCase()}`);
                    console.log(`  >>> RECEIVED RAW (STR): "${data.toString().trim()}"`);
                });

                let cmdIdx = 0;
                const interval = setInterval(() => {
                    if (cmdIdx >= COMMANDS.length) {
                        clearInterval(interval);
                        port.close(() => resolve());
                        return;
                    }

                    const cmd = COMMANDS[cmdIdx++];
                    console.log(`  Sending ${cmd.name}: ${cmd.data.toString('hex').toUpperCase()}`);
                    port.write(cmd.data);
                }, 1500);
            });
        });
    }

    console.log('\nDiagnostics finished.');
}

runDiag().catch(console.error);
