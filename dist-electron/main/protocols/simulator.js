"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Simulator = void 0;
exports.Simulator = {
    id: 'simulator',
    name: 'Simulator (Virtual Scale)',
    description: 'Generates random weight and toggles stability',
    pollingRequired: true,
    defaultBaudRate: 9600,
    getWeightCommand: () => Buffer.from('SIM'),
    parse: (_data) => {
        // In a real simulator, we wouldn't parse *input* so much as generate output
        // but here ScaleManager writes 'SIM' -> and expects 'data' back?
        // Wait, ScaleManager writes to a port. If we have no port, we need a Mock Port.
        // Or, we handle 'simulator' type in ScaleManager special?
        // Actually, for simplicity, let's treat it as a protocol that understands "SIM"
        // But we need a Loopback port or similar.
        // EASIER: Make ScaleManager handle "simulator" type efficiently without SerialPort.
        return null;
    }
};
