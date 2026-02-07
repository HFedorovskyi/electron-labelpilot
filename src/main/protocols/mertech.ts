import { type ScaleProtocol, type ScaleReading } from './types';

export const Mertech: ScaleProtocol = {
    id: 'mertech',
    name: 'Mertech',
    description: 'Universal Mertech Protocol',
    pollingRequired: true,
    defaultBaudRate: 115200,

    getWeightCommand: () => Buffer.from('W'),

    parse: (data: Buffer | string): ScaleReading | null => {
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
