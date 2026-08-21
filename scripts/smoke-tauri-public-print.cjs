'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const exeArgument = process.argv[2];
if (!exeArgument) {
    console.error('Usage: node smoke-tauri-public-print.cjs EXE');
    process.exit(2);
}
const exe = path.resolve(exeArgument);
assert.ok(fs.existsSync(exe), 'Release EXE is missing');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/printer-native-golden.json'), 'utf8'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labelpilot-public-print-smoke-'));
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

async function waitForBytes(expectedLength) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
        const actual = Buffer.concat(received);
        if (actual.length >= expectedLength) return actual;
        await delay(50);
    }
    throw new Error(`Public print receive timeout: ${Buffer.concat(received).length}/${expectedLength} bytes`);
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
    const nativeCase = fixture.cases[0];
    const nativeExpected = Buffer.from(nativeCase.expectedBase64, 'base64');
    const baseConfig = {
        active: true,
        name: 'Public route smoke',
        connection: 'tcp',
        ip: '127.0.0.1',
        port: printerPort,
        dpi: 203,
        persistentConnection: true,
    };
    const zplFallback = {
        printerConfig: {
            ...baseConfig,
            id: 'public-zpl-fallback',
            protocol: 'zpl',
            compatibilityMode: 'compatible',
            darkness: 18,
            printSpeed: 5,
        },
        labelDoc: {
            widthMm: 50,
            heightMm: 30,
            canvas: { width: 400, height: 240 },
            elements: [
                { id: 'title', type: 'text', x: 10, y: 8, w: 380, h: 35, fontSize: 22, fontWeight: 'bold', textAlign: 'center', text: 'Партия {{ batch }}' },
                { id: 'table', type: 'table', x: 10, y: 55, w: 380, h: 170, fontSize: 13, columns: [
                    { key: 'name', title: 'Товар', widthRatio: 65 },
                    { key: 'qty', title: 'Кол-во', widthRatio: 35 },
                ] },
            ],
        },
        data: { batch: 'Б-17', items: [{ name: 'Продукт А', qty: 12 }, { name: 'Продукт Б', qty: 8 }] },
        silent: true,
    };
    const tsplFallback = {
        printerConfig: {
            ...baseConfig,
            id: 'public-tspl-fallback',
            protocol: 'tspl',
            compatibilityMode: 'compatible',
            darkness: 20,
            printSpeed: 6,
            gapMm: 2,
        },
        labelDoc: {
            widthMm: 50,
            heightMm: 30,
            canvas: { width: 400, height: 240 },
            elements: [
                { id: 'bold', type: 'text', x: 10, y: 15, w: 380, h: 55, fontSize: 28, fontWeight: 'bold', textAlign: 'center', text: 'Смена {{ shift }}' },
                { id: 'frame', type: 'rect', x: 10, y: 85, w: 380, h: 130, borderWidth: 3, borderRadius: 12 },
                { id: 'caption', type: 'text', x: 25, y: 120, w: 350, h: 60, fontSize: 22, textAlign: 'center', text: 'TSPL bitmap' },
            ],
        },
        data: { shift: '2' },
        silent: true,
    };

    const rasterFallbacks = ['epl', 'cpcl', 'dpl', 'sbpl'].map(protocol => ({
        ...zplFallback,
        printerConfig: {
            ...zplFallback.printerConfig,
            id: `public-${protocol}-fallback`,
            protocol,
        },
    }));

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
        for (let attempt = 0; attempt < 30 && !bridgeReady; attempt += 1) {
            bridgeReady = await cdp.evaluate(`
                if (document.readyState !== 'complete' || !window.desktopBridge?.invoke) return false;
                await new Promise(resolve => setTimeout(resolve, 100));
                return !!window.desktopBridge?.invoke;
            `);
            if (!bridgeReady) await delay(200);
        }
        assert.equal(bridgeReady, true, 'Public desktop bridge is unavailable');

        const uiState = await cdp.evaluate(`
            const root = document.querySelector('#root');
            const bodyText = document.body?.innerText || '';
            return {
                runtime: window.desktopBridge?.runtime,
                rootChildren: root?.childElementCount || 0,
                bodyText,
                hasMainNavigation: !!document.querySelector('nav'),
            };
        `);
        assert.equal(uiState.runtime, 'tauri');
        assert.ok(uiState.rootChildren > 0, 'Full React root is empty');
        assert.match(uiState.bodyText, /LabelPilot/i);
        assert.doesNotMatch(uiState.bodyText, /Rust migration runtime/i);

        const fullUiContract = await cdp.evaluate(`
            const invoke = window.desktopBridge.invoke.bind(window.desktopBridge);
            return {
                station: await invoke('get-station-info'),
                products: await invoke('get-products', ''),
                fixedProducts: await invoke('get-fixed-weight-products', ''),
                containers: await invoke('get-containers'),
                labels: await invoke('get-all-labels'),
                printJobs: await invoke('get-print-jobs'),
                printers: await invoke('get-printers'),
                demo: await invoke('demo:status'),
                summary: await window.__TAURI_INTERNALS__.invoke('desktop_contract_summary'),
            };
        `);
        assert.deepEqual(fullUiContract.station, { uuid_client: null, station_number: null });
        for (const key of ['products', 'fixedProducts', 'containers', 'labels', 'printJobs', 'printers']) {
            assert.ok(Array.isArray(fullUiContract[key]), key + ' must be an array');
        }
        assert.equal(fullUiContract.demo.isDemo, false);
        assert.ok(fullUiContract.summary.migratedCommands.includes('record-and-print'));
        assert.ok(fullUiContract.summary.migratedCommands.includes('get-products'));

        const nativeOptions = {
            printerConfig: {
                ...nativeCase.config,
                id: 'public-native',
                ip: '127.0.0.1',
                port: printerPort,
                persistentConnection: true,
            },
            labelDoc: nativeCase.doc,
            data: nativeCase.data,
            silent: true,
        };
        const results = [];
        for (const options of [nativeOptions, zplFallback, tsplFallback, ...rasterFallbacks]) {
            results.push(await cdp.evaluate(`
                return await window.desktopBridge.invoke('print-label', ${JSON.stringify(options)});
            `));
        }
        assert.deepEqual(results, Array(7).fill(true));

        const generatorSummary = await cdp.evaluate(`
            return await window.__TAURI_INTERNALS__.invoke('desktop_printer_generator_summary');
        `);
        const transportSummary = await cdp.evaluate(`
            return await window.__TAURI_INTERNALS__.invoke('desktop_printer_transport_summary');
        `);
        const actual = await waitForBytes(transportSummary.bytesSent);

        assert.equal(actual.length, transportSummary.bytesSent);
        assert.deepEqual(actual.subarray(0, nativeExpected.length), nativeExpected);
        const fallback = actual.subarray(nativeExpected.length);
        const zplGraphicOffset = fallback.indexOf(Buffer.from('^GFA,', 'ascii'));
        const tsplBitmapOffset = fallback.indexOf(Buffer.from('BITMAP 0,0,', 'ascii'));
        assert.ok(zplGraphicOffset >= 0, 'ZPL bitmap fallback stream is missing');
        assert.ok(tsplBitmapOffset > zplGraphicOffset, 'TSPL bitmap fallback stream is missing or out of order');
        const eplOffset = fallback.indexOf(Buffer.from('GW0,0,', 'ascii'), tsplBitmapOffset + 1);
        const cpclOffset = fallback.indexOf(Buffer.from('\r\nEG ', 'ascii'), eplOffset + 1);
        const dplOffset = fallback.indexOf(Buffer.from([0x02, 0x78, 0x44, 0x4c, 0x50]), cpclOffset + 1);
        const sbplOffset = fallback.indexOf(Buffer.from([0x1b, 0x47, 0x48]), dplOffset + 1);
        assert.ok(eplOffset > tsplBitmapOffset, 'EPL GW raster stream is missing or out of order');
        assert.ok(cpclOffset > eplOffset, 'CPCL EG raster stream is missing or out of order');
        assert.ok(dplOffset > cpclOffset, 'DPL BMP stream is missing or out of order');
        assert.ok(sbplOffset > dplOffset, 'SBPL GH raster stream is missing or out of order');

        assert.equal(generatorSummary.generatedJobs, 1);
        assert.equal(generatorSummary.fallbackJobs, 6);
        assert.equal(generatorSummary.failedJobs, 0);
        assert.equal(generatorSummary.bytesGenerated, nativeExpected.length);
        assert.ok(generatorSummary.fallbackBytesGenerated > 0);
        assert.equal(transportSummary.completedJobs, 7);
        assert.equal(transportSummary.failedJobs, 0);
        assert.equal(transportSummary.tcpJobs, 7);
        assert.equal(transportSummary.serialJobs, 0);
        assert.equal(transportSummary.spoolerJobs, 0);
        assert.equal(transportSummary.driverBitmapJobs, 0);
        assert.deepEqual(transportSummary.supportedConnections, ['tcp', 'serial', 'windows_driver']);
        assert.equal(connectionCount, 1, 'All public jobs must reuse one physical TCP connection');

        const settingsTestConfig = {
            ...baseConfig,
            id: 'settings-test-zpl',
            protocol: 'zpl',
            compatibilityMode: 'extended',
        };
        const capabilityReport = await cdp.evaluate(`
            return await window.desktopBridge.invoke(
                'detect-printer-capabilities',
                ${JSON.stringify(settingsTestConfig)}
            );
        `);
        assert.equal(capabilityReport.detected, true);
        assert.equal(capabilityReport.protocol, 'zpl');
        assert.equal(capabilityReport.status, 'ready');

        const testPrintResult = await cdp.evaluate(`
            return await window.desktopBridge.invoke('test-print', ${JSON.stringify(settingsTestConfig)});
        `);
        assert.equal(testPrintResult.success, true);
        const afterTestSummary = await cdp.evaluate(`
            return await window.__TAURI_INTERNALS__.invoke('desktop_printer_transport_summary');
        `);
        const afterTestBytes = await waitForBytes(afterTestSummary.bytesSent);
        assert.equal(afterTestBytes.length, afterTestSummary.bytesSent + 5);
        assert.equal(afterTestSummary.completedJobs, 8);
        assert.equal(afterTestSummary.failedJobs, 0);
        assert.equal(connectionCount, 2, 'One print connection plus one explicit status probe');

        await cdp.evaluate(`
            await window.__TAURI_INTERNALS__.invoke('desktop_printer_disconnect_all');
            return true;
        `);
        console.log(`Release full UI smoke: root=${uiState.rootChildren} catalog=${fullUiContract.products.length} printers=${fullUiContract.printers.length}`);
        console.log(`Release public print smoke: native=1 fallback=6 bytes=${actual.length}`);
        console.log(`Release public routing offsets: ZPL=${zplGraphicOffset} TSPL=${tsplBitmapOffset} EPL=${eplOffset} CPCL=${cpclOffset} DPL=${dplOffset} SBPL=${sbplOffset}`);
        console.log(`Release public routing connection reuse: tcp-connect=${connectionCount}`);
        console.log(`Release settings test print: success=${testPrintResult.success} protocol=${capabilityReport.protocol} totalBytes=${afterTestSummary.bytesSent}`);
        console.log(`Release public fallback bytes: ${generatorSummary.fallbackBytesGenerated}`);
        console.log(`Release public print data: ${dataDir}`);
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
