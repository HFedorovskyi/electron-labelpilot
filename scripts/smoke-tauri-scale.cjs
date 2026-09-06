'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const exeArgument = process.argv[2];
if (!exeArgument) {
    console.error('Usage: node smoke-tauri-scale.cjs EXE');
    process.exit(2);
}
const exe = path.resolve(exeArgument);
assert.ok(fs.existsSync(exe), 'Release EXE is missing');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labelpilot-scale-smoke-'));
const logFile = path.join(process.env.LOCALAPPDATA, 'com.labelpilot.tauri', 'logs', 'labelpilot-tauri.log');
let connectionCount = 0;
let pollCount = 0;
let child;

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function readCurrentRunLog() {
    if (!fs.existsSync(logFile)) return '';
    const log = fs.readFileSync(logFile, 'utf8');
    const marker = `legacy-compatible data directory: ${dataDir}`;
    const index = log.lastIndexOf(marker);
    return index < 0 ? '' : log.slice(index);
}

async function waitForScaleCycle() {
    for (let attempt = 0; attempt < 120; attempt += 1) {
        const runLog = readCurrentRunLog();
        if (connectionCount >= 2 && pollCount >= 2 &&
            runLog.includes('scale first valid frame: protocol=and_standard') &&
            runLog.includes('TCP scale closed the connection')) {
            return runLog;
        }
        if (child?.exitCode !== null) {
            throw new Error(`Release EXE exited early with code ${child.exitCode}`);
        }
        await delay(250);
    }
    throw new Error(`Scale smoke timeout: connections=${connectionCount} polls=${pollCount}\n${readCurrentRunLog()}`);
}

async function main() {
    const sockets = new Set();
    const server = net.createServer(socket => {
        connectionCount += 1;
        sockets.add(socket);
        let input = Buffer.alloc(0);
        socket.on('data', chunk => {
            input = Buffer.concat([input, chunk]);
            const pollAt = input.indexOf(Buffer.from('Q\r\n'));
            if (pollAt < 0) return;
            pollCount += 1;
            input = input.subarray(pollAt + 3);
            socket.write(Buffer.from('ST,+001'));
            setTimeout(() => {
                if (!socket.destroyed) socket.end(Buffer.from('23.45 g\r\n'));
            }, 20);
        });
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.equal(typeof address, 'object');
    const config = {
        type: 'tcp',
        protocolId: 'and_standard',
        host: '127.0.0.1',
        port: address.port,
        pollingInterval: 50,
        stabilityCount: 4,
    };
    fs.writeFileSync(path.join(dataDir, 'scale-config.json'), JSON.stringify(config, null, 2));

    child = childProcess.spawn(exe, [], {
        env: { ...process.env, LABELPILOT_DATA_DIR: dataDir },
        stdio: 'ignore',
        windowsHide: true,
    });
    try {
        await waitForScaleCycle();
        console.log(`Release scale smoke: tcp-connect=${connectionCount} poll=${pollCount} fragmented-frame=parsed reconnect=passed`);
        console.log(`Release scale smoke data: ${dataDir}`);
    } finally {
        child.kill();
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
        await delay(500);
        if (!child.killed) {
            childProcess.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
                stdio: 'ignore',
                windowsHide: true,
            });
        }
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});