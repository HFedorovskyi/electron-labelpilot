// Worker-safe logger for the generator modules. electron-log (via ../../logger)
// requires the electron APIs, which do not exist inside worker_threads — fall back
// to plain console there. The generator runs in BOTH contexts: in the main process
// (fallback path) and inside the generation worker (hot path).
let log: {
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
    debug: (...args: any[]) => void;
};

try {
    // Throws inside worker_threads (logger.ts imports 'electron').
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    log = require('../../logger').default;
} catch {
    log = {
        info: (...args: any[]) => console.log('[gen-worker]', ...args),
        warn: (...args: any[]) => console.warn('[gen-worker]', ...args),
        error: (...args: any[]) => console.error('[gen-worker]', ...args),
        debug: () => { /* quiet in worker */ },
    };
}

export default log;
