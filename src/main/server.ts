import http from 'http';
import { initDatabase } from './database';

const PORT = 5556;

export function startSyncServer() {
    const server = http.createServer((req, res) => {
        // Set CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        if (req.url === '/api/full-sync' && req.method === 'GET') {
            try {
                const db = initDatabase();
                if (!db) throw new Error('Database not initialized');

                // Fetch all data in dependency order
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
        } else {
            res.writeHead(404);
            res.end('Not Found');
        }
    });

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`Sync Server listening on port ${PORT}`);
    });

    return server;
}
