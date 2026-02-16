import log from 'electron-log';
import path from 'path';
import { app } from 'electron';

// Configure logging
log.transports.file.level = 'debug';
log.transports.console.level = 'debug';

// Customize log file location to ensure it's in a predictable place
log.transports.file.resolvePathFn = () => path.join(app.getPath('userData'), 'logs', 'main.log');

// Optional: Add some metadata to every log
log.variables.process = 'Main';

log.info('Logger initialized at:', log.transports.file.getFile().path);

export default log;
