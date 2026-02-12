import http from 'http';
import { initDatabase } from './database';
import { importDataToDB, type SyncData } from './sync';

const PORT = 5556;

export function startSyncServer() {
    const server = http.createServer((req, res) => {
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
            // Import Logic (Push from Server)
            let body = '';
            req.on('data', chunk => {
                body += chunk.toString();
            });
            req.on('end', () => {
                try {
                    const data = JSON.parse(body) as SyncData;
                    importDataToDB(data);

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'success', message: 'Data synced successfully' }));
                    console.log('Sync Server: Imported full data snapshot via POST');
                } catch (err: any) {
                    console.error('Sync Server Import Error:', err);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            });
        }
        else {
            res.writeHead(404);
            res.end('Not Found');
        }
    });

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`Sync Server listening on port ${PORT}`);
    });

    return server;
}
