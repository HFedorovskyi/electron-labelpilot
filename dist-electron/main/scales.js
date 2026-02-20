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
    isConnecting = false;
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
        this.mainWindow = window;
    }
    getConfig() {
        return this.config;
    }
    async saveAndConnect(config) {
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
        if (this.isConnecting) {
            logger_1.default.info('ScaleManager: Already connecting, skipping...');
            return;
        }
        this.isConnecting = true;
        try {
            await this.disconnect();
            this.config = config;
            this.currentProtocol = (0, protocols_1.getProtocol)(config.protocolId);
            console.log(`ScaleManager: Connecting to ${config.type} using ${this.currentProtocol.name}`);
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
        }
        finally {
            this.isConnecting = false;
        }
    }
    async connectSerial(config) {
        const path = config.path;
        if (!path) {
            console.error('ScaleManager: No serial path provided');
            return;
        }
        return new Promise((resolve) => {
            try {
                const baudRate = config.baudRate || this.currentProtocol?.defaultBaudRate || 9600;
                const parity = this.currentProtocol?.parity || 'none';
                const dataBits = this.currentProtocol?.dataBits || 8;
                const stopBits = this.currentProtocol?.stopBits || 1;
                logger_1.default.info(`ScaleManager: Opening ${path} (${baudRate}, ${dataBits}, ${parity}, ${stopBits})`);
                this.scalePort = new serialport_1.SerialPort({
                    path: path,
                    baudRate: baudRate,
                    parity: parity,
                    dataBits: dataBits,
                    stopBits: stopBits,
                    autoOpen: false,
                    rtscts: false, // Explicitly disable hardware flow control
                });
                this.scalePort.on('open', () => {
                    logger_1.default.info(`ScaleManager: Port ${path} OPENED`);
                    // Set control signals (often required for USB adapters and Massa-K)
                    this.scalePort?.set({ dtr: true, rts: true }, (err) => {
                        if (err)
                            logger_1.default.error('ScaleManager: Error setting DTR/RTS:', err.message);
                        else {
                            logger_1.default.info('ScaleManager: DTR/RTS signals set to TRUE');
                            // Experimental: pulse DTR after open
                            setTimeout(() => {
                                this.scalePort?.set({ dtr: false }, () => {
                                    setTimeout(() => this.scalePort?.set({ dtr: true }), 50);
                                });
                            }, 100);
                        }
                    });
                    // Status is 'connecting' until first data
                    this.emitStatus('connecting');
                    // Delay polling slightly to allow signals to stabilize
                    setTimeout(() => {
                        if (this.scalePort?.isOpen) {
                            logger_1.default.info('ScaleManager: Starting polling after stabilization delay');
                            this.startPolling();
                            this.startWatchdog();
                        }
                    }, 200);
                    resolve();
                });
                this.scalePort.on('data', (data) => {
                    this.handleData(data);
                });
                this.scalePort.on('error', (err) => {
                    logger_1.default.error('ScaleManager: Serial Port Error:', err.message);
                    // Specific error handling for "Access denied"
                    if (err.message.includes('Access denied')) {
                        this.emitError(`serial_access_denied|${config.path}`);
                    }
                    else if (err.message.includes('File not found')) {
                        this.emitError(`serial_not_found|${config.path}`);
                    }
                    else {
                        this.emitError(err.message);
                    }
                    resolve(); // Resolve anyway to unlock isConnecting, error is handled by listeners
                });
                this.scalePort.on('close', () => {
                    logger_1.default.info('ScaleManager: Port CLOSED');
                    this.emitStatus('disconnected');
                });
                this.scalePort.open((err) => {
                    if (err) {
                        logger_1.default.error('ScaleManager: Immediate Open Error:', err.message);
                        // Handled by 'error' listener
                    }
                });
            }
            catch (err) {
                console.error('ScaleManager: Failed to create SerialPort:', err.message);
                this.emitError(err.message);
                resolve();
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
        if (!this.currentProtocol) {
            console.log('ScaleManager: No protocol selected, skipping polling');
            return;
        }
        if (!this.currentProtocol.pollingRequired) {
            console.log(`ScaleManager: Protocol ${this.currentProtocol.name} does not require polling`);
            return;
        }
        if (!this.currentProtocol.getWeightCommand) {
            console.log(`ScaleManager: Protocol ${this.currentProtocol.name} has no weight command`);
            return;
        }
        const interval = this.config?.pollingInterval || 500;
        const cmd = this.currentProtocol.getWeightCommand();
        console.log(`ScaleManager: Starting polling every ${interval}ms using command:`, cmd);
        this.pollingInterval = setInterval(() => {
            if (this.config?.type === 'serial' && this.scalePort?.isOpen) {
                if (cmd instanceof Buffer) {
                    // log.debug('ScaleManager: Sending Hex:', cmd.toString('hex').toUpperCase());
                }
                else {
                    // log.debug('ScaleManager: Sending Text:', cmd);
                }
                this.scalePort.write(cmd, (err) => {
                    if (err)
                        console.error('ScaleManager: Write error:', err);
                });
            }
            else if (this.config?.type === 'tcp' && this.tcpClient && !this.tcpClient.destroyed) {
                this.tcpClient.write(cmd);
            }
            else if (this.config?.type === 'simulator') {
                const randomWeight = (Math.random() * 10 + 1).toFixed(3);
                const isStable = Math.random() > 0.3;
                const reading = {
                    weight: parseFloat(randomWeight),
                    unit: 'kg',
                    stable: isStable
                };
                this.mainWindow?.webContents.send('scale-reading', reading);
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
                return new Promise((resolve) => {
                    port.close((err) => {
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
