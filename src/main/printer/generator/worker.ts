/**
 * Generation worker — runs the label generators OFF the main-process event loop.
 *
 * Steady-state cached prints are ~1-5ms, but the miss paths (first print of a template,
 * post-sync/reconnect re-render, every pallet table, every unique GS1 barcode) are
 * 30-300ms of uninterrupted CPU on a weak POS terminal. On the main process that stalls
 * ALL IPC: the live scale-weight stream, printer-status pushes, and the next print
 * request. Here they only stall this thread; the main loop stays live.
 *
 * All generator caches (structural, inline static, RAM upload tracking, barcode/clip
 * GFA) live in this thread because ALL generation goes through it. The main process
 * keeps in-process generator singletons ONLY as a fallback when the worker cannot be
 * created (their caches start empty, which is correct: a dead worker's caches died
 * with it).
 *
 * Protocol (postMessage, one reply per request, matched by id):
 *   { id, cmd: 'generate',       protocol, doc, data, options } → { id, ok, result: Uint8Array }
 *   { id, cmd: 'warmup-bg',      doc, options }                 → { id, ok, result: Uint8Array | null }
 *   { id, cmd: 'clear-bg-cache', printerId? }                   → { id, ok }
 */
import { parentPort, workerData } from 'worker_threads';
import { CanvasBitmapGenerator, initGeneratorEnvironment } from './CanvasBitmapGenerator';
import { ZplGenerator } from './ZplGenerator';

initGeneratorEnvironment({
    fontsDir: workerData?.fontsDir || '',
    logsDir: workerData?.logsDir || '',
});

const canvasGenerator = new CanvasBitmapGenerator();
const zplGenerator = new ZplGenerator();

// Doc cache: repeat prints of a template arrive with a docKey only (no doc clone),
// and reusing ONE object identity per template lets the generator's structural
// WeakMap cache hit across prints. LRU-bounded; on a miss the main process gets
// DOC_MISSING and resends the doc once.
const DOC_CACHE_MAX = 20;
const docCache = new Map<string, any>();
function cacheDoc(key: string, doc: any): void {
    docCache.delete(key);
    docCache.set(key, doc);
    if (docCache.size > DOC_CACHE_MAX) {
        const oldest = docCache.keys().next().value;
        if (oldest !== undefined) docCache.delete(oldest);
    }
}
function resolveDoc(msg: any): any {
    if (msg.doc) return msg.docKey ? docCache.get(msg.docKey) : msg.doc;
    if (msg.docKey) {
        const hit = docCache.get(msg.docKey);
        if (hit) { cacheDoc(msg.docKey, hit); return hit; } // touch LRU
    }
    throw new Error('DOC_MISSING');
}

parentPort!.on('message', (msg: any) => {
    // Cache synchronously at receipt: messages are FIFO, so the main process may mark
    // the key as known the moment it posts a doc-bearing message.
    if (msg.cmd === 'generate' && msg.docKey && msg.doc) cacheDoc(msg.docKey, msg.doc);
    void (async () => {
        try {
            let result: any = null;
            switch (msg.cmd) {
                case 'generate': {
                    const gen = msg.protocol === 'image' ? canvasGenerator : zplGenerator;
                    result = await gen.generate(resolveDoc(msg), msg.data, msg.options);
                    break;
                }
                case 'warmup-bg':
                    result = await canvasGenerator.generateBackgroundUpload(msg.doc, msg.options);
                    break;
                case 'clear-bg-cache':
                    CanvasBitmapGenerator.clearBackgroundCache(msg.printerId);
                    break;
                default:
                    throw new Error(`unknown cmd "${msg.cmd}"`);
            }
            parentPort!.postMessage({ id: msg.id, ok: true, result });
        } catch (e: any) {
            parentPort!.postMessage({ id: msg.id, ok: false, error: String(e?.message || e) });
        }
    })();
});
