import { ScaleProtocol, ScaleReading } from './types';

export const Mettler_SICS: ScaleProtocol = {
    id: 'mettler_sics',
    name: 'Mettler Toledo (SICS)',
    description: 'Standard Interface Command Set',
    pollingRequired: true,
    defaultBaudRate: 9600,

    getWeightCommand: () => Buffer.from('S\r\n'), // 'S' command requests stable weight

    parse: (data: Buffer | string): ScaleReading | null => {
        const text = data.toString().trim();
        // Response: "S S    100.00 g" (Stable) or "S D    100.00 g" (Dynamic/Unstable)

        const parts = text.split(/\s+/);
        if (parts.length >= 3 && parts[0] === 'S') {
            const status = parts[1]; // S = Stable, D = Dynamic, I = Invalid
            const weight = parseFloat(parts[2]);
            const unit = parts[3]?.toLowerCase();

            if (status === 'I') return null;

            return {
                weight: weight,
                unit: unit === 'kg' || unit === 'g' || unit === 'lb' ? unit : 'kg',
                stable: status === 'S'
            };
        }
        return null;
    }
};
