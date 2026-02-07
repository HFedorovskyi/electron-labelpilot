import { type ScaleProtocol, type ScaleReading } from './types';

// Massa-K Protocol 100 (Binary Packet) - Aligned with User Emulator
// Request: [F8 55 CE] [LEN_L] [LEN_H] [CMD=A0] [CRC_L] [CRC_H] ... (8 bytes total read by emulator)
// Response: [F8 55 CE] [LEN=7] [CMD=10] [Weight(4)] [Div] [Stable] [CRC(2)]

export const MassaK_100: ScaleProtocol = {
    id: 'massak_100',
    name: 'Massa-K (Protocol 100)',
    description: 'Binary protocol for Massa-K terminals',
    pollingRequired: true,
    defaultBaudRate: 9600, // Emulator uses 19200, but default here is just hint

    getWeightCommand: () => {
        // Emulator expects 8 bytes, starts with F8 55 CE, and byte[5] == 0xA0
        // We pad to 8 bytes.
        return Buffer.from([0xF8, 0x55, 0xCE, 0x01, 0x00, 0xA0, 0x00, 0x00]);
    },

    parse: (data: Buffer | string): ScaleReading | null => {
        if (typeof data === 'string') return null;

        // Emulator response is 14 bytes
        // Header: F8 55 CE (3)
        // Len: 07 00 (2) -> 7 bytes of data following
        // Data: [10] [W W W W] [Div] [St] (7 bytes)
        // CRC: [C C] (2)
        // Total: 3 + 2 + 7 + 2 = 14 bytes

        // We might receive chunks, but let's assume complete packet for now or find the header
        if (data.length < 14) return null;

        // Find Header
        const headerIdx = data.indexOf(Buffer.from([0xF8, 0x55, 0xCE]));
        if (headerIdx === -1) return null;

        const pkt = data.subarray(headerIdx);
        if (pkt.length < 14) return null;

        // Parse Weight (Offset 3+2+1 = 6)
        // Python: struct.pack('<i', self.current_weight) -> Little Endian 4-byte Int
        const weightRaw = pkt.readInt32LE(6);

        // Parse Division (Offset 10)
        // const division = pkt.readUInt8(10); // Not using yet

        // Parse Stable (Offset 11)
        const stableFlag = pkt.readUInt8(11);
        const isStable = stableFlag === 1;

        // Emulator sends weight in grams (e.g. 12450 for 12.45kg) if division is small?
        // User code: self.current_weight = 12450. 
        // We probably need to divide by 1000 for kg if it's raw units.
        // Let's assume grams given the value size.
        const weightKg = weightRaw / 1000.0;

        return {
            weight: weightKg,
            unit: 'kg',
            stable: isStable
        };
    }
};

// Massa-K Lite (Text based, simpler)
export const MassaK_Lite: ScaleProtocol = {
    id: 'massak_lite',
    name: 'Massa-K (Lite)',
    description: 'Simple text protocol',
    pollingRequired: true,
    defaultBaudRate: 9600,

    getWeightCommand: () => Buffer.from([0x45]), // 'E'

    parse: (data: Buffer | string): ScaleReading | null => {
        const str = data.toString();
        const match = str.match(/(\d+\.\d+)/);
        if (match) {
            return {
                weight: parseFloat(match[1]),
                unit: 'kg',
                stable: false // Protocol might not indicate stability clearly in lite mode
            };
        }
        return null;
    }
};
