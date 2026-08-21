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
    console.error('Usage: node smoke-tauri-lazy-ui.cjs EXE [RESULT_JSON]');
    process.exit(2);
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labelpilot-lazy-ui-'));

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.equal(typeof address, 'object');
    await new Promise(resolve => server.close(resolve));
    return address.port;
}

async function assertIngressAvailable() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(5556, '0.0.0.0', resolve);
    });
    await new Promise(resolve => server.close(resolve));
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
            expression: '(async () => { ' + expression + ' })()',
            awaitPromise: true,
            returnByValue: true,
        });
        if (response.exceptionDetails) {
            const description = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
            throw new Error('WebView expression failed: ' + description);
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
        if (child.exitCode !== null) throw new Error('Runtime exited during startup: ' + child.exitCode);
        try {
            const response = await fetch('http://127.0.0.1:' + port + '/json/list');
            const pages = await response.json();
            const page = pages.find(candidate => candidate.type === 'page' && candidate.webSocketDebuggerUrl);
            if (page) return page.webSocketDebuggerUrl;
        } catch (error) {
            lastError = error;
        }
        await delay(250);
    }
    throw new Error('WebView2 debug page timeout: ' + (lastError ? lastError.message : 'no page'));
}

async function waitFor(client, expression, message) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await client.evaluate('return Boolean(' + expression + ');')) return;
        await delay(100);
    }
    throw new Error(message);
}

function loadedChunks(state) {
    return state.resources
        .map(value => value.split('/').pop())
        .filter(value => value && value.endsWith('.js'));
}

async function snapshot(client) {
    return client.evaluate(
        "return {" +
        "resources: performance.getEntriesByType('resource').map(entry => entry.name)," +
        "tabs: Array.from(document.querySelectorAll('[data-station-tab]')).map(node => ({id: node.getAttribute('data-station-tab'), display: getComputedStyle(node).display}))," +
        "viewport: {width: innerWidth, height: innerHeight, dpr: devicePixelRatio}," +
        "domNodes: document.getElementsByTagName('*').length" +
        "};"
    );
}

async function stop(child, client) {
    client?.close();
    child?.kill();
    for (let attempt = 0; attempt < 30 && child && child.exitCode === null; attempt += 1) await delay(100);
    if (child && child.exitCode === null) {
        childProcess.spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
        });
    }
}

async function main() {
    await assertIngressAvailable();
    const debugPort = await freePort();
    const child = childProcess.spawn(exe, [], {
        env: Object.assign({}, process.env, {
            LABELPILOT_DATA_DIR: dataDir,
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + debugPort,
        }),
        stdio: 'ignore',
        windowsHide: true,
    });
    let client;
    try {
        client = new CdpClient(await waitForDebugPage(child, debugPort));
        await client.open();
        await waitFor(client, "document.readyState === 'complete' && document.querySelector('[data-tab-id=\"weighing\"]')", 'Default station did not render');
        await waitFor(client, "performance.getEntriesByType('resource').some(entry => entry.name.includes('WeighingStation-'))", 'Weighing chunk did not load');
        const initial = await snapshot(client);
        const initialChunks = loadedChunks(initial);
        assert.ok(initialChunks.some(name => name.startsWith('WeighingStation-')));
        assert.ok(!initialChunks.some(name => name.startsWith('FixedWeightStation-')));
        assert.ok(!initialChunks.some(name => name.startsWith('PrintJobStation-')));
        assert.ok(!initialChunks.some(name => name.startsWith('bwip-js-')));
        for (const prefix of ['NumericKeypad-', 'DatePickerModal-', 'ProductSelectionModal-', 'DeleteItemsModal-']) {
            assert.ok(!initialChunks.some(name => name.startsWith(prefix)), prefix + ' loaded while closed');
        }
        assert.deepEqual(initial.tabs.map(tab => tab.id), ['weighing']);

        await client.evaluate("document.querySelector('[data-tab-id=\"fixedWeight\"]').click(); return true;");
        await waitFor(client, "document.querySelector('[data-station-tab=\"fixedWeight\"]') && getComputedStyle(document.querySelector('[data-station-tab=\"fixedWeight\"]')).display !== 'none'", 'Fixed-weight station did not mount');
        const afterFixed = await snapshot(client);
        assert.ok(loadedChunks(afterFixed).some(name => name.startsWith('FixedWeightStation-')));

        await client.evaluate("document.querySelector('[data-tab-id=\"printJob\"]').click(); return true;");
        await waitFor(client, "document.querySelector('[data-station-tab=\"printJob\"]') && getComputedStyle(document.querySelector('[data-station-tab=\"printJob\"]')).display !== 'none'", 'Print-job station did not mount');
        await client.evaluate("document.querySelector('[data-tab-id=\"weighing\"]').click(); return true;");
        await waitFor(client, "getComputedStyle(document.querySelector('[data-station-tab=\"weighing\"]')).display !== 'none'", 'Weighing station did not reactivate');
        const final = await snapshot(client);
        assert.deepEqual(final.tabs.map(tab => tab.id).sort(), ['fixedWeight', 'printJob', 'weighing']);
        assert.equal(final.tabs.find(tab => tab.id === 'weighing').display, 'block');
        assert.equal(final.tabs.find(tab => tab.id === 'fixedWeight').display, 'none');
        assert.equal(final.tabs.find(tab => tab.id === 'printJob').display, 'none');

        await client.request('HeapProfiler.collectGarbage');
        const heap = await client.request('Runtime.getHeapUsage');
        const result = {
            kind: 'labelpilot-lazy-ui-smoke',
            executable: exe,
            dataDirectory: dataDir,
            initial,
            afterFixed,
            final,
            initialChunks,
            finalChunks: loadedChunks(final),
            heap,
            success: true,
        };
        if (resultPath) {
            fs.mkdirSync(path.dirname(resultPath), { recursive: true });
            fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
        }
        console.log(JSON.stringify({
            initialChunks: result.initialChunks,
            finalStationTabs: result.final.tabs,
            heap: result.heap,
            success: result.success,
        }, null, 2));
    } finally {
        await stop(child, client);
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
