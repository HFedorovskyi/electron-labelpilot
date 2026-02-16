"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MassaK_J = exports.MassaK_A_TB_P = exports.MassaK_Continuous = exports.MassaK_A_TB = exports.MassaK_Lite = exports.MassaK_Protocol1 = exports.MassaK_100 = void 0;
// Massa-K Protocol 100 (Binary Packet) - Aligned with User Emulator
// Request: [F8 55 CE] [LEN_L] [LEN_H] [CMD=A0] [CRC_L] [CRC_H] ... (8 bytes total read by emulator)
// Response: [F8 55 CE] [LEN=7] [CMD=10] [Weight(4)] [Div] [Stable] [CRC(2)]
// Helper for Massa-K CRC16 (Reflected, Poly: 0x8005, Init: 0xFFFF)
function calculateCRC16(data) {
    let crc = 0xFFFF;
    for (const byte of data) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) {
            if (crc & 0x0001) {
                crc = (crc >> 1) ^ 0xA001; // 0xA001 is reflected 0x8005
            }
            else {
                crc >>= 1;
            }
        }
    }
    return crc;
}
// Massa-K Protocol 2 (Protocol 100) - Binary Packet
exports.MassaK_100 = {
    id: 'massak_100',
    name: 'Massa-K (Protocol 2 / 100)',
    description: 'Binary protocol (100) for Massa-K terminals',
    pollingRequired: true,
    defaultBaudRate: 19200,
    parity: 'even',
    dataBits: 8,
    stopBits: 1,
    getWeightCommand: () => {
        // [F8 55 CE] [LEN_L] [LEN_H] [CMD] [CRC_L] [CRC_H]
        const header = Buffer.from([0xF8, 0x55, 0xCE]);
        const data = Buffer.from([0x01, 0x00, 0xA0]); // Len=1 (A0), data=[A0]
        const crcValue = calculateCRC16(data);
        const crc = Buffer.alloc(2);
        crc.writeUInt16LE(crcValue);
        return Buffer.concat([header, data, crc]);
    },
    parse: (data) => {
        if (typeof data === 'string')
            return null;
        // Find Header [F8 55 CE]
        const headerIdx = data.indexOf(Buffer.from([0xF8, 0x55, 0xCE]));
        if (headerIdx === -1) {
            // Log if we received data but header is missing
            if (data.length > 0) {
                console.log(`MassaK_100: Header not found in ${data.length} bytes`);
            }
            return null;
        }
        const pkt = data.subarray(headerIdx);
        if (pkt.length < 14) {
            console.log(`MassaK_100: Waiting for more data, current pkt length: ${pkt.length}`);
            return null;
        }
        // Response format: [Header(3)] [Len(2)] [Data(7)] [CRC(2)]
        // Data: [10] [Weight(4LE)] [Div] [Stable]
        const weightRaw = pkt.readInt32LE(3 + 2 + 1); // Skip Header(3), Len(2), Cmd(1)
        const stableFlag = pkt.readUInt8(3 + 2 + 1 + 4 + 1); // Stable byte
        const isStable = stableFlag === 1;
        console.log(`MassaK_100: Parsed weightRaw=${weightRaw}, stable=${isStable}`);
        return {
            weight: weightRaw / 1000.0,
            unit: 'kg',
            stable: isStable
        };
    }
};
// Massa-K Protocol 1 (ASCII) - Often used in AB terminals
exports.MassaK_Protocol1 = {
    id: 'massak_p1',
    name: 'Massa-K (Protocol 1)',
    description: 'ASCII protocol for Massa-K terminals',
    pollingRequired: true,
    defaultBaudRate: 9600,
    parity: 'none',
    getWeightCommand: () => Buffer.from('W\r\n'),
    parse: (data) => {
        const str = data.toString().trim();
        if (!str)
            return null;
        // Log raw string for ASCII debugging
        console.log(`MassaK_Protocol1: Received Raw: "${str}"`);
        // Standard format: "S  +001.234 kg" or "U  -000.500 kg"
        // Regex: [Status][any space][Sign][Weight][any space][Unit]
        const match = str.match(/([SU\?])\s*([+-]?\d+\.\d+)\s*(\w+)?/);
        if (match) {
            const [, status, weight, unit] = match;
            return {
                weight: parseFloat(weight),
                unit: (unit || 'kg').toLowerCase(),
                stable: status === 'S'
            };
        }
        // Extremely permissive fallback: look for ANY number with decimal
        const numericMatch = str.match(/([+-]?\d+\.\d+)/);
        if (numericMatch) {
            return {
                weight: parseFloat(numericMatch[1]),
                unit: 'kg',
                stable: str.includes('S')
            };
        }
        return null;
    }
};
// Massa-K Lite (Text based, simpler)
exports.MassaK_Lite = {
    id: 'massak_lite',
    name: 'Massa-K (Lite)',
    description: 'Simple text protocol',
    pollingRequired: true,
    defaultBaudRate: 9600,
    getWeightCommand: () => Buffer.from([0x45]), // 'E'
    parse: (data) => {
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
// Massa-K Protocol 3 (ASCII / Weight Request 0x05)
// Often used in TB-S, TB-M terminals
exports.MassaK_A_TB = {
    id: 'massak_astb',
    name: 'Massa-K A/TB (Simple)',
    description: 'Protocol 3 (Request 0x05) for AB/AB-series scales',
    pollingRequired: true,
    defaultBaudRate: 9600,
    parity: 'none',
    getWeightCommand: () => Buffer.from([0x05]), // ENQ request
    parse: (data) => {
        const text = data.toString();
        // Response format is often: [STX]Weight[ETX] or just Weight[CR]
        // Example: "  + 1.235 kg "
        const match = text.match(/([+-]?\s*\d+\.\d+)\s*(kg|g)?/i);
        if (match) {
            const weightVal = parseFloat(match[1].replace(/\s+/g, ''));
            return {
                weight: weightVal,
                unit: (match[2] || 'kg').toLowerCase(),
                stable: text.includes('S') || true
            };
        }
        return null;
    }
};
// Massa-K Continuous Mode (Passive listening)
exports.MassaK_Continuous = {
    id: 'massak_cont',
    name: 'Massa-K (Непрерывный)',
    description: 'Для весов, настроенных на постоянную передачу данных',
    pollingRequired: false,
    parse: (data) => {
        const str = data.toString().trim();
        if (!str)
            return null;
        console.log(`MassaK_Continuous: Received Raw: "${str}"`);
        // Try numeric extraction if standard formats fail
        const match = str.match(/([+-]?\d+\.\d+)/);
        if (match) {
            return {
                weight: parseFloat(match[1]),
                unit: 'kg',
                stable: str.includes('S')
            };
        }
        return null;
    }
};
// Massa-K A/TB (Variant with 'P' request)
exports.MassaK_A_TB_P = {
    id: 'massak_astbp',
    name: 'Massa-K A/TB (Text P)',
    description: 'Protocol using "P" command, common in A/TB series',
    pollingRequired: true,
    defaultBaudRate: 4800,
    parity: 'none',
    getWeightCommand: () => Buffer.from('P\r\n'),
    parse: (data) => {
        const str = data.toString().trim();
        if (!str)
            return null;
        console.log(`MassaK_A_TB_P: Received Raw: "${str}"`);
        const match = str.match(/([+-]?\d+\.\d+)/);
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
// Massa-K (Protocol J / SimplePacking Match)
// Discovered via serial sniffer: 4800, 8, Even, 1
exports.MassaK_J = {
    id: 'massak_j',
    name: 'Massa-K (SimplePacking Match)',
    description: 'Special variant using "J" command at 4800 baud (Even parity)',
    pollingRequired: true,
    defaultBaudRate: 4800,
    parity: 'even',
    dataBits: 8,
    stopBits: 1,
    getWeightCommand: () => Buffer.from('J'),
    parse: (data) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (buf.length < 5)
            return null;
        const status = buf[0];
        const isStable = (status & 0x80) !== 0;
        const isNegative = (status & 0x40) !== 0;
        // Weight is Int16LE at offset 2 (grams).
        // Verified by: 80 00 D0 07 00 -> D0 07 = 2000 (2 kg)
        const weightGrams = buf.readInt16LE(2);
        let weight = weightGrams / 1000.0;
        if (isNegative && weight > 0)
            weight = -weight;
        return {
            weight: weight,
            unit: 'kg',
            stable: isStable
        };
    }
};
