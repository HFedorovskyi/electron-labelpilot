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
            expression,
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

async function waitForPage(deadline) {
    while (Date.now() < deadline) {
        try {
            const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            const page = pages.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
            if (page) return page;
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`LabelPilot CDP page did not appear on ${port}`);
}

async function main() {
    const page = await waitForPage(Date.now() + 15_000);
    const cdp = new CdpClient(page.webSocketDebuggerUrl);
    await cdp.open();
    try {
        const bridgeReady = await cdp.evaluate(`typeof window.desktopBridge?.send === 'function'`);
        assert.equal(bridgeReady, true, 'LabelPilot desktop bridge is not ready');
        await cdp.evaluate(`window.desktopBridge.send('quit-app', {}); true`);
        console.log('QUIT_DISPATCHED=TRUE');
    } finally {
        cdp.close();
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});