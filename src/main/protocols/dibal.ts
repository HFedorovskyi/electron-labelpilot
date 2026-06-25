import { type ScaleProtocol, type ScaleReading } from './types';

// Dibal "Delta" simple-text weight protocol.
// Master polls with 'D' (0x44) CR LF; the scale replies only when the weight is stable,
// non-negative and in range, with an ASCII frame:  <sign> WW.WWW <checksum> CR LF
//   e.g.  "+12.345A\r\n"  ->  +12.345 kg
// The decimal point is present in the wire data, so there is no scaling ambiguity:
// a malformed frame simply yields null (no reading) rather than a wrong weight.
export const Dibal_Delta: ScaleProtocol = {
    id: 'dibal_delta',
    name: 'Dibal (Delta)',
    description: 'Dibal Delta: запрос «D», ASCII-вес со знаком (кг)',
    pollingRequired: true,
    defaultBaudRate: 9600,
    parity: 'none',
    dataBits: 8,
    stopBits: 1,

    getWeightCommand: () => Buffer.from([0x44, 0x0D, 0x0A]), // 'D' CR LF

    parse: (data: Buffer | string): ScaleReading | null => {
        const str = data.toString();
        // Sign + decimal number anywhere in the frame.
        const m = str.match(/([+\-])\s*(\d+\.\d+)/);
        if (!m) return null;
        let weight = parseFloat(m[2]);
        if (m[1] === '-') weight = -weight;
        // Delta transmits only on a settled reading → treat as stable.
        return { weight, unit: 'kg', stable: true };
    }
};
