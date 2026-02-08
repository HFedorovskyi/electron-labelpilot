import type { ScaleProtocol, ScaleReading } from './types';

export const CAS_Simple: ScaleProtocol = {
    id: 'cas_simple',
    name: 'CAS (Simple/PDS)',
    description: 'Standard CAS protocol (AD-1, ER, SW models)',
    pollingRequired: true,
    defaultBaudRate: 9600,

    getWeightCommand: () => Buffer.from('W'), // Some models use 'W' to request weight

    parse: (data: Buffer | string): ScaleReading | null => {
        const text = data.toString().trim();
        // CAS format often looks like: "ST,GS,+  1.500kg" or "US,GS,+  1.500kg"
        // ST = Stable, US = Unstable

        // Regex to match: (ST|US),... (Weight) (Unit)
        // This is a heuristic parser for common CAS formats
        const match = text.match(/([A-Z]{2}),.*,([+|\-]?\s*\d+\.\d+)([a-zA-Z]+)/);

        if (match) {
            const status = match[1]; // ST or US
            const weightVal = parseFloat(match[2].replace(/\s/g, ''));
            const unit = match[3].toLowerCase();

            return {
                weight: weightVal,
                unit: unit === 'kg' || unit === 'g' || unit === 'lb' ? unit : 'kg',
                stable: status === 'ST'
            };
        }
        return null;
    }
};
