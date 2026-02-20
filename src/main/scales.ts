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
    private connectionTimeout: NodeJS.Timeout | null = null;
    private lastConnectId: number = 0;

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
        log.info('ScaleManager: setMainWindow called. Window exists:', !!window);
        this.mainWindow = window;
    }

    public getConfig() {
        return this.config;
    }

    public async saveAndConnect(config: ScaleConfig) {
        log.info('ScaleManager: saveAndConnect triggered:', JSON.stringify(config));
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
        const myId = ++this.lastConnectId;
        log.info(`ScaleManager: [CONNECT] START #${myId} (type: ${config.type}, protocol: ${config.protocolId})`);

        try {
            await this.disconnect();

            // Fencing check
            if (myId !== this.lastConnectId) {
                log.warn(`ScaleManager: [CONNECT] #${myId} superseded by #${this.lastConnectId}. Aborting.`);
                return;
            }

            this.config = config;
            this.currentProtocol = getProtocol(config.protocolId);

            log.info(`ScaleManager: [CONNECT] #${myId} Internal type: ${config.type}, Protocol: ${this.currentProtocol.name}`);
            this.emitStatus('reconnecting');

            if (config.type === 'serial') {
                await this.connectSerial(config);
            } else if (config.type === 'simulator') {
                this.emitStatus('connected');
                this.startPolling();
            } else {
                this.connectTcp(config);
            }

            // Final fencing check
            if (myId !== this.lastConnectId) {
                log.warn(`ScaleManager: [CONNECT] #${myId} superseded during connection. Ignoring results.`);
                return;
            }
        } catch (e) {
            log.error(`ScaleManager: [CONNECT] #${myId} ERROR:`, e);
            throw e;
        } finally {
            if (myId === this.lastConnectId) {
                log.info(`ScaleManager: [CONNECT] #${myId} FINISHED`);
            } else {
                log.info(`ScaleManager: [CONNECT] #${myId} cleanup finished.`);
            }
        }
    }

    private async connectSerial(config: ScaleConfig) {
        const path = config.path;
        if (!path) {
            log.error('ScaleManager: [SERIAL] No path provided');
            return;
        }

        return new Promise<void>((resolvePromise) => {
            let doneCalled = false;
            const done = () => {
                if (doneCalled) return;
                doneCalled = true;
                clearTimeout(connectionTimeout);
                resolvePromise();
            };

            const connectionTimeout = setTimeout(() => {
                log.warn(`ScaleManager: [SERIAL] Connection to ${path} TIMEOUT (5s)`);
                done();
            }, 5000);

            try {
                const baudRate = config.baudRate || this.currentProtocol?.defaultBaudRate || 9600;
                const parity = this.currentProtocol?.parity || 'none';
                const dataBits = this.currentProtocol?.dataBits || 8;
                const stopBits = this.currentProtocol?.stopBits || 1;

                log.info(`ScaleManager: [SERIAL] Opening ${path} (${baudRate}, ${dataBits}, ${parity}, ${stopBits})`);

                this.scalePort = new SerialPort({
                    path: path,
                    baudRate: baudRate,
                    parity: parity as any,
                    dataBits: dataBits as any,
                    stopBits: stopBits as any,
                    autoOpen: false,
                    rtscts: false,
                });

                this.scalePort.on('open', () => {
                    log.info(`ScaleManager: [SERIAL] Port ${path} OPENED`);

                    this.scalePort?.set({ dtr: true, rts: true }, (err) => {
                        if (err) log.error('ScaleManager: [SERIAL] Error setting DTR/RTS:', err.message);
                        else {
                            log.info('ScaleManager: [SERIAL] DTR/RTS signals set to TRUE');
                        }
                    });

                    this.emitStatus('connecting');
                    this.connectionTimeout = setTimeout(() => {
                        this.connectionTimeout = null;
                        if (this.scalePort?.isOpen) {
                            log.info('ScaleManager: [SERIAL] Starting polling after delay');
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
                    log.error('ScaleManager: [SERIAL] Port Error:', err.message);
                    if (err.message.includes('Access denied')) {
                        this.emitError(`serial_access_denied|${config.path}`);
                    } else if (err.message.includes('File not found')) {
                        this.emitError(`serial_not_found|${config.path}`);
                    } else {
                        this.emitError(err.message);
                    }
                    done();
                });

                this.scalePort.on('close', () => {
                    log.info('ScaleManager: [SERIAL] Port CLOSED');
                    this.emitStatus('disconnected');
                });

                this.scalePort.open((err) => {
                    if (err) {
                        log.error('ScaleManager: [SERIAL] Immediate Open Error:', err.message);
                    }
                });

            } catch (err: any) {
                log.error('ScaleManager: [SERIAL] Init Exception:', err.message);
                done();
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
        log.info(`ScaleManager: [POLLING] startPolling called. Type: ${this.config?.type}, Protocol: ${this.currentProtocol?.id}`);

        if (this.pollingInterval) {
            log.info('ScaleManager: [POLLING] Clearing existing interval');
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }

        if (!this.currentProtocol) {
            log.warn('ScaleManager: [POLLING] No protocol selected, skipping');
            return;
        }

        if (!this.currentProtocol.pollingRequired && this.config?.type !== 'simulator') {
            log.info(`ScaleManager: [POLLING] Protocol ${this.currentProtocol.name} does not require polling`);
            return;
        }

        const interval = this.config?.pollingInterval || 500;
        const cmd = this.currentProtocol.getWeightCommand ? this.currentProtocol.getWeightCommand() : null;

        log.info(`ScaleManager: [POLLING] Starting interval: ${interval}ms. Cmd: ${!!cmd}, Window: ${!!this.mainWindow}`);

        this.pollingInterval = setInterval(() => {
            if (this.config?.type === 'serial' && this.scalePort?.isOpen && cmd) {
                this.scalePort.write(cmd, (err) => {
                    if (err) log.error('ScaleManager: [POLLING] Serial Write error:', err);
                });
            } else if (this.config?.type === 'tcp' && this.tcpClient && !this.tcpClient.destroyed && cmd) {
                this.tcpClient.write(cmd);
            } else if (this.config?.type === 'simulator') {
                try {
                    // Occasionally drop weight to zero so auto-print can reset
                    const shouldBeZero = Math.random() > 0.8;
                    const randomWeight = shouldBeZero ? "0.000" : (Math.random() * 5 + 0.5).toFixed(3);

                    const isStable = Math.random() > 0.2;
                    const reading: ScaleReading = {
                        weight: parseFloat(randomWeight),
                        unit: 'kg',
                        stable: isStable
                    };
                    if (this.mainWindow) {
                        this.lastDataTime = Date.now(); // Update watchdog
                        this.mainWindow.webContents.send('scale-reading', reading);
                    } else {
                        // Very important log: why the simulator might look dead
                        log.warn('ScaleManager: [POLLING] Simulator active but mainWindow is NULL');
                    }
                } catch (e) {
                    log.error('ScaleManager: [POLLING] Simulator error:', e);
                }
            }
        }, interval);
    }

    private handleData(data: Buffer) {
        // const hex = data.toString('hex').toUpperCase();
        // log.debug(`ScaleManager: [RAW DATA] ${hex}`);

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
        log.info('ScaleManager: Disconnecting...');

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
                log.info('ScaleManager: Closing serial port...');
                await new Promise<void>((resolve) => {
                    const timeout = setTimeout(() => {
                        log.warn('ScaleManager: Disconnect TIMEOUT - forcing resolution');
                        resolve();
                    }, 2000);

                    port.close((err) => {
                        clearTimeout(timeout);
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
