import log from 'electron-log';
import path from 'path';
import { app } from 'electron';

// Configure logging. In production keep file logs at 'info' and silence the console
// transport entirely — its string formatting + stdout writes are pure overhead on a
// 24/7 kiosk (and the per-print/IPC logs are high-frequency). Dev stays verbose.
const isPackaged = app.isPackaged;
log.transports.file.level = isPackaged ? 'info' : 'debug';
log.transports.console.level = isPackaged ? false : 'debug';

// Customize log file location to ensure it's in a predictable place
log.transports.file.resolvePathFn = () => path.join(app.getPath('userData'), 'logs', 'main.log');

// Optional: Add some metadata to every log
log.variables.process = 'Main';

log.info('Logger initialized at:', log.transports.file.getFile().path);

export default log;
