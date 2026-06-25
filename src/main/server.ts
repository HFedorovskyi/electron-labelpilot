import http from 'http';
import { initDatabase } from './database';
import { decrypt, hasLicenseToken } from './encryption';


const PORT = 5556;
const LPI2_MAGIC = 'LPI2\n';

// Body-size caps: a full DB dump can be sizable, a print job is tiny. Caps prevent a
// runaway/malicious POST from doubling RSS on a weak station.
const MAX_BODY_SYNC = 64 * 1024 * 1024;   // 64 MB
const MAX_BODY_PRINT_JOB = 1 * 1024 * 1024; // 1 MB

/**
 * Read a request body into a Buffer with a hard size cap (raw bytes — a pushed body may be a
 * binary LPI2 blob, not utf8 text). Buffers chunks (no O(n^2) concat). On overflow it responds
 * 413 and destroys the socket; resolves null so the caller stops. Resolves null on stream error.
 */
function readBody(req: http.IncomingMessage, res: http.ServerResponse, maxBytes: number): Promise<Buffer | null> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        req.on('data', (chunk: Buffer) => {
            if (done) return;
            size += chunk.length;
            if (size > maxBytes) {
                done = true;
                try { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Payload too large' })); } catch { /* ignore */ }
                req.destroy();
                resolve(null);
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
        req.on('error', () => { if (!done) { done = true; resolve(null); } });
    });
}

/**
 * Decode a pushed body, AUTHENTICATING the sender. A licensed station accepts ONLY an
 * LPI2-encrypted body — its embedded, Ed25519-signed license token proves the sender holds a
 * valid license, so a rogue LAN host cannot forge a print job or a DB overwrite. A station with
 * no license yet (unprovisioned/demo) still accepts plain JSON: it has nothing to protect, and
 * its first real push from a licensed server arrives as LPI2 anyway (which also stores the token).
 * Throws an error tagged `unauthorized` when a licensed station is handed plaintext.
 */
function parsePushBody(body: Buffer): any {
    const isLPI2 = body.length > LPI2_MAGIC.length && body.subarray(0, LPI2_MAGIC.length).toString('ascii') === LPI2_MAGIC;
    if (isLPI2) {
        return decrypt(body); // verifies the embedded license signature, then decrypts
    }
    if (hasLicenseToken()) {
        const err = new Error('Unauthenticated plaintext push rejected: station is licensed and expects an encrypted (LPI2) body.') as Error & { unauthorized?: boolean };
        err.unauthorized = true;
        throw err;
    }
    return JSON.parse(body.toString('utf8'));
}

export function startSyncServer(onSyncComplete?: (data: any) => void) {
    const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
        // Set CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        try {
            console.log(`Sync Server: [${req.method}] ${req.url || '/'}`);
        } catch (e) {
            // Silently ignore log errors (prevents EPIPE crash)
        }

        const url = req.url || '/';
        const normalizedUrl = url.endsWith('/') ? url.slice(0, -1) : url;

        if (normalizedUrl === '/api/full_sync' && req.method === 'GET') {
            // This dumps the WHOLE local DB. Nothing on the LAN legitimately pulls it (the server
            // PUSHES via POST), so restrict it to loopback — otherwise any LAN host could read
            // every product/template/identity row off a station unauthenticated.
            const ra = req.socket.remoteAddress || '';
            if (!(ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1')) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Forbidden' }));
                return;
            }
            try {
                const db = initDatabase();

                // Export logic (same as before)
                const barcodes = db.prepare('SELECT * FROM barcodes').all();
                const labels = db.prepare('SELECT * FROM labels').all();
                const containers = db.prepare('SELECT * FROM container').all();
                const nomenclature = db.prepare('SELECT * FROM nomenclature').all();
                const packs = db.prepare('SELECT * FROM pack').all();

                const payload = {
                    barcodes,
                    labels,
                    containers,
                    nomenclature,
                    packs
                };

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(payload));
                console.log('Sync Server: Exported full database snapshot');
            } catch (err: any) {
                console.error('Sync Server Error:', err);
                res.writeHead(500);
                res.end(JSON.stringify({ error: err.message }));
            }
        }
        else if ((normalizedUrl === '/api/sync_db' || normalizedUrl === '/api/full_sync') && req.method === 'POST') {
            readBody(req, res, MAX_BODY_SYNC).then(async (body) => {
                if (body === null) return; // 413 already sent / stream error
                const { processSyncData } = require('./processor');
                try {
                    const data = parsePushBody(body);
                    console.log(`Sync Server: Received POST sync request. Type: ${data?.meta?.type || 'Online'}`);

                    const result = await processSyncData(data);

                    if (result.success) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, message: 'Sync completed' }));

                        // Notify that sync is complete
                        if (onSyncComplete) {
                            onSyncComplete(result);
                        }
                    } else {
                        throw new Error(result.message || 'Import failed');
                    }
                } catch (err: any) {
                    if (err && err.unauthorized) {
                        res.writeHead(401, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Unauthorized' }));
                        return;
                    }
                    console.error('Sync Server Import Error:', err);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message || 'Malformed JSON or import error' }));
                }
            });
        }
        else if (normalizedUrl === '/api/print_job' && req.method === 'POST') {
            readBody(req, res, MAX_BODY_PRINT_JOB).then((body) => {
                if (body === null) return;
                try {
                    const data = parsePushBody(body);
                    const { processOnlinePrintJob } = require('./print_job');
                    const job = processOnlinePrintJob(data);

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, job_id: job.job_id }));

                    // Notify renderer about new job
                    if (onSyncComplete) {
                        onSyncComplete({ type: 'print_job', job });
                    }
                } catch (err: any) {
                    if (err && err.unauthorized) {
                        res.writeHead(401, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Unauthorized' }));
                        return;
                    }
                    console.error('Print Job Error:', err);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            });
        }
        else {
            res.writeHead(404);
            res.end('Not Found');
        }
    });

    // Reap slow/half-open clients so a stalled connection can't pin a buffer/socket forever.
    server.requestTimeout = 60_000;
    server.headersTimeout = 30_000;

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`Sync Server listening on port ${PORT}`);
    });

    return server;
}
