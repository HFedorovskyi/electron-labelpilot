import { SerialPort } from 'serialport';
import net from 'net';
import { BrowserWindow } from 'electron';
import { PROTOCOLS, type ScaleProtocol, type ScaleReading, getProtocol } from './protocols';
import { loadScaleConfig, saveScaleConfig, type ScaleConfig } from './config';

class ScaleManager {
    private scalePort: SerialPort | null = null;
    private tcpClient: net.Socket | null = null;
    private mainWindow: BrowserWindow | null = null;
    private currentProtocol: ScaleProtocol | null = null;
    private pollingInterval: NodeJS.Timeout | null = null;
    private config: ScaleConfig | null = null;

    // Stability Logic
    private recentReadings: number[] = [];
    private STABILITY_THRESHOLD = 0.005; // deviation
    private STABILITY_COUNT = 5;

    constructor() {
        this.config = loadScaleConfig();
    }

    public init() {
        // Auto-connect on startup if configured
        if (this.config) {
            console.log('ScaleManager: Auto-connecting with saved config...');
            this.connect(this.config);
        }
    }

    public setMainWindow(window: BrowserWindow) {
        this.mainWindow = window;
    }

    public getConfig() {
        return this.config;
    }

    public saveAndConnect(config: ScaleConfig) {
        saveScaleConfig(config);
        this.connect(config);
    }

    public async listPorts() {
        return await SerialPort.list();
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

    public connect(config: ScaleConfig) {
        this.disconnect();
        this.config = config;
        this.currentProtocol = getProtocol(config.protocolId);

        console.log(`ScaleManager: Connecting to ${config.type} using ${this.currentProtocol.name}`);
        this.emitStatus('reconnecting');

        if (config.type === 'serial') {
            this.connectSerial(config);
        } else if (config.type === 'simulator') {
            this.emitStatus('connected');
            this.startPolling();
        } else {
            this.connectTcp(config);
        }
    }

    private connectSerial(config: ScaleConfig) {
        if (!config.path) {
            console.error('ScaleManager: No serial path provided');
            return;
        }

        try {
            console.log(`ScaleManager: Opening serial port ${config.path} at ${config.baudRate || 9600}`);
            this.scalePort = new SerialPort({
                path: config.path,
                baudRate: config.baudRate || this.currentProtocol?.defaultBaudRate || 9600
            });

            this.scalePort.on('open', () => {
                console.log(`ScaleManager: Port ${config.path} OPENED`);
                // Status is 'connecting' until first data
                this.emitStatus('connecting');
                this.startPolling();
                this.startWatchdog();
            });

            this.scalePort.on('data', (data) => {
                this.handleData(data);
            });

            this.scalePort.on('error', (err) => {
                console.error('ScaleManager: Serial Port Error:', err.message);
                this.emitError(err.message);
            });

            this.scalePort.on('close', () => {
                console.log('ScaleManager: Port CLOSED');
                this.emitStatus('disconnected');
            });


        } catch (err: any) {
            console.error('ScaleManager: Failed to create SerialPort:', err.message);
            this.emitError(err.message);
        }
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

    public disconnect() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }

        if (this.watchdogInterval) {
            clearInterval(this.watchdogInterval);
            this.watchdogInterval = null;
        }

        if (this.scalePort?.isOpen) {
            this.scalePort.removeAllListeners();
            this.scalePort.close();
            this.scalePort = null;
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
