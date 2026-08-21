'use strict';

const assert = require('node:assert/strict');

const port = Number(process.argv[2] || 9337);

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
            throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
        }
        return response.result.value;
    }

    close() { this.socket.close(); }
}

async function main() {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = pages.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
    assert.ok(page, 'LabelPilot WebView page is missing');
    const cdp = new CdpClient(page.webSocketDebuggerUrl);
    await cdp.open();
    try {
        const result = await cdp.evaluate(`
            const invoke = window.desktopBridge.invoke.bind(window.desktopBridge);
            const [config, labels, jobs, station, transport, generator] = await Promise.all([
                invoke('get-printer-config'), invoke('get-all-labels'), invoke('get-print-jobs'),
                invoke('get-station-info'),
                window.__TAURI_INTERNALS__.invoke('desktop_printer_transport_summary'),
                window.__TAURI_INTERNALS__.invoke('desktop_printer_generator_summary'),
            ]);
            return { config, labels, jobs, station, transport, generator };
        `);
        process.stdout.write(JSON.stringify(result, null, 2));
    } finally {
        cdp.close();
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
