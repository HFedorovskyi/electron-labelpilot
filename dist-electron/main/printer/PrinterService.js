"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.printerService = void 0;
const config_1 = require("../config");
const strategies_1 = require("./strategies");
const generator_1 = require("./generator");
class PrinterService {
    strategies = new Map();
    states = new Map();
    mainWindow = null;
    constructor() {
        // Defer initialization to ensure app is ready if needed, 
        // or just init here.
        setTimeout(() => this.initializeStrategies(), 1000);
    }
    setMainWindow(window) {
        this.mainWindow = window;
    }
    reloadConfig() {
        this.initializeStrategies();
    }
    initializeStrategies() {
        const startTime = Date.now();
        console.log('[PrinterService] initializeStrategies started');
        const config = (0, config_1.loadPrinterConfig)();
        this.initDevice(config.packPrinter);
        this.initDevice(config.boxPrinter);
        console.log(`[PrinterService] initializeStrategies finished in ${Date.now() - startTime}ms`);
    }
    initDevice(config) {
        // 1. Cleanup old strategy if exists
        if (this.strategies.has(config.id)) {
            // In a real app we might want to disconnect first
            const old = this.strategies.get(config.id);
            old?.disconnect().catch(console.error);
            this.strategies.delete(config.id);
        }
        // 2. Create new strategy
        let strategy = null;
        switch (config.connection) {
            case 'tcp':
                strategy = new strategies_1.TcpStrategy();
                break;
            case 'serial':
                strategy = new strategies_1.SerialStrategy();
                break;
            case 'windows_driver':
                strategy = new strategies_1.SpoolerStrategy();
                break;
        }
        if (strategy) {
            this.strategies.set(config.id, strategy);
        }
        // 3. Update State
        this.updateDeviceState(config.id, {
            config: config,
            status: 'disconnected'
        });
        // 4. Auto-connect if active
        // if (config.active && strategy) {
        //     strategy.connect(config).then(...).catch(...);
        // }
    }
    updateDeviceState(id, state) {
        this.states.set(id, state);
        if (this.mainWindow) {
            this.mainWindow.webContents.send('printer-status-update', { id, status: state.status });
        }
    }
    async print(printerId, data) {
        const strategy = this.strategies.get(printerId);
        const state = this.states.get(printerId);
        if (!strategy || !state) {
            throw new Error(`Printer ${printerId} not found or not configured`);
        }
        try {
            if (!strategy.isConnected()) {
                console.log(`Connecting to ${state.config.name} (${state.config.connection})...`);
                await strategy.connect(state.config);
                this.updateDeviceState(printerId, { ...state, status: 'connected' });
            }
            console.log(`Sending ${data.length} bytes to ${state.config.name}...`);
            await strategy.send(data);
            console.log('Print success');
        }
        catch (error) {
            console.error(`Print failed for ${printerId}: `, error);
            this.updateDeviceState(printerId, { ...state, status: 'error', lastError: String(error) });
            // Try to disconnect to reset state
            try {
                await strategy.disconnect();
            }
            catch (e) { /* ignore */ }
            throw error;
        }
    }
    async testPrint(config) {
        let strategy = null;
        switch (config.connection) {
            case 'tcp':
                strategy = new strategies_1.TcpStrategy();
                break;
            case 'serial':
                strategy = new strategies_1.SerialStrategy();
                break;
            case 'windows_driver':
                strategy = new strategies_1.SpoolerStrategy();
                break;
        }
        if (!strategy)
            throw new Error('Invalid connection type');
        try {
            await strategy.connect(config);
            // Generate Test ZPL
            // Simple ZPL for now, just to test connection
            const zpl = `
    ^ XA
    ^ FO50, 50 ^ A0N, 50, 50 ^ FDTest Print ^ FS
        ^ FO50, 120 ^ A0N, 30, 30 ^ FD${config.name}^ FS
            ^ FO50, 160 ^ A0N, 30, 30 ^ FD${config.connection}^ FS
                ^ FO50, 220 ^ BY3, 3, 100 ^ BCN, 100, Y, N, N ^ FDTEST123456 ^ FS
                ^ XZ`;
            await strategy.send(Buffer.from(zpl));
        }
        finally {
            try {
                await strategy.disconnect();
            }
            catch (e) {
                console.error('Error disconnecting test strategy', e);
            }
        }
    }
    async printLabel(config, doc, data) {
        // 1. Generate ZPL
        const generator = new generator_1.ZplGenerator();
        const zplBuffer = await generator.generate(doc, data, {
            dpi: config.dpi || 203,
            darkness: config.darkness,
            printSpeed: config.printSpeed,
            widthMm: config.widthMm,
            heightMm: config.heightMm
        });
        // 2. Send via Strategy
        let strategy = null;
        switch (config.connection) {
            case 'tcp':
                strategy = new strategies_1.TcpStrategy();
                break;
            case 'serial':
                strategy = new strategies_1.SerialStrategy();
                break;
            case 'windows_driver':
                strategy = new strategies_1.SpoolerStrategy();
                break;
        }
        if (!strategy)
            throw new Error('Invalid connection type');
        try {
            await strategy.connect(config);
            await strategy.send(zplBuffer);
        }
        finally {
            try {
                await strategy.disconnect();
            }
            catch (e) {
                console.error('Error disconnecting strategy', e);
            }
        }
    }
}
exports.printerService = new PrinterService();
