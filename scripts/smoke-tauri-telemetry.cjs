'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const exe = path.resolve(process.argv[2] || '');
const resultPath = path.resolve(process.argv[3] || 'artifacts/release-v2.0.0/telemetry-smoke.json');
if (!process.argv[2] || !fs.existsSync(exe)) throw new Error('Usage: node smoke-tauri-telemetry.cjs EXE [RESULT_JSON]');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labelpilot-telemetry-smoke-'));

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.equal(typeof address, 'object');
    await new Promise(resolve => server.close(resolve));
    return address.port;
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
            expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true,
        });
        if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
        return response.result.value;
    }
    close() { this.socket.close(); }
}

async function waitForPage(child, port) {
    for (let attempt = 0; attempt < 160; attempt += 1) {
        if (child.exitCode !== null) throw new Error(`Runtime exited during startup: ${child.exitCode}`);
        try {
            const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            const page = pages.find(candidate => candidate.type === 'page' && candidate.webSocketDebuggerUrl);
            if (page) return page.webSocketDebuggerUrl;
        } catch {}
        await delay(250);
    }
    throw new Error('WebView2 debug page timeout');
}

async function waitForExit(child, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (child.exitCode === null && Date.now() < deadline) await delay(100);
    return child.exitCode;
}

function queryDatabase(databasePath) {
    const program = [
        'import json,sqlite3,sys',
        'db=sqlite3.connect(sys.argv[1])',
        "rows=db.execute(\"select level,message from print_errors order by id\").fetchall()",
        "print(json.dumps({'rows':len(rows),'structured':sum('labelpilot.telemetry.v1' in r[1] for r in rows),'startup':sum('runtime_started' in r[1] for r in rows),'renderer':sum('smoke_renderer_error' in r[1] for r in rows),'shutdown':sum('runtime_stopped' in r[1] for r in rows)}))",
    ].join(';');
    const result = childProcess.spawnSync('python', ['-c', program, databasePath], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}

async function main() {
    const port = await freePort();
    const child = childProcess.spawn(exe, [], {
        env: { ...process.env, LABELPILOT_DATA_DIR: dataDir, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
        stdio: 'ignore', windowsHide: true,
    });
    let client;
    try {
        client = new CdpClient(await waitForPage(child, port));
        await client.open();
        for (let attempt = 0; attempt < 100; attempt += 1) {
            if (await client.evaluate("return typeof window.__TAURI_INTERNALS__?.invoke === 'function';")) break;
            await delay(100);
        }
        assert.equal(await client.evaluate("return typeof window.__TAURI_INTERNALS__?.invoke === 'function';"), true, 'Tauri invoke bridge did not initialize');
        const version = await client.evaluate("return await window.__TAURI_INTERNALS__.invoke('desktop_get_version');");
        assert.equal(version, '2.0.0');
        await client.evaluate("return await window.__TAURI_INTERNALS__.invoke('desktop_log', {payload:{level:'ERROR',event:'smoke_renderer_error',message:'bounded smoke event'}});");
        const summary = await client.evaluate("return await window.__TAURI_INTERNALS__.invoke('desktop_telemetry_flush');");
        assert.equal(summary.workerRunning, true);
        assert.equal(summary.autoReportEnabled, true);
        assert.ok(summary.recordedEvents >= 3, JSON.stringify(summary));
        assert.ok(summary.reportCycles >= 1, JSON.stringify(summary));
        assert.ok(summary.deferredWithoutIdentity >= 1, JSON.stringify(summary));
        await client.evaluate("await window.__TAURI_INTERNALS__.invoke('desktop_quit_app'); return true;");
        client.close(); client = null;
        assert.equal(await waitForExit(child, 15_000), 0, 'Tauri did not exit cleanly after telemetry shutdown spool');
        const database = queryDatabase(path.join(dataDir, 'client_data.db'));
        assert.ok(database.structured >= 4, JSON.stringify(database));
        assert.equal(database.startup, 1);
        assert.equal(database.renderer, 1);
        assert.equal(database.shutdown, 1);
        assert.equal(fs.existsSync(path.join(dataDir, 'report_state.json')), false, 'cursor advanced without identity/license');
        const outbox = path.join(dataDir, 'outbox');
        const pendingFiles = fs.existsSync(outbox) ? fs.readdirSync(outbox).filter(name => name.endsWith('.lpr')).length : 0;
        assert.equal(pendingFiles, 0, 'unencrypted report was spooled');
        const output = { kind: 'labelpilot-telemetry-smoke', version, summary, database, cleanExit: true, cursorAdvanced: false, pendingFiles };
        fs.mkdirSync(path.dirname(resultPath), { recursive: true });
        fs.writeFileSync(resultPath, JSON.stringify(output, null, 2) + '\n');
        console.log(JSON.stringify(output, null, 2));
    } finally {
        client?.close();
        if (child.exitCode === null) childProcess.spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
