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
    console.error('Usage: node smoke-tauri-print-queue-ui.cjs EXE [RESULT_JSON]');
    process.exit(2);
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labelpilot-queue-ui-smoke-'));
let child;

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return server.address().port;
}

async function freePort() {
    const server = net.createServer();
    const port = await listen(server);
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

async function waitForPage(port) {
    let lastError;
    for (let attempt = 0; attempt < 160; attempt += 1) {
        if (child?.exitCode !== null) throw new Error(`Release EXE exited early with code ${child.exitCode}`);
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/list`);
            const pages = await response.json();
            const page = pages.find(value => value.type === 'page' && value.webSocketDebuggerUrl);
            if (page) return page.webSocketDebuggerUrl;
        } catch (error) {
            lastError = error;
        }
        await delay(250);
    }
    throw new Error(`WebView2 debug page timeout: ${lastError?.message ?? 'no page'}`);
}

async function stop() {
    if (!child || child.exitCode !== null) return;
    child.kill();
    for (let attempt = 0; attempt < 30 && child.exitCode === null; attempt += 1) await delay(100);
    if (child.exitCode === null) {
        childProcess.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
        });
    }
}

async function main() {
    const zplCommands = [];
    const tsplCommands = [];
    const zplServer = net.createServer(socket => socket.on('data', chunk => {
        zplCommands.push(Buffer.from(chunk));
        socket.write(Buffer.from(
            '\x02030,1,0,0250,000,0,0,0,000,0,0,0\x03\r\n' +
            '\x02001,0,1,0,0,2,0,0,00000000,1,000\x03\r\n' +
            '\x021234,0\x03\r\n',
            'latin1',
        ));
    }));
    const tsplServer = net.createServer(socket => socket.on('data', chunk => {
        tsplCommands.push(Buffer.from(chunk));
        socket.write(Buffer.from([0x04]));
    }));
    const zplPort = await listen(zplServer);
    const tsplPort = await listen(tsplServer);
    const debugPort = await freePort();
    const pack = {
        id: 'queue-zpl', active: true, name: 'ZPL status emulator', connection: 'tcp',
        protocol: 'zpl', ip: '127.0.0.1', port: zplPort, dpi: 203,
    };
    const box = {
        id: 'queue-tspl', active: true, name: 'TSPL status emulator', connection: 'tcp',
        protocol: 'tspl', ip: '127.0.0.1', port: tsplPort, dpi: 203,
    };

    child = childProcess.spawn(exe, [], {
        env: {
            ...process.env,
            LABELPILOT_DATA_DIR: dataDir,
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
        },
        stdio: 'ignore',
        windowsHide: true,
    });

    let client;
    try {
        client = new CdpClient(await waitForPage(debugPort));
        await client.open();
        await client.request('Emulation.setDeviceMetricsOverride', {
            width: 1366,
            height: 768,
            deviceScaleFactor: 1,
            mobile: false,
        });
        let ready = false;
        for (let attempt = 0; attempt < 50 && !ready; attempt += 1) {
            ready = await client.evaluate(`
                return document.readyState === 'complete' && !!window.__TAURI_INTERNALS__?.invoke && !!window.desktopBridge?.invoke;
            `);
            if (!ready) await delay(200);
        }
        assert.equal(ready, true, 'Tauri bridge/UI did not become ready');

        const direct = await client.evaluate(`
            const invoke = window.__TAURI_INTERNALS__.invoke;
            return {
                zpl: await invoke('desktop_printer_query_status', { payload: ${JSON.stringify(pack)} }),
                tspl: await invoke('desktop_printer_query_status', { payload: ${JSON.stringify(box)} }),
            };
        `);
        assert.equal(direct.zpl.status, 'head-open');
        assert.equal(direct.zpl.supportsBidirectionalStatus, true);
        assert.ok(direct.zpl.responseBytes > 0 && direct.zpl.responseBytes <= 4096);
        assert.equal(direct.tspl.status, 'paper-out');
        assert.equal(direct.tspl.rawResponseHex, '04');

        await client.evaluate(`
            await window.__TAURI_INTERNALS__.invoke('desktop_save_printer_config', { payload: {
                packPrinter: ${JSON.stringify(pack)},
                boxPrinter: ${JSON.stringify(box)},
                palletPrinter: { id: 'pallet-off', active: false, name: 'Pallet printer', connection: 'windows_driver', protocol: 'image' },
                autoPrintOnStable: true,
                serverIp: '',
                language: 'ru'
            }});
            const button = [...document.querySelectorAll('button')].find(value => value.textContent?.includes('Очередь печати'));
            if (!button) throw new Error('Print Queue sidebar button is missing');
            button.click();
            return true;
        `);

        let ui;
        for (let attempt = 0; attempt < 50; attempt += 1) {
            ui = await client.evaluate(`
                const root = document.querySelector('[data-testid="print-queue-monitor"]');
                if (!root) return null;
                const check = [...root.querySelectorAll('button')].find(value => value.textContent?.includes('Проверить принтеры'));
                const refresh = [...root.querySelectorAll('button')].find(value => value.textContent?.includes('Обновить'));
                return {
                    title: root.querySelector('h2')?.textContent?.trim(),
                    checkHeight: check?.getBoundingClientRect().height ?? 0,
                    refreshHeight: refresh?.getBoundingClientRect().height ?? 0,
                    viewport: [window.innerWidth, window.innerHeight],
                    horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
                };
            `);
            if (ui) break;
            await delay(200);
        }
        assert.ok(ui, 'Print Queue lazy screen did not render');
        assert.equal(ui.title, 'Очередь печати');
        assert.ok(ui.checkHeight >= 44 && ui.refreshHeight >= 44, 'Primary touch controls are below 44px');
        assert.deepEqual(ui.viewport, [1366, 768]);
        assert.ok(ui.horizontalOverflow <= 1, `Horizontal overflow at 1366x768: ${ui.horizontalOverflow}px`);

        await client.evaluate(`
            const root = document.querySelector('[data-testid="print-queue-monitor"]');
            const check = [...root.querySelectorAll('button')].find(value => value.textContent?.includes('Проверить принтеры'));
            check.click();
        `);
        let statuses = '';
        for (let attempt = 0; attempt < 50; attempt += 1) {
            statuses = await client.evaluate(`return document.querySelector('[data-testid="print-queue-monitor"]')?.textContent ?? '';`);
            if (statuses.includes('head-open') && statuses.includes('paper-out')) break;
            await delay(200);
        }
        assert.match(statuses, /head-open/);
        assert.match(statuses, /paper-out/);
        assert.ok(zplCommands.every(value => value.equals(Buffer.from('~HS\r\n', 'ascii'))));
        assert.ok(tsplCommands.every(value => value.equals(Buffer.from([0x1b, 0x21, 0x3f]))));

        const result = {
            exe,
            dataDir,
            viewport: ui.viewport,
            touchControlMinimumPx: Math.min(ui.checkHeight, ui.refreshHeight),
            horizontalOverflowPx: ui.horizontalOverflow,
            zplStatus: direct.zpl.status,
            tsplStatus: direct.tspl.status,
            zplQueries: zplCommands.length,
            tsplQueries: tsplCommands.length,
            queueUiRendered: true,
            manualStatusCardsUpdated: true,
        };
        if (resultPath) fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
        console.log(`Queue UI smoke: ${ui.viewport.join('x')}, touch>=${result.touchControlMinimumPx}px, overflow=${ui.horizontalOverflow}px`);
        console.log(`Printer status smoke: ZPL=${result.zplStatus}, TSPL=${result.tsplStatus}, manual cards updated`);
    } finally {
        client?.close();
        await stop();
        await Promise.all([
            new Promise(resolve => zplServer.close(resolve)),
            new Promise(resolve => tsplServer.close(resolve)),
        ]);
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});