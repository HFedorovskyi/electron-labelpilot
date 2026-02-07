"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Massa_K = void 0;
exports.Massa_K = {
    id: 'massa_k',
    name: 'Massa-K',
    description: 'Common protocol for Massa-K scales (100 response)',
    pollingRequired: true,
    defaultBaudRate: 4800,
    // Massa-K often responds to 0x45 (Request measurement) or specialized binary packets
    // For this implementation, we assume a text-based variant or specific byte command
    // Command 0x3F (63 dec) or 0x43 (67 dec) is common. Using 0x43 (C) here as placeholder.
    getWeightCommand: () => Buffer.from([0x43]), // 'C'
    parse: (data) => {
        // Example logic for binary or mixed protocol
        // Assuming simplistic text for now as exact binary spec varies by model version
        // Many Massa-k interact over Modbus-like or custom binary.
        // If buffer length is sufficient and signature matches (e.g. ends with CRC)
        // Here implementing a generic parser that looks for numeric + unit
        const text = data.toString();
        // "12.345 kg"
        const match = text.match(/(\d+\.\d+)\s*(kg|g)/i);
        if (match) {
            return {
                weight: parseFloat(match[1]),
                unit: match[2].toLowerCase(),
                stable: true // Massa-K often sends only stable by default if configured
            };
        }
        return null;
    }
};
