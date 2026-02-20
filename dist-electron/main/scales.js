"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.scaleManager = void 0;
const serialport_1 = require("serialport");
const net_1 = __importDefault(require("net"));
const protocols_1 = require("./protocols");
const config_1 = require("./config");
const logger_1 = __importDefault(require("./logger"));
class ScaleManager {
    scalePort = null;
    tcpClient = null;
    mainWindow = null;
    currentProtocol = null;
    pollingInterval = null;
    config = null;
    connectionTimeout = null;
    lastConnectId = 0;
    // Stability Logic
    recentReadings = [];
    STABILITY_THRESHOLD = 0.005; // deviation
    STABILITY_COUNT = 5;
    constructor() {
        this.config = (0, config_1.loadScaleConfig)();
    }
    async init() {
        // Auto-connect on startup if configured
        if (this.config) {
            logger_1.default.info('ScaleManager: Auto-connecting with saved config...', JSON.stringify(this.config));
            await this.connect(this.config);
        }
    }
    setMainWindow(window) {
        logger_1.default.info('ScaleManager: setMainWindow called. Window exists:', !!window);
        this.mainWindow = window;
    }
    getConfig() {
        return this.config;
    }
    async saveAndConnect(config) {
        logger_1.default.info('ScaleManager: saveAndConnect triggered:', JSON.stringify(config));
        (0, config_1.saveScaleConfig)(config);
        await this.connect(config);
    }
    async listPorts() {
        const startTime = Date.now();
        logger_1.default.info('[ScaleManager] listPorts started');
        try {
            const ports = await serialport_1.SerialPort.list();
            logger_1.default.info(`[ScaleManager] listPorts finished. Found ${ports.length} ports:`);
            ports.forEach(p => {
                logger_1.default.info(`  - ${p.path}: ${p.manufacturer || 'Unknown'} (${p.pnpId || ''})`);
            });
            return ports;
        }
        catch (e) {
            logger_1.default.error(`[ScaleManager] listPorts FAILED in ${Date.now() - startTime}ms:`, e);
            throw e;
        }
    }
    getStatus() {
        return this.status;
    }
    status = 'disconnected';
    getProtocols() {
        return Object.values(protocols_1.PROTOCOLS).map(p => ({
            id: p.id,
            name: p.name,
            description: p.description
        }));
    }
    lastDataTime = 0;
    watchdogInterval = null;
    async connect(config) {
        const myId = ++this.lastConnectId;
        logger_1.default.info(`ScaleManager: [CONNECT] START #${myId} (type: ${config.type}, protocol: ${config.protocolId})`);
        try {
            await this.disconnect();
            // Fencing check
            if (myId !== this.lastConnectId) {
                logger_1.default.warn(`ScaleManager: [CONNECT] #${myId} superseded by #${this.lastConnectId}. Aborting.`);
                return;
            }
            this.config = config;
            this.currentProtocol = (0, protocols_1.getProtocol)(config.protocolId);
            logger_1.default.info(`ScaleManager: [CONNECT] #${myId} Internal type: ${config.type}, Protocol: ${this.currentProtocol.name}`);
            this.emitStatus('reconnecting');
            if (config.type === 'serial') {
                await this.connectSerial(config);
            }
            else if (config.type === 'simulator') {
                this.emitStatus('connected');
                this.startPolling();
            }
            else {
                this.connectTcp(config);
            }
            // Final fencing check
            if (myId !== this.lastConnectId) {
                logger_1.default.warn(`ScaleManager: [CONNECT] #${myId} superseded during connection. Ignoring results.`);
                return;
            }
        }
        catch (e) {
            logger_1.default.error(`ScaleManager: [CONNECT] #${myId} ERROR:`, e);
            throw e;
        }
        finally {
            if (myId === this.lastConnectId) {
                logger_1.default.info(`ScaleManager: [CONNECT] #${myId} FINISHED`);
            }
            else {
                logger_1.default.info(`ScaleManager: [CONNECT] #${myId} cleanup finished.`);
            }
        }
    }
    async connectSerial(config) {
        const path = config.path;
        if (!path) {
            logger_1.default.error('ScaleManager: [SERIAL] No path provided');
            return;
        }
        return new Promise((resolvePromise) => {
            let doneCalled = false;
            const done = () => {
                if (doneCalled)
                    return;
                doneCalled = true;
                clearTimeout(connectionTimeout);
                resolvePromise();
            };
            const connectionTimeout = setTimeout(() => {
                logger_1.default.warn(`ScaleManager: [SERIAL] Connection to ${path} TIMEOUT (5s)`);
                done();
            }, 5000);
            try {
                const baudRate = config.baudRate || this.currentProtocol?.defaultBaudRate || 9600;
                const parity = this.currentProtocol?.parity || 'none';
                const dataBits = this.currentProtocol?.dataBits || 8;
                const stopBits = this.currentProtocol?.stopBits || 1;
                logger_1.default.info(`ScaleManager: [SERIAL] Opening ${path} (${baudRate}, ${dataBits}, ${parity}, ${stopBits})`);
                this.scalePort = new serialport_1.SerialPort({
                    path: path,
                    baudRate: baudRate,
                    parity: parity,
                    dataBits: dataBits,
                    stopBits: stopBits,
                    autoOpen: false,
                    rtscts: false,
                });
                this.scalePort.on('open', () => {
                    logger_1.default.info(`ScaleManager: [SERIAL] Port ${path} OPENED`);
                    this.scalePort?.set({ dtr: true, rts: true }, (err) => {
                        if (err)
                            logger_1.default.error('ScaleManager: [SERIAL] Error setting DTR/RTS:', err.message);
                        else {
                            logger_1.default.info('ScaleManager: [SERIAL] DTR/RTS signals set to TRUE');
                        }
                    });
                    this.emitStatus('connecting');
                    this.connectionTimeout = setTimeout(() => {
                        this.connectionTimeout = null;
                        if (this.scalePort?.isOpen) {
                            logger_1.default.info('ScaleManager: [SERIAL] Starting polling after delay');
                            this.startPolling();
                            this.startWatchdog();
                        }
                    }, 200);
                    done();
                });
                this.scalePort.on('data', (data) => {
                    this.handleData(data);
                });
                this.scalePort.on('error', (err) => {
                    logger_1.default.error('ScaleManager: [SERIAL] Port Error:', err.message);
                    if (err.message.includes('Access denied')) {
                        this.emitError(`serial_access_denied|${config.path}`);
                    }
                    else if (err.message.includes('File not found')) {
                        this.emitError(`serial_not_found|${config.path}`);
                    }
                    else {
                        this.emitError(err.message);
                    }
                    done();
                });
                this.scalePort.on('close', () => {
                    logger_1.default.info('ScaleManager: [SERIAL] Port CLOSED');
                    this.emitStatus('disconnected');
                });
                this.scalePort.open((err) => {
                    if (err) {
                        logger_1.default.error('ScaleManager: [SERIAL] Immediate Open Error:', err.message);
                    }
                });
            }
            catch (err) {
                logger_1.default.error('ScaleManager: [SERIAL] Init Exception:', err.message);
                done();
            }
        });
    }
    startWatchdog() {
        if (this.watchdogInterval)
            clearInterval(this.watchdogInterval);
        // Reset last data time to give it a chance
        this.lastDataTime = Date.now();
        this.watchdogInterval = setInterval(() => {
            const timeSinceLastData = Date.now() - this.lastDataTime;
            const timeout = 3000; // 3 seconds timeout
            // If we are 'connected' but haven't seen data for timeout
            if (this.status === 'connected' && timeSinceLastData > timeout) {
                console.log('ScaleManager: Watchdog - Data timeout, setting status to connecting...');
                this.emitStatus('connecting');
            }
        }, 1000);
    }
    connectTcp(config) {
        if (!config.host || !config.port)
            return;
        this.tcpClient = new net_1.default.Socket();
        this.tcpClient.connect(config.port, config.host, () => {
            console.log('TCP Connected');
            this.emitStatus('connecting');
            this.startPolling();
            this.startWatchdog();
        });
        this.tcpClient.on('data', (data) => this.handleData(data));
        this.tcpClient.on('error', (err) => this.emitError(err.message));
        this.tcpClient.on('close', () => this.emitStatus('disconnected'));
    }
    startPolling() {
        logger_1.default.info(`ScaleManager: [POLLING] startPolling called. Type: ${this.config?.type}, Protocol: ${this.currentProtocol?.id}`);
        if (this.pollingInterval) {
            logger_1.default.info('ScaleManager: [POLLING] Clearing existing interval');
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
        if (!this.currentProtocol) {
            logger_1.default.warn('ScaleManager: [POLLING] No protocol selected, skipping');
            return;
        }
        if (!this.currentProtocol.pollingRequired && this.config?.type !== 'simulator') {
            logger_1.default.info(`ScaleManager: [POLLING] Protocol ${this.currentProtocol.name} does not require polling`);
            return;
        }
        const interval = this.config?.pollingInterval || 500;
        const cmd = this.currentProtocol.getWeightCommand ? this.currentProtocol.getWeightCommand() : null;
        logger_1.default.info(`ScaleManager: [POLLING] Starting interval: ${interval}ms. Cmd: ${!!cmd}, Window: ${!!this.mainWindow}`);
        this.pollingInterval = setInterval(() => {
            if (this.config?.type === 'serial' && this.scalePort?.isOpen && cmd) {
                this.scalePort.write(cmd, (err) => {
                    if (err)
                        logger_1.default.error('ScaleManager: [POLLING] Serial Write error:', err);
                });
            }
            else if (this.config?.type === 'tcp' && this.tcpClient && !this.tcpClient.destroyed && cmd) {
                this.tcpClient.write(cmd);
            }
            else if (this.config?.type === 'simulator') {
                try {
                    // Occasionally drop weight to zero so auto-print can reset
                    const shouldBeZero = Math.random() > 0.8;
                    const randomWeight = shouldBeZero ? "0.000" : (Math.random() * 5 + 0.5).toFixed(3);
                    const isStable = Math.random() > 0.2;
                    const reading = {
                        weight: parseFloat(randomWeight),
                        unit: 'kg',
                        stable: isStable
                    };
                    if (this.mainWindow) {
                        this.lastDataTime = Date.now(); // Update watchdog
                        this.mainWindow.webContents.send('scale-reading', reading);
                    }
                    else {
                        // Very important log: why the simulator might look dead
                        logger_1.default.warn('ScaleManager: [POLLING] Simulator active but mainWindow is NULL');
                    }
                }
                catch (e) {
                    logger_1.default.error('ScaleManager: [POLLING] Simulator error:', e);
                }
            }
        }, interval);
    }
    handleData(data) {
        // const hex = data.toString('hex').toUpperCase();
        // log.debug(`ScaleManager: [RAW DATA] ${hex}`);
        if (!this.currentProtocol)
            return;
        const reading = this.currentProtocol.parse(data);
        if (reading) {
            // Valid data received
            this.lastDataTime = Date.now();
            if (this.status !== 'connected') {
                this.emitStatus('connected');
            }
            const isStable = this.checkStability(reading.weight, reading.stable);
            reading.stable = isStable;
            this.mainWindow?.webContents.send('scale-reading', reading);
            // reset status to connecting if handled check is done outside? 
            // no, watchdog handles timeouts.
        }
    }
    checkStability(weight, protocolReportedStable) {
        this.recentReadings.push(weight);
        if (this.recentReadings.length > this.STABILITY_COUNT) {
            this.recentReadings.shift();
        }
        if (this.recentReadings.length < this.STABILITY_COUNT)
            return protocolReportedStable;
        const min = Math.min(...this.recentReadings);
        const max = Math.max(...this.recentReadings);
        const isSoftwareStable = (max - min) <= this.STABILITY_THRESHOLD;
        return protocolReportedStable || isSoftwareStable;
    }
    async disconnect() {
        logger_1.default.info('ScaleManager: Disconnecting...');
        if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout);
            this.connectionTimeout = null;
        }
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
        if (this.watchdogInterval) {
            clearInterval(this.watchdogInterval);
            this.watchdogInterval = null;
        }
        if (this.scalePort) {
            const port = this.scalePort;
            this.scalePort = null;
            if (port.isOpen) {
                logger_1.default.info('ScaleManager: Closing serial port...');
                await new Promise((resolve) => {
                    const timeout = setTimeout(() => {
                        logger_1.default.warn('ScaleManager: Disconnect TIMEOUT - forcing resolution');
                        resolve();
                    }, 2000);
                    port.close((err) => {
                        clearTimeout(timeout);
                        if (err)
                            logger_1.default.error('ScaleManager: Error closing port:', err);
                        port.removeAllListeners();
                        resolve();
                    });
                });
            }
            else {
                port.removeAllListeners();
            }
        }
        if (this.tcpClient && !this.tcpClient.destroyed) {
            this.tcpClient.destroy();
            this.tcpClient = null;
        }
    }
    emitStatus(status) {
        this.status = status;
        this.mainWindow?.webContents.send('scale-status', status);
    }
    emitError(msg) {
        this.mainWindow?.webContents.send('scale-error', msg);
    }
}
exports.scaleManager = new ScaleManager();
