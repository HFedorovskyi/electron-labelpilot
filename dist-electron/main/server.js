"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startSyncServer = startSyncServer;
const http_1 = __importDefault(require("http"));
const database_1 = require("./database");
const PORT = 5556;
function startSyncServer(onSyncComplete) {
    const server = http_1.default.createServer((req, res) => {
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
        }
        catch (e) {
            // Silently ignore log errors (prevents EPIPE crash)
        }
        const url = req.url || '/';
        const normalizedUrl = url.endsWith('/') ? url.slice(0, -1) : url;
        if (normalizedUrl === '/api/full_sync' && req.method === 'GET') {
            try {
                const db = (0, database_1.initDatabase)();
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
            }
            catch (err) {
                console.error('Sync Server Error:', err);
                res.writeHead(500);
                res.end(JSON.stringify({ error: err.message }));
            }
        }
        else if ((normalizedUrl === '/api/sync_db' || normalizedUrl === '/api/full_sync') && req.method === 'POST') {
            let body = '';
            req.on('data', (chunk) => {
                body += chunk.toString();
            });
            req.on('end', async () => {
                const { processSyncData } = require('./processor');
                try {
                    const data = JSON.parse(body);
                    console.log(`Sync Server: Received POST sync request. Type: ${data?.meta?.type || 'Online'}`);
                    const result = await processSyncData(data);
                    if (result.success) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, message: 'Sync completed' }));
                        // Notify that sync is complete
                        if (onSyncComplete) {
                            onSyncComplete(result);
                        }
                    }
                    else {
                        throw new Error(result.message || 'Import failed');
                    }
                }
                catch (err) {
                    console.error('Sync Server Import Error:', err);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message || 'Malformed JSON or import error' }));
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
