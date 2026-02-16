import { SerialPort } from 'serialport';
import net from 'net';
import { BrowserWindow } from 'electron';
import { PROTOCOLS, type ScaleProtocol, type ScaleReading, getProtocol } from './protocols';
import { loadScaleConfig, saveScaleConfig, type ScaleConfig } from './config';
import log from './logger';

class ScaleManager {
    private scalePort: SerialPort | null = null;
    private tcpClient: net.Socket | null = null;
    private mainWindow: BrowserWindow | null = null;
    private currentProtocol: ScaleProtocol | null = null;
    private pollingInterval: NodeJS.Timeout | null = null;
    private config: ScaleConfig | null = null;
    private isConnecting: boolean = false;

    // Stability Logic
    private recentReadings: number[] = [];
    private STABILITY_THRESHOLD = 0.005; // deviation
    private STABILITY_COUNT = 5;

    constructor() {
        this.config = loadScaleConfig();
    }

    public async init() {
        // Auto-connect on startup if configured
        if (this.config) {
            log.info('ScaleManager: Auto-connecting with saved config...', JSON.stringify(this.config));
            await this.connect(this.config);
        }
    }

    public setMainWindow(window: BrowserWindow) {
        this.mainWindow = window;
    }

    public getConfig() {
        return this.config;
    }

    public async saveAndConnect(config: ScaleConfig) {
        saveScaleConfig(config);
        await this.connect(config);
    }

    public async listPorts() {
        const startTime = Date.now();
        log.info('[ScaleManager] listPorts started');
        try {
            const ports = await SerialPort.list();
            log.info(`[ScaleManager] listPorts finished. Found ${ports.length} ports:`);
            ports.forEach(p => {
                log.info(`  - ${p.path}: ${p.manufacturer || 'Unknown'} (${p.pnpId || ''})`);
            });
            return ports;
        } catch (e) {
            log.error(`[ScaleManager] listPorts FAILED in ${Date.now() - startTime}ms:`, e);
            throw e;
        }
    }

    public getStatus() {
        return this.status;
    }

    private status: string = 'disconnected';

    public getProtocols() {
        return Object.values(PROTOCOLS).map(p => ({
            id: p.id,
            name: p.name,
            description: p.description
        }));
    }

    private lastDataTime: number = 0;
    private watchdogInterval: NodeJS.Timeout | null = null;

    public async connect(config: ScaleConfig) {
        if (this.isConnecting) {
            log.info('ScaleManager: Already connecting, skipping...');
            return;
        }
        this.isConnecting = true;

        try {
            await this.disconnect();
            this.config = config;
            this.currentProtocol = getProtocol(config.protocolId);

            console.log(`ScaleManager: Connecting to ${config.type} using ${this.currentProtocol.name}`);
            this.emitStatus('reconnecting');

            if (config.type === 'serial') {
                await this.connectSerial(config);
            } else if (config.type === 'simulator') {
                this.emitStatus('connected');
                this.startPolling();
            } else {
                this.connectTcp(config);
            }
        } finally {
            this.isConnecting = false;
        }
    }

    private async connectSerial(config: ScaleConfig) {
        const path = config.path;
        if (!path) {
            console.error('ScaleManager: No serial path provided');
            return;
        }

        return new Promise<void>((resolve) => {
            try {
                const baudRate = config.baudRate || this.currentProtocol?.defaultBaudRate || 9600;
                const parity = this.currentProtocol?.parity || 'none';
                const dataBits = this.currentProtocol?.dataBits || 8;
                const stopBits = this.currentProtocol?.stopBits || 1;

                log.info(`ScaleManager: Opening ${path} (${baudRate}, ${dataBits}, ${parity}, ${stopBits})`);

                this.scalePort = new SerialPort({
                    path: path,
                    baudRate: baudRate,
                    parity: parity as any,
                    dataBits: dataBits as any,
                    stopBits: stopBits as any,
                    autoOpen: false,
                    rtscts: false, // Explicitly disable hardware flow control
                });

                this.scalePort.on('open', () => {
                    log.info(`ScaleManager: Port ${path} OPENED`);

                    // Set control signals (often required for USB adapters and Massa-K)
                    this.scalePort?.set({ dtr: true, rts: true }, (err) => {
                        if (err) log.error('ScaleManager: Error setting DTR/RTS:', err.message);
                        else {
                            log.info('ScaleManager: DTR/RTS signals set to TRUE');
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
                            log.info('ScaleManager: Starting polling after stabilization delay');
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
                    log.error('ScaleManager: Serial Port Error:', err.message);

                    // Specific error handling for "Access denied"
                    if (err.message.includes('Access denied')) {
                        this.emitError(`serial_access_denied|${config.path}`);
                    } else if (err.message.includes('File not found')) {
                        this.emitError(`serial_not_found|${config.path}`);
                    } else {
                        this.emitError(err.message);
                    }
                    resolve(); // Resolve anyway to unlock isConnecting, error is handled by listeners
                });

                this.scalePort.on('close', () => {
                    log.info('ScaleManager: Port CLOSED');
                    this.emitStatus('disconnected');
                });

                this.scalePort.open((err) => {
                    if (err) {
                        log.error('ScaleManager: Immediate Open Error:', err.message);
                        // Handled by 'error' listener
                    }
                });


            } catch (err: any) {
                console.error('ScaleManager: Failed to create SerialPort:', err.message);
                this.emitError(err.message);
                resolve();
            }
        });
    }

    private startWatchdog() {
        if (this.watchdogInterval) clearInterval(this.watchdogInterval);

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

    private connectTcp(config: ScaleConfig) {
        if (!config.host || !config.port) return;

        this.tcpClient = new net.Socket();
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

    private startPolling() {
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
                    log.debug('ScaleManager: Sending Hex:', cmd.toString('hex').toUpperCase());
                } else {
                    log.debug('ScaleManager: Sending Text:', cmd);
                }
                this.scalePort.write(cmd, (err) => {
                    if (err) console.error('ScaleManager: Write error:', err);
                });
            } else if (this.config?.type === 'tcp' && this.tcpClient && !this.tcpClient.destroyed) {
                this.tcpClient.write(cmd);
            } else if (this.config?.type === 'simulator') {
                const randomWeight = (Math.random() * 10 + 1).toFixed(3);
                const isStable = Math.random() > 0.3;
                const reading: ScaleReading = {
                    weight: parseFloat(randomWeight),
                    unit: 'kg',
                    stable: isStable
                };
                this.mainWindow?.webContents.send('scale-reading', reading);
            }
        }, interval);
    }

    private handleData(data: Buffer) {
        const hex = data.toString('hex').toUpperCase();
        log.debug(`ScaleManager: [RAW DATA] ${hex}`);

        if (!this.currentProtocol) return;

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

    private checkStability(weight: number, protocolReportedStable: boolean): boolean {
        this.recentReadings.push(weight);
        if (this.recentReadings.length > this.STABILITY_COUNT) {
            this.recentReadings.shift();
        }

        if (this.recentReadings.length < this.STABILITY_COUNT) return protocolReportedStable;

        const min = Math.min(...this.recentReadings);
        const max = Math.max(...this.recentReadings);

        const isSoftwareStable = (max - min) <= this.STABILITY_THRESHOLD;

        return protocolReportedStable || isSoftwareStable;
    }

    public async disconnect() {
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
                log.info('ScaleManager: Closing serial port...');
                return new Promise<void>((resolve) => {
                    port.close((err) => {
                        if (err) log.error('ScaleManager: Error closing port:', err);
                        port.removeAllListeners();
                        resolve();
                    });
                });
            } else {
                port.removeAllListeners();
            }
        }

        if (this.tcpClient && !this.tcpClient.destroyed) {
            this.tcpClient.destroy();
            this.tcpClient = null;
        }
    }

    private emitStatus(status: string) {
        this.status = status;
        this.mainWindow?.webContents.send('scale-status', status);
    }

    private emitError(msg: string) {
        this.mainWindow?.webContents.send('scale-error', msg);
    }
}

export const scaleManager = new ScaleManager();
