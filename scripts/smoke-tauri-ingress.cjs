'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLpi2, decodeToken } = require('./create-lpi2-push.cjs');

const [exeArgument, tokenArgument] = process.argv.slice(2);
if (!exeArgument || !tokenArgument) {
    console.error('Usage: node smoke-tauri-ingress.cjs EXE TOKEN_FILE');
    process.exit(2);
}

const exe = path.resolve(exeArgument);
const tokenFile = path.resolve(tokenArgument);
assert.ok(fs.existsSync(exe), 'Release EXE is missing');
assert.ok(fs.existsSync(tokenFile), 'Production license token fixture is missing');
const token = fs.readFileSync(tokenFile, 'utf8').trim();
let productionTokenCompatible = true;
try {
    decodeToken(token);
} catch {
    productionTokenCompatible = false;
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labelpilot-ingress-smoke-'));
const baseUrl = 'http://127.0.0.1:5556';

const sync = {
    station: {
        uuid: 'release-smoke-station',
        number: 12,
        name: 'Release smoke station',
        server_url: 'http://127.0.0.1:8000/api/v1',
    },
    payload: {
        operators: [{ uuid: 'op-smoke', full_name: 'Smoke Operator', is_active: true }],
        barcodes: [{ id: 101, name: 'Smoke GS1', structure: { type: 'code128', fields: [] } }],
        labels: [{ id: 201, name: 'Smoke label', structure: { width: 80, height: 50 } }],
        containers: [{ id: 301, name: 'Smoke tray', weight: 8.5 }],
        nomenclature: [{
            id: 401,
            name: 'Smoke product',
            article: 'SMOKE-401',
            exp_date: 10,
            extra_data: { source: 'release-smoke' },
        }],
    },
    meta: {
        type: 'FULL_SYNC',
        generated_at: '2026-08-13T22:00:00Z',
        min_client_version: '1.3.0',
    },
};
const printJob = {
    type: 'PRINT_JOB',
    job_id: 7001,
    nomenclature_id: 401,
    nomenclature_name: 'Smoke product',
    nomenclature_article: 'SMOKE-401',
    quantity: 25,
    quantity_unit: 'pcs',
    batch_number: 'SMOKE-BATCH',
    marking_date: '2026-08-13',
};

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitReady() {
    let lastError;
    for (let attempt = 0; attempt < 120; attempt += 1) {
        try {
            const response = await fetch(baseUrl + '/', { method: 'OPTIONS' });
            if (response.status === 200) return;
        } catch (error) {
            lastError = error;
        }
        await delay(250);
    }
    throw new Error('Ingress did not become ready: ' + (lastError?.message ?? 'timeout'));
}

async function post(pathname, body) {
    return fetch(baseUrl + pathname, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body,
    });
}

async function responseJson(response) {
    const text = await response.text();
    return text ? JSON.parse(text) : {};
}

function queryDatabase() {
    const program = [
        'import json,sqlite3,sys',
        'db=sqlite3.connect(sys.argv[1])',
        'q=lambda sql: db.execute(sql).fetchone()[0]',
        'print(json.dumps({"nomenclature":q("select count(*) from nomenclature"),"jobs":q("select count(*) from print_jobs where job_id=7001"),"station":q("select count(*) from station where uuid=\\\'release-smoke-station\\\'")}))',
    ].join(';');
    const result = childProcess.spawnSync('python', ['-c', program, path.join(dataDir, 'client_data.db')], {
        encoding: 'utf8',
        windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}

async function main() {
    const child = childProcess.spawn(exe, [], {
        env: { ...process.env, LABELPILOT_DATA_DIR: dataDir },
        stdio: 'ignore',
        windowsHide: true,
    });
    try {
        await waitReady();

        let response = await post('/api/full_sync', Buffer.from(JSON.stringify(sync)));
        assert.equal(response.status, 200);
        assert.equal((await responseJson(response)).message, 'Sync completed');

        if (productionTokenCompatible) {
            const encryptedSync = createLpi2(token, sync, Buffer.from('101112131415161718191a1b1c1d1e1f', 'hex'));
            response = await post('/api/sync_db', encryptedSync);
            assert.equal(response.status, 200);
            assert.ok(fs.existsSync(path.join(dataDir, 'license.token')));

            response = await post('/api/sync_db', Buffer.from(JSON.stringify(sync)));
            assert.equal(response.status, 401);
            assert.equal((await responseJson(response)).error, 'Unauthorized');

            const encryptedJob = createLpi2(token, printJob, Buffer.from('202122232425262728292a2b2c2d2e2f', 'hex'));
            response = await post('/api/print_job', encryptedJob);
            assert.equal(response.status, 200);
            assert.equal((await responseJson(response)).job_id, 7001);
        } else {
            const staleLpi2 = Buffer.concat([
                Buffer.from('LPI2\n'),
                Buffer.from(token, 'ascii'),
                Buffer.from('\n'),
                Buffer.alloc(32),
            ]);
            response = await post('/api/sync_db', staleLpi2);
            assert.equal(response.status, 500);

            response = await post('/api/print_job', Buffer.from(JSON.stringify(printJob)));
            assert.equal(response.status, 200);
            assert.equal((await responseJson(response)).job_id, 7001);
        }

        response = await post('/api/print_job', Buffer.alloc(1024 * 1024 + 1, 65));
        assert.equal(response.status, 413);

        response = await fetch(baseUrl + '/api/full_sync');
        assert.equal(response.status, 200);
        const snapshot = await responseJson(response);
        assert.equal(snapshot.nomenclature.length, 1);
        assert.equal(snapshot.barcodes.length, 1);
        assert.equal(snapshot.labels.length, 1);
        assert.equal(snapshot.containers.length, 1);

        const counts = queryDatabase();
        assert.deepEqual(counts, { nomenclature: 1, jobs: 1, station: 1 });
        const identity = JSON.parse(fs.readFileSync(path.join(dataDir, 'identity.json'), 'utf8'));
        assert.equal(identity.station_number, '12');

        console.log(productionTokenCompatible ? 'Release ingress smoke: OPTIONS=200 plain-sync=200 lpi2-sync=200 plain-after-bind=401' : 'Release ingress smoke: OPTIONS=200 plain-sync=200 stale-production-token=500');
        console.log(productionTokenCompatible ? 'Release ingress smoke: lpi2-print=200 oversized-print=413 snapshot=200' : 'Release ingress smoke: plain-print=200 oversized-print=413 snapshot=200');
        console.log('Release database smoke: nomenclature=1 print_jobs=1 station=1 identity=12');
        console.log('Release smoke data: ' + dataDir);
    } finally {
        child.kill();
        await delay(1000);
        if (!child.killed) childProcess.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
        });
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
