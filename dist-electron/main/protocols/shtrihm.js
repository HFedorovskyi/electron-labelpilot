"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Shtrih_M = void 0;
exports.Shtrih_M = {
    id: 'shtrih_m',
    name: 'Shtrih-M (POS2)',
    description: 'Standard POS2 protocol',
    pollingRequired: true,
    defaultBaudRate: 9600,
    getWeightCommand: () => Buffer.from([0x02, 0x05, 0x39, 0x3E]), // Example command
    parse: (data) => {
        // Implementation for Shtrih-M parsing
        // Often sends weight in bytes 4-5
        // Placeholder for now, can perform basic text extraction if mode set to print
        const str = data.toString();
        const match = str.match(/(\d+\.\d+)/);
        if (match) {
            return {
                weight: parseFloat(match[1]),
                unit: 'kg',
                stable: true
            };
        }
        return null;
    }
};
