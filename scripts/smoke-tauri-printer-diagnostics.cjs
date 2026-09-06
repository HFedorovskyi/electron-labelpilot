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
    console.error('Usage: node smoke-tauri-printer-diagnostics.cjs EXE [RESULT_JSON]');
    process.exit(2);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labelpilot-diagnostics-smoke-'));
const exportedZip = path.join(dataDir, 'printer-diagnostic.zip');
let child;

async function listen(server) {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return server.address().port;
}
async function freePort() {
    const server = net.createServer();
    const port = await listen(server);
    await new Promise(resolve => server.close(resolve));
    return port;
}
class CdpClient {
    constructor(url) { this.socket = new WebSocket(url); this.nextId = 1; this.pending = new Map(); }
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
            message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
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
            expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true,
        });
        if (response.exceptionDetails) {
            throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
        }
        return response.result.value;
    }
    close() { this.socket.close(); }
}
async function waitForPage(port) {
    let lastError;
    for (let attempt = 0; attempt < 160; attempt++) {
        if (child?.exitCode !== null) throw new Error(`EXE exited early: ${child.exitCode}`);
        try {
            const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            const page = pages.find(value => value.type === 'page' && value.webSocketDebuggerUrl);
            if (page) return page.webSocketDebuggerUrl;
        } catch (error) { lastError = error; }
        await delay(250);
    }
    throw new Error(`WebView2 timeout: ${lastError?.message ?? 'no page'}`);
}
async function stop() {
    if (!child || child.exitCode !== null) return;
    child.kill();
    for (let attempt = 0; attempt < 30 && child.exitCode === null; attempt++) await delay(100);
    if (child.exitCode === null) childProcess.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}

async function main() {
    const statusQueries = [];
    const printed = [];
    const server = net.createServer(socket => {
        socket.on('error', () => {});
        socket.on('data', chunk => {
        const bytes = Buffer.from(chunk);
        if (bytes.includes(Buffer.from('~HS\r\n', 'ascii'))) {
            statusQueries.push(bytes);
            socket.write(Buffer.from(
                '\x02030,1,0,0250,000,0,0,0,000,0,0,0\x03\r\n' +
                '\x02001,0,1,0,0,2,0,0,00000000,1,000\x03\r\n' +
                '\x021234,0\x03\r\n', 'latin1'));
        } else {
            printed.push(bytes);
        }
        });
    });
    const printerPort = await listen(server);
    const debugPort = await freePort();
    const pack = {
        id: 'diagnostic-zpl', active: true, name: 'ZPL virtual printer', connection: 'tcp',
        protocol: 'zpl', ip: '127.0.0.1', port: printerPort, dpi: 203,
        widthMm: 58, heightMm: 40, printTarget: 'label-roll', persistentConnection: false,
    };
    child = childProcess.spawn(exe, [], {
        env: { ...process.env, LABELPILOT_DATA_DIR: dataDir, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}` },
        stdio: 'ignore', windowsHide: true,
    });
    let client;
    try {
        client = new CdpClient(await waitForPage(debugPort));
        await client.open();
        await client.request('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
        for (let attempt = 0; attempt < 50; attempt++) {
            if (await client.evaluate(`return document.readyState === 'complete' && !!window.__TAURI_INTERNALS__?.invoke && !!window.desktopBridge?.invoke;`)) break;
            await delay(200);
        }
        await client.evaluate(`
            const invoke = window.__TAURI_INTERNALS__.invoke;
            await invoke('desktop_save_printer_config', { payload: {
                packPrinter: ${JSON.stringify(pack)},
                boxPrinter: { id: 'box-off', active: false, name: 'Box', connection: 'tcp', protocol: 'tspl', dpi: 203 },
                palletPrinter: { id: 'pallet-off', active: false, name: 'Pallet', connection: 'windows_driver', protocol: 'browser', printTarget: 'page-sheet', dpi: 300 },
                autoPrintOnStable: true, serverIp: '', language: 'ru'
            }});
            const button = [...document.querySelectorAll('button')].find(value => value.textContent?.includes('Диагностика принтеров'));
            if (!button) throw new Error('diagnostics navigation button missing');
            button.click();
            return true;
        `);
        let ui;
        for (let attempt = 0; attempt < 60; attempt++) {
            ui = await client.evaluate(`
                const root = document.querySelector('[data-testid="printer-diagnostics"]');
                if (!root) return null;
                const buttons = [...root.querySelectorAll('button')];
                return {
                    title: root.querySelector('h2')?.textContent?.trim(),
                    viewport: [window.innerWidth, window.innerHeight],
                    overflow: document.documentElement.scrollWidth - window.innerWidth,
                    minButton: Math.min(...buttons.map(value => value.getBoundingClientRect().height).filter(Boolean)),
                    cards: root.querySelectorAll('[data-printer-role]').length,
                };
            `);
            if (ui) break;
            await delay(200);
        }
        assert.ok(ui, 'diagnostics lazy screen did not render');
        assert.equal(ui.title, 'Диагностика принтеров');
        assert.deepEqual(ui.viewport, [1366, 768]);
        assert.ok(ui.overflow <= 1, `horizontal overflow: ${ui.overflow}`);
        assert.ok(ui.minButton >= 48, `touch target below 48px: ${ui.minButton}`);
        assert.equal(ui.cards, 3);

        await client.evaluate(`
            const root = document.querySelector('[data-testid="printer-diagnostics"]');
            [...root.querySelectorAll('button')].find(value => value.textContent?.includes('Проверить все')).click();
        `);
        let content = '';
        for (let attempt = 0; attempt < 80; attempt++) {
            content = await client.evaluate(`return document.querySelector('[data-testid="printer-diagnostics"]')?.textContent ?? '';`);
            if (content.includes('head-open') && content.includes('zpl-hybrid')) break;
            await delay(200);
        }
        assert.match(content, /head-open/);
        assert.match(content, /zpl-hybrid/);

        await client.evaluate(`
            const card = document.querySelector('[data-printer-role="packPrinter"]');
            [...card.querySelectorAll('button')].find(value => value.textContent?.includes('Калибровка')).click();
            return true;
        `);
        await client.evaluate(`
            const button = [...document.body.querySelectorAll('button')].find(value => value.textContent?.includes('Печатать 1 экземпляр'));
            if (!button) throw new Error('calibration confirmation missing');
            button.click();
            return true;
        `);
        let zpl = Buffer.alloc(0);
        for (let attempt = 0; attempt < 120; attempt++) {
            zpl = Buffer.concat(printed);
            if (zpl.includes(Buffer.from('^XZ', 'ascii'))) break;
            await delay(200);
        }
        const zplText = zpl.toString('latin1');
        assert.match(zplText, /\^XA/);
        assert.match(zplText, /\^PW464/);
        assert.match(zplText, /\^LL320/);
        assert.equal((zplText.match(/\^XA/g) || []).length, 1, 'calibration must print exactly one label');

        const receipt = await client.evaluate(`
            return await window.__TAURI_INTERNALS__.invoke('desktop_printer_export_diagnostic', { payload: {
                path: ${JSON.stringify(exportedZip)}, format: 'zip',
                report: { schemaVersion: 1, kind: 'labelpilot-printer-diagnostic', generatedAt: new Date().toISOString(), diagnostics: { packPrinter: { status: 'head-open' } } }
            }});
        `);
        assert.equal(receipt.success, true);
        assert.equal(receipt.format, 'zip');
        const zip = fs.readFileSync(exportedZip);
        assert.equal(zip.subarray(0, 2).toString('ascii'), 'PK');
        assert.equal(receipt.bytes, zip.length);
        assert.match(receipt.sha256, /^[0-9A-F]{64}$/);
        const result = {
            exe, dataDir, viewport: ui.viewport, horizontalOverflowPx: ui.overflow,
            minimumTouchTargetPx: ui.minButton, cards: ui.cards, status: 'head-open', backend: 'zpl-hybrid',
            statusQueries: statusQueries.length, calibrationLabels: (zplText.match(/\^XA/g) || []).length,
            calibrationSizeDots: [464, 320], exportedZip, exportBytes: receipt.bytes, exportSha256: receipt.sha256,
        };
        if (resultPath) fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
        console.log(`Printer diagnostics smoke: ${ui.viewport.join('x')} touch>=${ui.minButton}px overflow=${ui.overflow}px`);
        console.log(`Probe/calibration: ${result.status}, ${result.backend}, ${result.calibrationSizeDots.join('x')} dots, labels=${result.calibrationLabels}`);
        console.log(`Diagnostic ZIP: ${receipt.bytes} bytes SHA-256=${receipt.sha256}`);
    } finally {
        client?.close();
        await stop();
        await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
