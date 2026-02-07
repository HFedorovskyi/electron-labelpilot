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

    public getProtocols() {
        return Object.values(PROTOCOLS).map(p => ({
            id: p.id,
            name: p.name,
            description: p.description
        }));
    }

    public connect(config: ScaleConfig) {
        this.disconnect();
        this.config = config;
        this.currentProtocol = getProtocol(config.protocolId);

        console.log(`ScaleManager: Connecting to ${config.type} using ${this.currentProtocol.name}`);

        if (config.type === 'serial') {
            this.connectSerial(config);
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

            // Use delimiter if protocol is text-based generic, else raw
            // For now, raw flow is better for custom parsers
            this.scalePort.on('open', () => {
                console.log(`ScaleManager: Port ${config.path} OPENED`);
                this.emitStatus('connected');
                this.startPolling();
            });

            this.scalePort.on('data', (data) => {
                // console.log('ScaleManager: Data received', data); // too verbose?
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

    private connectTcp(config: ScaleConfig) {
        if (!config.host || !config.port) return;

        this.tcpClient = new net.Socket();
        this.tcpClient.connect(config.port, config.host, () => {
            console.log('TCP Connected');
            this.emitStatus('connected');
            this.startPolling();
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
                // console.log('ScaleManager: Sending poll command...');
                this.scalePort.write(cmd, (err) => {
                    if (err) console.error('ScaleManager: Write error:', err);
                });
            } else if (this.config?.type === 'tcp' && this.tcpClient && !this.tcpClient.destroyed) {
                this.tcpClient.write(cmd);
            } else if (this.config?.type === 'simulator') {
                // Simulator logic...
                const randomWeight = (Math.random() * 10 + 1).toFixed(3);
                const isStable = Math.random() > 0.3; // 70% stable
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
            // Apply software stability check if protocol doesn't enforce it
            // Or if we want double-check
            const isStable = this.checkStability(reading.weight, reading.stable);
            reading.stable = isStable;

            this.mainWindow?.webContents.send('scale-reading', reading);
        }
    }

    private checkStability(weight: number, protocolReportedStable: boolean): boolean {
        // Add to history
        this.recentReadings.push(weight);
        if (this.recentReadings.length > this.STABILITY_COUNT) {
            this.recentReadings.shift();
        }

        // If not enough data, use protocol flag
        if (this.recentReadings.length < this.STABILITY_COUNT) return protocolReportedStable;

        // Calculate variance (max - min)
        const min = Math.min(...this.recentReadings);
        const max = Math.max(...this.recentReadings);

        const isSoftwareStable = (max - min) <= this.STABILITY_THRESHOLD;

        // Trust hardware flag if true, otherwise check software
        // Or assume strictly AND? Let's use OR (hardware valid OR software valid)
        // Usually, hardware flag is authoritative.
        return protocolReportedStable || isSoftwareStable;
    }

    public disconnect() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }

        if (this.scalePort?.isOpen) {
            this.scalePort.close();
            this.scalePort = null;
        }

        if (this.tcpClient && !this.tcpClient.destroyed) {
            this.tcpClient.destroy();
            this.tcpClient = null;
        }
    }

    private emitStatus(status: string) {
        this.mainWindow?.webContents.send('scale-status', status);
    }

    private emitError(msg: string) {
        this.mainWindow?.webContents.send('scale-error', msg);
    }
}

export const scaleManager = new ScaleManager();
