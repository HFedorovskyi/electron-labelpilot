'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const exe = path.resolve(process.argv[2] || '');
const resultPath = process.argv[3] ? path.resolve(process.argv[3]) : null;
if (!process.argv[2] || !fs.existsSync(exe)) {
    console.error('Usage: node smoke-tauri-durable-printer.cjs EXE [RESULT_JSON]');
    process.exit(2);
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labelpilot-durable-smoke-'));
const sockets = new Set();
const received = [];
let connectionCount = 0;

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
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            if (message.error) pending.reject(new Error(message.error.message));
            else pending.resolve(message.result);
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
        return response.result.value;
    }

    close() {
        this.socket.close();
    }
}

async function waitForDebugPage(child, port) {
    let lastError;
    for (let attempt = 0; attempt < 160; attempt += 1) {
        if (child.exitCode !== null) throw new Error(`Release EXE exited early with code ${child.exitCode}`);
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

async function launch() {
    const debugPort = await freePort();
    const child = childProcess.spawn(exe, [], {
        env: {
            ...process.env,
            LABELPILOT_DATA_DIR: dataDir,
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
        },
        stdio: 'ignore',
        windowsHide: true,
    });
    const client = new CdpClient(await waitForDebugPage(child, debugPort));
    await client.open();
    for (let attempt = 0; attempt < 40; attempt += 1) {
        const ready = await client.evaluate(`
            if (document.readyState !== 'complete' || !window.__TAURI_INTERNALS__?.invoke) return false;
            await new Promise(resolve => setTimeout(resolve, 100));
            return true;
        `);
        if (ready) return { child, client };
        await delay(200);
    }
    throw new Error('Tauri invoke bridge is unavailable');
}

async function stop(runtime) {
    runtime.client.close();
    runtime.child.kill();
    for (let attempt = 0; attempt < 30 && runtime.child.exitCode === null; attempt += 1) await delay(100);
    if (runtime.child.exitCode === null) {
        childProcess.spawnSync('taskkill', ['/PID', String(runtime.child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
        });
        await delay(500);
    }
}

async function waitForBytes(length) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const bytes = Buffer.concat(received);
        if (bytes.length >= length) return bytes;
        await delay(50);
    }
    throw new Error(`TCP receive timeout: ${Buffer.concat(received).length}/${length}`);
}

async function invokeRaw(client, config, bytes) {
    return client.evaluate(`
        return await window.__TAURI_INTERNALS__.invoke('desktop_printer_send_raw', ${JSON.stringify({
            payload: { config, dataBase64: bytes.toString('base64') },
        })});
    `);
}

async function main() {
    const server = net.createServer(socket => {
        connectionCount += 1;
        sockets.add(socket);
        socket.on('data', chunk => received.push(Buffer.from(chunk)));
        socket.on('error', error => {
            if (error.code !== 'ECONNRESET') throw error;
        });
        socket.on('close', () => sockets.delete(socket));
    });
    const printerPort = await listenEphemeral(server);
    const bytes = Buffer.from('^XA^FO24,24^FDDURABLE-RESTART-SMOKE^FS^XZ', 'ascii');
    const config = {
        id: 'durable-smoke',
        active: true,
        name: 'Durable restart smoke',
        connection: 'tcp',
        protocol: 'zpl',
        ip: '127.0.0.1',
        port: printerPort,
        persistentConnection: false,
        jobIdempotencyKey: 'durable-restart-smoke-key',
    };

    let firstRuntime;
    let secondRuntime;
    try {
        firstRuntime = await launch();
        const firstReceipt = await invokeRaw(firstRuntime.client, config, bytes);
        const firstBytes = await waitForBytes(bytes.length);
        assert.deepEqual(firstBytes, bytes);
        assert.equal(firstReceipt.deduplicated, false);
        assert.equal(firstReceipt.durableState, 'accepted');
        assert.match(firstReceipt.durableJobId, /^[0-9a-f-]{36}$/i);
        const firstSummary = await firstRuntime.client.evaluate(`
            return await window.__TAURI_INTERNALS__.invoke('desktop_printer_durable_summary');
        `);
        assert.equal(firstSummary.accepted, 1);
        assert.equal(firstSummary.total, 1);
        await stop(firstRuntime);
        firstRuntime = null;

        const bytesBeforeDuplicate = Buffer.concat(received).length;
        const connectionsBeforeDuplicate = connectionCount;
        secondRuntime = await launch();
        const changed = Buffer.from('^XA^FDCHANGED^FS^XZ', 'ascii');
        const conflict = await secondRuntime.client.evaluate(`
            try {
                await window.__TAURI_INTERNALS__.invoke('desktop_printer_send_raw', ${JSON.stringify({
                    payload: { config, dataBase64: changed.toString('base64') },
                })});
                return '';
            } catch (error) {
                return String(error);
            }
        `);
        assert.match(conflict, /DURABLE_IDEMPOTENCY_CONFLICT/);
        const secondReceipt = await invokeRaw(secondRuntime.client, config, bytes);
        await delay(600);
        assert.equal(secondReceipt.deduplicated, true);
        assert.equal(secondReceipt.durableJobId, firstReceipt.durableJobId);
        assert.equal(secondReceipt.durableState, 'accepted');
        assert.equal(Buffer.concat(received).length, bytesBeforeDuplicate, 'Restart duplicate reached TCP printer');
        assert.equal(connectionCount, connectionsBeforeDuplicate, 'Restart duplicate opened a TCP connection');

        const state = await secondRuntime.client.evaluate(`
            const invoke = window.__TAURI_INTERNALS__.invoke;
            return {
                summary: await invoke('desktop_printer_durable_summary'),
                jobs: await invoke('desktop_printer_durable_jobs', { payload: { limit: 10 } }),
            };
        `);
        assert.equal(state.summary.accepted, 1);
        assert.equal(state.summary.total, 1);
        assert.equal(state.jobs.length, 1);
        assert.equal(state.jobs[0].state, 'accepted');
        assert.equal(state.jobs[0].attemptCount, 1);

        const result = {
            exe,
            dataDir,
            durableJobId: firstReceipt.durableJobId,
            firstBytes: bytes.length,
            tcpConnections: connectionCount,
            accepted: state.summary.accepted,
            total: state.summary.total,
            duplicateSuppressedAfterRestart: true,
            idempotencyConflictRejected: true,
        };
        if (resultPath) fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
        console.log(`Durable restart smoke: job=${result.durableJobId} bytes=${result.firstBytes} connects=${result.tcpConnections}`);
        console.log('Durable restart behavior: accepted duplicate suppressed, changed payload rejected');
        console.log(`Durable restart data: ${dataDir}`);
    } finally {
        if (firstRuntime) await stop(firstRuntime);
        if (secondRuntime) await stop(secondRuntime);
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
