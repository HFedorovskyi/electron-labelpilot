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
            const [config, labels, transportBefore, generatorBefore] = await Promise.all([
                invoke('get-printer-config'),
                invoke('get-all-labels'),
                window.__TAURI_INTERNALS__.invoke('desktop_printer_transport_summary'),
                window.__TAURI_INTERNALS__.invoke('desktop_printer_generator_summary'),
            ]);
            const packRow = labels.find(label => {
                try { return JSON.parse(label.structure).canvas?.labelType === 'pack'; }
                catch { return false; }
            });
            if (!packRow) throw new Error('No pack label template is available');
            const packDoc = JSON.parse(packRow.structure);
            const data = {
                name: 'LABELPILOT WORK ROUTE', article: '210901010',
                weight_netto_pack: '1.250', weight_brutto_pack: '1.300',
                production_date: '15.08.2026', exp_date: '10', exp_date_full: '25.08.2026',
                pack_number: '02000001', box_number: '020001', batch_number: 'PROBE',
                barcode: '2109010101234',
            };
            let planResult;
            try {
                planResult = await window.__TAURI_INTERNALS__.invoke('desktop_printer_plan_generation', {
                    payload: { config: config.packPrinter, doc: packDoc, data },
                });
            } catch (error) {
                planResult = { error: String(error) };
            }
            const printResult = await invoke('print-label', {
                silent: true,
                labelDoc: packDoc,
                data,
                printerConfig: config.packPrinter,
            });
            await new Promise(resolve => setTimeout(resolve, 1000));
            const [transportAfter, generatorAfter] = await Promise.all([
                window.__TAURI_INTERNALS__.invoke('desktop_printer_transport_summary'),
                window.__TAURI_INTERNALS__.invoke('desktop_printer_generator_summary'),
            ]);
            return {
                printer: config.packPrinter,
                selectedLabel: {
                    id: packRow.id,
                    name: packRow.name,
                    labelType: packDoc.canvas?.labelType,
                    elements: packDoc.elements?.length || 0,
                },
                planResult,
                printResult,
                transportBefore,
                transportAfter,
                generatorBefore,
                generatorAfter,
            };
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
