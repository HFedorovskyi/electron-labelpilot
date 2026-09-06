'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const {
    PrinterCapabilityDetector,
    dpiFromDotsPerMm,
    inferTsplDpi,
    parseTsplStatus,
    parseZplHostStatus,
    parseZplIdentification,
    probePrinterCapabilities,
} = require('../dist-electron/main/printer/capabilities.js');
const { TcpStrategy } = require('../dist-electron/main/printer/strategies/TcpStrategy.js');

const STX = String.fromCharCode(2);
const ETX = String.fromCharCode(3);

function zplStatus({ paperOut = false, paused = false, headOpen = false, ribbonOut = false } = {}) {
    return Buffer.from(
        `${STX}030,${paperOut ? 1 : 0},${paused ? 1 : 0},0250,000,0,0,0,000,0,0,0${ETX}\r\n` +
        `${STX}001,0,${headOpen ? 1 : 0},${ribbonOut ? 1 : 0},0,2,0,0,00000000,1,000${ETX}\r\n` +
        `${STX}1234,0${ETX}\r\n`,
        'latin1',
    );
}

class FakeStrategy {
    constructor(replies, delayMs = 0) {
        this.replies = replies;
        this.delayMs = delayMs;
        this.connected = false;
        this.connectCount = 0;
        this.disconnectCount = 0;
        this.sendCount = 0;
        this.queries = [];
    }

    async connect() {
        this.connected = true;
        this.connectCount += 1;
    }

    async disconnect() {
        this.connected = false;
        this.disconnectCount += 1;
    }

    async send() {
        this.sendCount += 1;
        throw new Error('Capability detection must never use send()');
    }

    isConnected() {
        return this.connected;
    }

    async query(data) {
        this.queries.push(Buffer.from(data));
        if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        const ascii = data.toString('latin1');
        if (ascii.startsWith('~HI')) return this.replies.zplId || Buffer.alloc(0);
        if (ascii.startsWith('~HS')) return this.replies.zplStatus || Buffer.alloc(0);
        if (ascii.startsWith('~!T')) return this.replies.tsplId || Buffer.alloc(0);
        if (data.equals(Buffer.from([0x1b, 0x21, 0x3f]))) return this.replies.tsplStatus || Buffer.alloc(0);
        throw new Error(`Unexpected query: ${data.toString('hex')}`);
    }
}

const tcpConfig = {
    id: 'pack',
    active: true,
    name: 'Test TCP',
    connection: 'tcp',
    protocol: 'zpl',
    ip: '127.0.0.1',
    port: 9100,
    dpi: 203,
};

async function run() {
    assert.equal(dpiFromDotsPerMm(8), 203);
    assert.equal(dpiFromDotsPerMm(12), 300);
    assert.equal(dpiFromDotsPerMm(24), 600);
    assert.equal(dpiFromDotsPerMm(6), undefined);

    const zplId = parseZplIdentification(Buffer.from('ZT411,V84.20.21Z,12,8192KB,CUTTER\r\n'));
    assert.deepEqual(zplId, {
        model: 'ZT411',
        firmware: 'V84.20.21Z',
        dotsPerMm: 12,
        dpi: 300,
    });
    assert.equal(parseZplIdentification(Buffer.from('not,a,printer')), null);

    assert.deepEqual(parseZplHostStatus(zplStatus()), { status: 'ready', details: [] });
    assert.equal(parseZplHostStatus(zplStatus({ paperOut: true })).status, 'paper_out');
    assert.equal(parseZplHostStatus(zplStatus({ headOpen: true, paperOut: true })).status, 'head_open');

    assert.deepEqual(parseTsplStatus(Buffer.from([0x00])), { status: 'ready', details: [] });
    assert.equal(parseTsplStatus(Buffer.from([0x20])).status, 'printing');
    assert.equal(parseTsplStatus(Buffer.from([0x05])).status, 'head_open');
    assert.equal(inferTsplDpi('TSC MH641'), 600);
    assert.equal(inferTsplDpi('TTP-346MT'), 300);
    assert.equal(inferTsplDpi('TE200'), 203);
    assert.equal(inferTsplDpi('Clone ABC'), undefined);

    const zplStrategy = new FakeStrategy({
        zplId: Buffer.from('ZT411,V84.20.21Z,12,8192KB,CUTTER\r\n'),
        zplStatus: zplStatus(),
    });
    await zplStrategy.connect(tcpConfig);
    const zplReport = await probePrinterCapabilities(tcpConfig, zplStrategy);
    assert.equal(zplReport.detected, true);
    assert.equal(zplReport.protocol, 'zpl');
    assert.equal(zplReport.model, 'ZT411');
    assert.equal(zplReport.dpi, 300);
    assert.equal(zplReport.status, 'ready');
    assert.equal(zplReport.recommendedProfileId, 'zpl-full');
    assert.equal(zplStrategy.sendCount, 0);
    assert.deepEqual(zplStrategy.queries.map((q) => q.toString('ascii').trim()), ['~HI', '~HS']);

    const cloneZplStrategy = new FakeStrategy({
        zplId: Buffer.from('CLONE-420,V1,8,4096KB\r\n'),
        zplStatus: zplStatus(),
    });
    await cloneZplStrategy.connect(tcpConfig);
    const cloneZplReport = await probePrinterCapabilities(tcpConfig, cloneZplStrategy);
    assert.equal(cloneZplReport.recommendedProfileId, 'generic-zpl-safe');

    const tsplStrategy = new FakeStrategy({
        tsplId: Buffer.from('TSC MH641\r\n'),
        tsplStatus: Buffer.from([0x10]),
    });
    await tsplStrategy.connect(tcpConfig);
    const tsplReport = await probePrinterCapabilities(tcpConfig, tsplStrategy);
    assert.equal(tsplReport.detected, true);
    assert.equal(tsplReport.protocol, 'tspl');
    assert.equal(tsplReport.model, 'TSC MH641');
    assert.equal(tsplReport.dpi, 600);
    assert.equal(tsplReport.status, 'paused');
    assert.equal(tsplReport.recommendedProfileId, 'tspl2-full');
    assert.equal(tsplStrategy.sendCount, 0);
    assert.equal(tsplStrategy.queries.length, 3);
    assert.equal(tsplStrategy.queries[2].toString('hex'), '1b213f');

    // Sequential calls reuse the physical-endpoint cache.
    const detector = new PrinterCapabilityDetector();
    let factoryCalls = 0;
    const firstStrategy = new FakeStrategy({
        zplId: Buffer.from('ZT411,V1,8,4096KB\r\n'),
        zplStatus: zplStatus(),
    });
    const factory = () => {
        factoryCalls += 1;
        return firstStrategy;
    };
    const first = await detector.detect(tcpConfig, factory);
    const second = await detector.detect({ ...tcpConfig, id: 'box' }, factory);
    assert.equal(first.cached, false);
    assert.equal(first.endpointKey, 'tcp:127.0.0.1:9100');
    assert.equal(second.cached, true);
    assert.equal(factoryCalls, 1);
    assert.equal(firstStrategy.connectCount, 1);
    assert.equal(firstStrategy.disconnectCount, 1);

    // Concurrent calls coalesce to one probe and one isolated connection.
    const concurrentDetector = new PrinterCapabilityDetector();
    let concurrentFactories = 0;
    const slowFactory = () => {
        concurrentFactories += 1;
        return new FakeStrategy({
            zplId: Buffer.from('ZT411,V1,8,4096KB\r\n'),
            zplStatus: zplStatus(),
        }, 5);
    };
    const [concurrentA, concurrentB] = await Promise.all([
        concurrentDetector.detect(tcpConfig, slowFactory),
        concurrentDetector.detect({ ...tcpConfig, id: 'pallet' }, slowFactory),
    ]);
    assert.equal(concurrentA.detected, true);
    assert.equal(concurrentB.detected, true);
    assert.equal(concurrentFactories, 1);

    const spooler = await detector.detect({
        ...tcpConfig,
        id: 'driver',
        connection: 'windows_driver',
        driverName: 'Test Driver',
    }, () => null);
    assert.equal(spooler.detected, false);
    assert.equal(spooler.source, 'unavailable');

    // Real TCP strategy round-trip: verify the detector sends only the documented
    // identification/status commands and parses replies arriving through net.Socket.
    const tcpBytes = [];
    const server = net.createServer((socket) => {
        socket.on('data', (chunk) => {
            tcpBytes.push(Buffer.from(chunk));
            const request = chunk.toString('latin1');
            if (request.includes('~HI')) {
                socket.write(Buffer.from('ZT411,V9,24,8192KB\r\n', 'ascii'));
            } else if (request.includes('~HS')) {
                socket.write(zplStatus());
            }
        });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    let tcpRoundTrip;
    try {
        tcpRoundTrip = await new PrinterCapabilityDetector().detect({
            ...tcpConfig,
            id: 'tcp-roundtrip',
            ip: '127.0.0.1',
            port: address.port,
        }, () => new TcpStrategy());
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
    assert.equal(tcpRoundTrip.detected, true);
    assert.equal(tcpRoundTrip.protocol, 'zpl');
    assert.equal(tcpRoundTrip.dpi, 600);
    const allTcpBytes = Buffer.concat(tcpBytes).toString('latin1');
    assert.match(allTcpBytes, /~HI/);
    assert.match(allTcpBytes, /~HS/);
    assert.doesNotMatch(allTcpBytes, /\^XA|\^XZ|PRINT|CLS/i);

    console.log(JSON.stringify({
        ok: true,
        zpl: { model: zplReport.model, dpi: zplReport.dpi, status: zplReport.status },
        tspl: { model: tsplReport.model, dpi: tsplReport.dpi, status: tsplReport.status },
        cache: { sequentialFactoryCalls: factoryCalls, concurrentFactoryCalls: concurrentFactories },
        tcpRoundTrip: { protocol: tcpRoundTrip.protocol, dpi: tcpRoundTrip.dpi, bytes: tcpBytes.reduce((n, b) => n + b.length, 0) },
        noPrintCommands: zplStrategy.sendCount === 0 && tsplStrategy.sendCount === 0 && !/\^XA|\^XZ|PRINT|CLS/i.test(allTcpBytes),
    }, null, 2));
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
