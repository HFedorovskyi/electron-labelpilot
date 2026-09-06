'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const exeArgument = process.argv[2];
if (!exeArgument) {
    console.error('Usage: node smoke-tauri-printer.cjs EXE');
    process.exit(2);
}
const exe = path.resolve(exeArgument);
assert.ok(fs.existsSync(exe), 'Release EXE is missing');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labelpilot-printer-smoke-'));
const sockets = new Set();
const received = [];
let connectionCount = 0;
let child;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function listenEphemeral(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.equal(typeof address, 'object');
    return address.port;
}

async function freePort() {
    const server = net.createServer();
    const port = await listenEphemeral(server);
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function waitForDebugPage(port) {
    let lastError;
    for (let attempt = 0; attempt < 160; attempt += 1) {
        if (child?.exitCode !== null) throw new Error(`Release EXE exited early with code ${child.exitCode}`);
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/list`);
            const pages = await response.json();
            const page = pages.find(candidate => candidate.type === 'page' && candidate.webSocketDebuggerUrl);
            if (page) return page.webSocketDebuggerUrl;
        } catch (error) {
            lastError = error;
        }
        await delay(250);
    }
    throw new Error(`WebView2 debug page timeout: ${lastError?.message ?? 'no page'}`);
}

class CdpClient {
    constructor(url) {
        this.socket = new WebSocket(url);
        this.nextId = 1;
        this.pending = new Map();
    }

    async open() {
        await new Promise((resolve, reject) => {
            this.socket.addEventListener('open', resolve, { once: true });
            this.socket.addEventListener('error', reject, { once: true });
        });
        this.socket.addEventListener('message', event => {
            const message = JSON.parse(String(event.data));
            if (!message.id) return;
            const waiter = this.pending.get(message.id);
            if (!waiter) return;
            this.pending.delete(message.id);
            if (message.error) waiter.reject(new Error(message.error.message));
            else waiter.resolve(message.result);
        });
    }

    request(method, params = {}) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }

    async evaluate(expression) {
        const response = await this.request('Runtime.evaluate', {
            expression: `(async () => { ${expression} })()`,
            awaitPromise: true,
            returnByValue: true,
        });
        if (response.exceptionDetails) {
            const description = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text;
            throw new Error(`WebView expression failed: ${description}`);
        }
        if (response.result.subtype === 'error') throw new Error(response.result.description);
        return response.result.value;
    }

    close() {
        this.socket.close();
    }
}

async function waitForReceived(expected) {
    for (let attempt = 0; attempt < 80; attempt += 1) {
        const actual = Buffer.concat(received);
        if (actual.length >= expected.length) {
            assert.deepEqual(actual, expected);
            return;
        }
        await delay(50);
    }
    throw new Error(`Printer receive timeout: ${Buffer.concat(received).length}/${expected.length} bytes`);
}

async function main() {
    const server = net.createServer(socket => {
        connectionCount += 1;
        sockets.add(socket);
        socket.on('data', chunk => received.push(Buffer.from(chunk)));
        socket.on('close', () => sockets.delete(socket));
    });
    const printerPort = await listenEphemeral(server);
    const debugPort = await freePort();
    const first = Buffer.from('^XA^FO20,20^FDLP-RUST-ONE^FS^XZ', 'ascii');
    const second = Buffer.from('^XA^FO20,20^FDLP-RUST-TWO^FS^XZ', 'ascii');
    const config = id => ({
        id,
        active: true,
        name: `Smoke ${id}`,
        connection: 'tcp',
        protocol: 'zpl',
        ip: '127.0.0.1',
        port: printerPort,
        persistentConnection: true,
    });

    child = childProcess.spawn(exe, [], {
        env: {
            ...process.env,
            LABELPILOT_DATA_DIR: dataDir,
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
        },
        stdio: 'ignore',
        windowsHide: true,
    });

    let cdp;
    try {
        const debugUrl = await waitForDebugPage(debugPort);
        cdp = new CdpClient(debugUrl);
        await cdp.open();
        let bridgeReady = false;
        let bridgeError;
        for (let attempt = 0; attempt < 20 && !bridgeReady; attempt += 1) {
            try {
                bridgeReady = await cdp.evaluate(`
                    if (document.readyState !== 'complete' || !window.__TAURI_INTERNALS__?.invoke) return false;
                    await new Promise(resolve => setTimeout(resolve, 150));
                    return document.readyState === 'complete' && !!window.__TAURI_INTERNALS__?.invoke;
                `);
            } catch (error) {
                bridgeError = error;
            }
            if (!bridgeReady) await delay(250);
        }
        if (!bridgeReady) throw bridgeError ?? new Error('Tauri invoke bridge is unavailable');

        const invokeRaw = (printerConfig, bytes) => cdp.evaluate(`
            return await window.__TAURI_INTERNALS__.invoke('desktop_printer_send_raw', ${JSON.stringify({
                payload: { config: printerConfig, dataBase64: bytes.toString('base64') },
            })});
        `);
        const firstReceipt = await invokeRaw(config('pack-printer'), first);
        const secondReceipt = await invokeRaw(config('box-printer'), second);
        await waitForReceived(Buffer.concat([first, second]));
        const summary = await cdp.evaluate(`
            return await window.__TAURI_INTERNALS__.invoke('desktop_printer_transport_summary');
        `);

        assert.equal(firstReceipt.bytes, first.length);
        assert.equal(firstReceipt.attempts, 1);
        assert.equal(secondReceipt.bytes, second.length);
        assert.equal(secondReceipt.attempts, 1);
        assert.equal(secondReceipt.reusedConnection, true);
        assert.equal(firstReceipt.physicalKey, secondReceipt.physicalKey);
        assert.equal(connectionCount, 1, 'Persistent physical printer queue must reuse one socket');
        assert.equal(summary.workerCount, 1);
        assert.equal(summary.completedJobs, 2);
        assert.equal(summary.failedJobs, 0);
        assert.equal(summary.bytesSent, first.length + second.length);
        assert.equal(summary.queueCapacityPerPrinter, 16);
        assert.equal(summary.maxWorkers, 12);

        await cdp.evaluate(`
            await window.__TAURI_INTERNALS__.invoke('desktop_printer_disconnect_all');
            return true;
        `);
        console.log(`Release printer smoke: jobs=2 bytes=${summary.bytesSent} tcp-connect=${connectionCount} reused=${secondReceipt.reusedConnection}`);
        console.log(`Release printer smoke bounds: queue=${summary.queueCapacityPerPrinter} workers=${summary.maxWorkers} max-job=${summary.maxJobBytes}`);
        console.log(`Release printer smoke data: ${dataDir}`);
    } finally {
        cdp?.close();
        child?.kill();
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
        await delay(750);
        if (child && child.exitCode === null) {
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
