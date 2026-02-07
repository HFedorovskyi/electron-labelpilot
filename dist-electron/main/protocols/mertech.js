"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Mertech = void 0;
exports.Mertech = {
    id: 'mertech',
    name: 'Mertech',
    description: 'Universal Mertech Protocol',
    pollingRequired: true,
    defaultBaudRate: 115200,
    getWeightCommand: () => Buffer.from('W'),
    parse: (data) => {
        const text = data.toString();
        // Mertech format often: [STX]Weight[CR]
        const match = text.match(/(\d+\.\d+)/);
        if (match) {
            return {
                weight: parseFloat(match[1]),
                unit: 'kg',
                stable: text.includes('S') // Example stability flag
            };
        }
        return null;
    }
};
