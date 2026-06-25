import { type ScaleProtocol, type ScaleReading } from './types';

// A&D / "Standard" ASCII format (ST/US/OL), the de-facto serial output shared by A&D
// (FG/FX/EK/GX/GF…) and emulated by many OEM/Chinese indicators (Tscale and others).
// Frame:  <header>,<sign><weight> <unit> CR LF
//   "ST,+00123.45 g\r\n"  (ST = stable)
//   "US,+00123.45 g\r\n"  (US = unstable)
//   "OL,+ 9999999  g\r\n"  (OL = overload → no valid weight)
//   header may also be QT/WT/NT on some units.
//
// The weight's decimal point AND unit are present in the data, so this parser is fail-safe:
// it normalises grams→kg and returns null on any frame it doesn't recognise (never a
// silently mis-scaled weight). Works both when polled ('Q' request) and in continuous mode.
export const AND_Standard: ScaleProtocol = {
    id: 'and_standard',
    name: 'A&D / Standard (ST/US)',
    description: 'Стандартный ASCII-формат A&D (ST/US/OL) — A&D, Tscale и совместимые',
    pollingRequired: true,
    defaultBaudRate: 2400,
    parity: 'none',
    dataBits: 7,
    stopBits: 1,

    getWeightCommand: () => Buffer.from('Q\r\n'), // A&D immediate-data request; ignored by stream-mode units

    parse: (data: Buffer | string): ScaleReading | null => {
        const str = data.toString();
        // header , sign weight (with decimal) [unit]
        const m = str.match(/\b(ST|US|QT|WT|NT|OL)\s*,\s*([+-]?\s*\d+\.\d+)\s*([a-zA-Z]+)?/);
        if (!m) return null;
        if (m[1] === 'OL') return null; // overload — no usable weight

        let weight = parseFloat(m[2].replace(/\s+/g, ''));
        let unit = (m[3] || 'kg').toLowerCase();

        // Normalise to kg (the app treats the reading as kilograms).
        if (unit === 'g') { weight = weight / 1000; unit = 'kg'; }
        else if (unit !== 'kg' && unit !== 'lb') { unit = 'kg'; }

        return {
            weight,
            unit: unit as 'kg' | 'g' | 'lb',
            stable: m[1] === 'ST'
        };
    }
};
