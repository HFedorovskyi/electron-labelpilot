'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

function parseArguments(argv) {
    const positional = [];
    const values = new Map();
    for (const argument of argv) {
        if (!argument.startsWith('--')) {
            positional.push(argument);
            continue;
        }
        const separator = argument.indexOf('=');
        if (separator < 3) throw new Error('Option ' + argument + ' requires =VALUE');
        values.set(argument.slice(2, separator), argument.slice(separator + 1));
    }
    const integer = (name, fallback, minimum, maximum) => {
        const raw = values.get(name);
        const value = raw === undefined ? fallback : Number(raw);
        if (!Number.isInteger(value) || value < minimum || value > maximum) {
            throw new Error('--' + name + ' must be an integer in ' + minimum + '..' + maximum);
        }
        return value;
    };
    return {
        exe: positional[0] ? path.resolve(positional[0]) : '',
        resultPath: positional[1] ? path.resolve(positional[1]) : null,
        durationSeconds: integer('duration-seconds', 28_800, 20, 86_400),
        printIntervalMs: integer('print-interval-ms', 1_000, 100, 60_000),
        syncIntervalMs: integer('sync-interval-ms', 5_000, 500, 300_000),
        snapshotIntervalMs: integer('snapshot-interval-ms', 30_000, 1_000, 300_000),
        printerDisconnectEvery: integer('printer-disconnect-every', 100, 2, 100_000),
        scaleDisconnectEvery: integer('scale-disconnect-every', 40, 2, 100_000),
    };
}

const options = parseArguments(process.argv.slice(2));
if (!options.exe || !fs.existsSync(options.exe)) {
    console.error('Usage: node soak-tauri-runtime.cjs EXE [RESULT_JSON] [--duration-seconds=N] [--print-interval-ms=N] [--sync-interval-ms=N] [--snapshot-interval-ms=N] [--printer-disconnect-every=N] [--scale-disconnect-every=N]');
    process.exit(2);
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labelpilot-runtime-soak-'));
const printerSockets = new Set();
const scaleSockets = new Set();
const memorySamples = [];
const printLatenciesMs = [];
const syncLatenciesMs = [];
const printErrors = [];
const syncErrors = [];
const scaleErrors = [];
let printerConnections = 0;
let printerJobs = 0;
let printerBytes = 0;
let scaleConnections = 0;
let scalePolls = 0;
let runtime = null;

async function listenEphemeral(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.equal(typeof address, 'object');
    return address.port;
}

async function closeServer(server, sockets) {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
}

async function assertIngressPortAvailable() {
    const probe = net.createServer();
    await new Promise((resolve, reject) => {
        probe.once('error', error => reject(new Error('Port 5556 is already in use: ' + error.message)));
        probe.listen(5556, '0.0.0.0', resolve);
    });
    await new Promise(resolve => probe.close(resolve));
}

async function freePort() {
    const probe = net.createServer();
    const port = await listenEphemeral(probe);
    await new Promise(resolve => probe.close(resolve));
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
            expression: '(async () => { ' + expression + ' })()',
            awaitPromise: true,
            returnByValue: true,
        });
        if (response.exceptionDetails) {
            const description = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
            throw new Error('WebView expression failed: ' + description);
        }
        if (response.result.subtype === 'error') throw new Error(response.result.description);
        return response.result.value;
    }

    close() {
        for (const pending of this.pending.values()) pending.reject(new Error('CDP connection closed'));
        this.pending.clear();
        this.socket.close();
    }
}

async function waitForDebugPage(child, port) {
    let lastError;
    for (let attempt = 0; attempt < 160; attempt += 1) {
        if (child.exitCode !== null) throw new Error('Release EXE exited early with code ' + child.exitCode);
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

async function launchRuntime() {
    const debugPort = await freePort();
    const child = childProcess.spawn(options.exe, [], {
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
        for (let attempt = 0; attempt < 40; attempt += 1) {
            const ready = await client.evaluate(
                "if (document.readyState !== 'complete' || !window.__TAURI_INTERNALS__?.invoke) return false;" +
                'await new Promise(resolve => setTimeout(resolve, 100)); return true;'
            );
            if (ready) return { child, client };
            await delay(200);
        }
        throw new Error('Tauri invoke bridge is unavailable');
    } catch (error) {
        if (client) client.close();
        if (child.exitCode === null) {
            childProcess.spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
                stdio: 'ignore',
                windowsHide: true,
            });
        }
        throw error;
    }
}

async function stopRuntime(target) {
    if (!target) return;
    target.client.close();
    target.child.kill();
    for (let attempt = 0; attempt < 30 && target.child.exitCode === null; attempt += 1) await delay(100);
    if (target.child.exitCode === null) {
        childProcess.spawnSync('taskkill.exe', ['/PID', String(target.child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
        });
        await delay(500);
    }
}

function processTreeSnapshot(rootProcessId) {
    const script = [
        "$ErrorActionPreference='Stop'",
        '$rootProcessId=' + rootProcessId,
        '$all=@(Get-CimInstance Win32_Process)',
        '$ids=[Collections.Generic.HashSet[int]]::new(); [void]$ids.Add($rootProcessId)',
        'do{$added=$false; foreach($candidate in $all){if($ids.Contains([int]$candidate.ParentProcessId)-and $ids.Add([int]$candidate.ProcessId)){$added=$true}}}while($added)',
        '$rows=@(); foreach($processId in $ids){$process=Get-Process -Id $processId -ErrorAction SilentlyContinue; if($process){$rows+=$process}}',
        "$value=[pscustomobject]@{capturedAtUtc=[DateTime]::UtcNow.ToString('o');processCount=$rows.Count;workingSetBytes=[long](($rows|Measure-Object WorkingSet64 -Sum).Sum);privateBytes=[long](($rows|Measure-Object PrivateMemorySize64 -Sum).Sum);cpuSeconds=[double](($rows|Measure-Object CPU -Sum).Sum);handles=[int](($rows|Measure-Object HandleCount -Sum).Sum);threads=[int](($rows|ForEach-Object{$_.Threads.Count}|Measure-Object -Sum).Sum)}",
        '$value|ConvertTo-Json -Compress',
    ].join('; ');
    const output = childProcess.execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000,
    }).trim();
    return JSON.parse(output);
}

function median(values) {
    const sorted = Array.from(values).sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function percentile(values, fraction) {
    if (values.length === 0) return null;
    const sorted = Array.from(values).sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function edgeMedian(samples, key, fromStart) {
    const count = Math.min(3, samples.length);
    const edge = fromStart ? samples.slice(0, count) : samples.slice(-count);
    return median(edge.map(sample => sample[key]));
}

function labelPayload(printerPort, sequence) {
    const serial = String(sequence).padStart(8, '0');
    return {
        config: {
            id: 'runtime-soak-zpl',
            active: true,
            name: 'Runtime soak ZPL',
            connection: 'tcp',
            protocol: 'zpl',
            ip: '127.0.0.1',
            port: printerPort,
            dpi: 203,
            compatibilityMode: 'advanced',
            persistentConnection: true,
            jobIdempotencyKey: 'runtime-soak-' + serial,
        },
        doc: {
            widthMm: 58,
            heightMm: 40,
            canvas: { width: 464, height: 320 },
            elements: [
                { id: 'frame', type: 'rect', x: 4, y: 4, w: 456, h: 312, borderWidth: 2 },
                { id: 'title', type: 'text', x: 20, y: 20, w: 410, h: 36, fontSize: 22, text: 'SOAK {{ serial }}' },
                { id: 'code', type: 'barcode', x: 20, y: 80, w: 350, h: 100, barcodeType: 'code128', value: '{{ barcode }}', showText: true },
            ],
        },
        data: { serial, barcode: 'LP' + serial },
    };
}

async function invoke(client, command, argument) {
    const args = argument === undefined ? '' : ', ' + JSON.stringify(argument);
    return client.evaluate('return await window.__TAURI_INTERNALS__.invoke(' + JSON.stringify(command) + args + ');');
}

async function runtimeSummaries(client) {
    return client.evaluate(
        "const invoke = window.__TAURI_INTERNALS__.invoke; return {" +
        "transport: await invoke('desktop_printer_transport_summary')," +
        "durable: await invoke('desktop_printer_durable_summary')," +
        "generator: await invoke('desktop_printer_generator_summary')," +
        "scale: await invoke('desktop_scale_summary')," +
        "ingress: await invoke('desktop_ingress_summary')" +
        '};'
    );
}

async function main() {
    await assertIngressPortAvailable();
    const printerBufferBySocket = new Map();
    const printerServer = net.createServer(socket => {
        printerConnections += 1;
        printerSockets.add(socket);
        printerBufferBySocket.set(socket, Buffer.alloc(0));
        socket.on('data', chunk => {
            printerBytes += chunk.length;
            let buffer = Buffer.concat([printerBufferBySocket.get(socket) || Buffer.alloc(0), chunk]);
            let marker = buffer.indexOf(Buffer.from('^XZ'));
            while (marker >= 0) {
                printerJobs += 1;
                buffer = buffer.subarray(marker + 3);
                if (printerJobs % options.printerDisconnectEvery === 0) {
                    setTimeout(() => {
                        if (socket.destroyed) return;
                        if (typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy();
                        else socket.destroy();
                    }, 25);
                }
                marker = buffer.indexOf(Buffer.from('^XZ'));
            }
            printerBufferBySocket.set(socket, buffer);
        });
        socket.on('error', error => {
            if (!['ECONNRESET', 'EPIPE'].includes(error.code)) printErrors.push('printer-server:' + error.message);
        });
        socket.on('close', () => {
            printerSockets.delete(socket);
            printerBufferBySocket.delete(socket);
        });
    });
    const printerPort = await listenEphemeral(printerServer);

    const scaleServer = net.createServer(socket => {
        scaleConnections += 1;
        scaleSockets.add(socket);
        let input = Buffer.alloc(0);
        let closing = false;
        socket.on('data', chunk => {
            if (closing) return;
            input = Buffer.concat([input, chunk]);
            let pollAt = input.indexOf(Buffer.from('Q\r\n'));
            while (pollAt >= 0) {
                input = input.subarray(pollAt + 3);
                scalePolls += 1;
                socket.write(Buffer.from('ST,+001'));
                const currentPoll = scalePolls;
                setTimeout(() => {
                    if (socket.destroyed) return;
                    socket.write(Buffer.from('23.45 g\r\n'));
                    if (currentPoll % options.scaleDisconnectEvery === 0) socket.end();
                }, 20);
                if (currentPoll % options.scaleDisconnectEvery === 0) { closing = true; break; }
                pollAt = input.indexOf(Buffer.from('Q\r\n'));
            }
        });
        socket.on('error', error => {
            if (!['ECONNRESET', 'EPIPE'].includes(error.code)) scaleErrors.push('scale-server:' + error.message);
        });
        socket.on('close', () => scaleSockets.delete(socket));
    });
    const scalePort = await listenEphemeral(scaleServer);
    fs.writeFileSync(path.join(dataDir, 'scale-config.json'), JSON.stringify({
        type: 'tcp',
        protocolId: 'and_standard',
        host: '127.0.0.1',
        port: scalePort,
        pollingInterval: 50,
        stabilityCount: 4,
    }, null, 2) + '\n');

    const startedAt = Date.now();
    let submittedPrints = 0;
    let completedPrints = 0;
    let syncAttempts = 0;
    let syncSuccess = 0;
    let firstLabelMs = null;
    let hundredLabelsMs = null;
    try {
        runtime = await launchRuntime();
        await delay(2_000);
        const workloadStartedAt = Date.now();
        const deadline = workloadStartedAt + options.durationSeconds * 1_000;
        let nextPrintAt = workloadStartedAt;
        let nextSyncAt = workloadStartedAt;
        let nextSnapshotAt = workloadStartedAt;
        while (Date.now() < deadline) {
            if (runtime.child.exitCode !== null) throw new Error('Runtime exited during soak with code ' + runtime.child.exitCode);
            const now = Date.now();
            if (now >= nextPrintAt) {
                submittedPrints += 1;
                try {
                    const printStartedAt = performance.now();
                    await invoke(runtime.client, 'desktop_printer_generate_and_send', {
                        payload: labelPayload(printerPort, submittedPrints),
                    });
                    printLatenciesMs.push(Math.round((performance.now() - printStartedAt) * 100) / 100);
                    completedPrints += 1;
                    if (completedPrints === 1) firstLabelMs = Date.now() - workloadStartedAt;
                    if (completedPrints === 100) hundredLabelsMs = Date.now() - workloadStartedAt;
                } catch (error) {
                    printErrors.push(String(error.message || error));
                }
                nextPrintAt += options.printIntervalMs;
            }
            if (now >= nextSyncAt) {
                syncAttempts += 1;
                try {
                    const syncStartedAt = performance.now();
                    const response = await fetch('http://127.0.0.1:5556/api/full_sync');
                    if (!response.ok) throw new Error('HTTP ' + response.status);
                    await response.json();
                    syncLatenciesMs.push(Math.round((performance.now() - syncStartedAt) * 100) / 100);
                    syncSuccess += 1;
                } catch (error) {
                    syncErrors.push(String(error.message || error));
                }
                nextSyncAt += options.syncIntervalMs;
            }
            if (now >= nextSnapshotAt) {
                memorySamples.push(processTreeSnapshot(runtime.child.pid));
                nextSnapshotAt += options.snapshotIntervalMs;
            }
            await delay(25);
        }
        while (memorySamples.length < 3) {
            await delay(1_000);
            memorySamples.push(processTreeSnapshot(runtime.child.pid));
        }
        await delay(750);
        const summaries = await runtimeSummaries(runtime.client);
        const firstPrivate = edgeMedian(memorySamples, 'privateBytes', true);
        const lastPrivate = edgeMedian(memorySamples, 'privateBytes', false);
        const firstWorking = edgeMedian(memorySamples, 'workingSetBytes', true);
        const lastWorking = edgeMedian(memorySamples, 'workingSetBytes', false);
        const privateGrowthBytes = lastPrivate - firstPrivate;
        const workingSetGrowthBytes = lastWorking - firstWorking;
        const firstCpu = memorySamples[0].cpuSeconds;
        const lastCpu = memorySamples[memorySamples.length - 1].cpuSeconds;
        const elapsed = (Date.parse(memorySamples[memorySamples.length - 1].capturedAtUtc) - Date.parse(memorySamples[0].capturedAtUtc)) / 1_000;
        const sampleElapsedSeconds = Math.max(1, elapsed);
        const averageCpuPercentNormalized = Math.round(((lastCpu - firstCpu) / (sampleElapsedSeconds * os.cpus().length)) * 10_000) / 100;
        const gates = {
            printCommandsCompleted: submittedPrints > 0 && completedPrints === submittedPrints && printErrors.length === 0,
            firstLabelMeasured: firstLabelMs !== null,
            hundredLabelWindowMeasured: options.durationSeconds * 1000 < options.printIntervalMs * 100 || hundredLabelsMs !== null,
            printerReceivedEveryJob: printerJobs === completedPrints,
            printerReconnectObserved: printerConnections >= 2 && summaries.transport.reconnects >= 1,
            transportQueuesDrained: summaries.transport.queuedNow === 0 && summaries.transport.activeNow === 0,
            transportHealthy: summaries.transport.completedJobs === completedPrints && summaries.transport.failedJobs === 0 && summaries.transport.rejectedJobs === 0,
            durableQueueHealthy: summaries.durable.accepted === completedPrints && summaries.durable.failed === 0 && summaries.durable.uncertain === 0 && summaries.durable.queued === 0 && summaries.durable.rendering === 0 && summaries.durable.sending === 0,
            generatorHealthy: summaries.generator.generatedJobs === completedPrints && summaries.generator.failedJobs === 0 && summaries.generator.fallbackJobs === 0,
            scaleFramesReceived: scalePolls > 0 && summaries.scale.receivedFrames > 0,
            scaleReconnectObserved: scaleConnections >= 2 && summaries.scale.reconnectAttempts >= 1,
            scaleTransportClean: scaleErrors.length === 0,
            ingressHealthy: syncSuccess === syncAttempts && syncErrors.length === 0 && summaries.ingress.completedRequests >= syncSuccess && summaries.ingress.rejectedRequests === 0,
            privateGrowthBounded: privateGrowthBytes <= 64 * 1024 * 1024,
            workingSetGrowthBounded: workingSetGrowthBytes <= 96 * 1024 * 1024,
        };
        const result = {
            schemaVersion: 1,
            kind: 'labelpilot-runtime-soak',
            startedAtUtc: new Date(startedAt).toISOString(),
            completedAtUtc: new Date().toISOString(),
            executable: options.exe,
            executableBytes: fs.statSync(options.exe).size,
            dataDirectory: dataDir,
            configuration: options,
            workload: {
                submittedPrints,
                completedPrints,
                printerJobs,
                printerBytes,
                printerConnections,
                scalePolls,
                scaleConnections,
                syncAttempts,
                syncSuccess,
            },
            errors: { print: printErrors, scale: scaleErrors, sync: syncErrors },
            timings: {
                firstLabelMs,
                hundredLabelsMs,
                printCommandP50Ms: percentile(printLatenciesMs, 0.50),
                printCommandP95Ms: percentile(printLatenciesMs, 0.95),
                printCommandMaxMs: printLatenciesMs.length ? Math.max.apply(null, printLatenciesMs) : null,
                fullSyncP50Ms: percentile(syncLatenciesMs, 0.50),
                fullSyncP95Ms: percentile(syncLatenciesMs, 0.95),
                fullSyncMaxMs: syncLatenciesMs.length ? Math.max.apply(null, syncLatenciesMs) : null,
            },
            summaries,
            resourceTrend: {
                samples: memorySamples.length,
                firstPrivateMedianBytes: firstPrivate,
                lastPrivateMedianBytes: lastPrivate,
                privateGrowthBytes,
                firstWorkingSetMedianBytes: firstWorking,
                lastWorkingSetMedianBytes: lastWorking,
                workingSetGrowthBytes,
                peakPrivateBytes: Math.max.apply(null, memorySamples.map(sample => sample.privateBytes)),
                peakWorkingSetBytes: Math.max.apply(null, memorySamples.map(sample => sample.workingSetBytes)),
                peakHandles: Math.max.apply(null, memorySamples.map(sample => sample.handles)),
                peakThreads: Math.max.apply(null, memorySamples.map(sample => sample.threads)),
                averageCpuPercentNormalized,
            },
            memorySamples,
            gates,
            success: Object.values(gates).every(Boolean),
        };
        if (options.resultPath) {
            fs.mkdirSync(path.dirname(options.resultPath), { recursive: true });
            fs.writeFileSync(options.resultPath, JSON.stringify(result, null, 2) + '\n');
        }
        console.log(JSON.stringify({
            kind: result.kind,
            workload: result.workload,
            timings: result.timings,
            resourceTrend: result.resourceTrend,
            gates: result.gates,
            success: result.success,
        }, null, 2));
        if (!result.success) process.exitCode = 1;
    } finally {
        await stopRuntime(runtime);
        await closeServer(printerServer, printerSockets);
        await closeServer(scaleServer, scaleSockets);
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
