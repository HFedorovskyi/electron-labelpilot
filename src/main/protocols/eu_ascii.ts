import { type ScaleProtocol, type ScaleReading } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Popular EU/CIS bench-scale & indicator brands that emit an ASCII weight line.
//
// All parsers here are FAIL-SAFE BY CONSTRUCTION: the decimal point AND the unit
// are present in the wire data, so a wrong/garbled/unknown frame yields `null`
// (no reading) — it can never silently mis-scale a weight (no 10×/1000× risk).
// Grams are normalised to kilograms (the app treats reading.weight as kg).
//
// Hardware stability flags vary per model, so (except where a frame carries an
// explicit ST/US marker) stability is left to the app's software stability window
// (checkStability) rather than forced true — this prevents auto-printing an
// unsettled weight. Serial parity/dataBits are best-effort defaults; if they are
// wrong for a given model the bytes are garbled → parse returns null (fail-safe)
// and the operator simply adjusts. NOTE: confirm on hardware before production use.
// ─────────────────────────────────────────────────────────────────────────────

// Extract a signed decimal mass (with unit) from an ASCII frame. Requires a real
// decimal point so we never grab an integer ID/status field by accident.
function asciiWeight(text: string, stable: boolean): ScaleReading | null {
    const m = text.match(/([+-]?)\s*(\d+\.\d+)\s*(kg|g|lb|oz|ct)?/i);
    if (!m) return null;
    let weight = parseFloat((m[1] === '-' ? '-' : '') + m[2]);
    let unit = (m[3] || 'kg').toLowerCase();
    if (unit === 'g') { weight = weight / 1000; unit = 'kg'; }
    else if (unit !== 'kg' && unit !== 'lb') unit = 'kg';
    return { weight, unit: unit as 'kg' | 'lb', stable };
}

// OHAUS (Defender 3000/5000, Ranger, Scout, Valor, Pioneer): ASCII print output.
// "IP" = immediate print (replies regardless of stability); the value carries the
// decimal point and unit.
export const Ohaus: ScaleProtocol = {
    id: 'ohaus',
    name: 'OHAUS (ASCII)',
    description: 'OHAUS Defender/Ranger/Scout/Valor — ASCII-печать, команда «IP»',
    pollingRequired: true,
    defaultBaudRate: 9600, parity: 'none', dataBits: 8, stopBits: 1,
    getWeightCommand: () => Buffer.from('IP\r\n'),
    parse: (d) => asciiWeight(d.toString(), false),
};

// Sartorius / Minebea Intec SBI (Standard Balance Interface): print on ESC P.
// Classic SBI line: "<sign> <fixed-width mass with decimal> <unit>".
export const Sartorius_SBI: ScaleProtocol = {
    id: 'sartorius_sbi',
    name: 'Sartorius / Minebea (SBI)',
    description: 'Sartorius SBI: печать по ESC P, ASCII со знаком и единицей',
    pollingRequired: true,
    defaultBaudRate: 9600, parity: 'odd', dataBits: 7, stopBits: 1,
    getWeightCommand: () => Buffer.from([0x1B, 0x50, 0x0D, 0x0A]), // ESC 'P' CR LF
    parse: (d) => asciiWeight(d.toString(), false),
};

// RADWAG (very common in EU/CIS): "SI" = send mass immediately.
// Reply carries a stability marker plus signed mass with decimal point and unit.
export const Radwag: ScaleProtocol = {
    id: 'radwag',
    name: 'RADWAG (ASCII)',
    description: 'RADWAG: команда «SI», ASCII-масса со знаком и единицей',
    pollingRequired: true,
    defaultBaudRate: 9600, parity: 'none', dataBits: 8, stopBits: 1,
    getWeightCommand: () => Buffer.from('SI\r\n'),
    parse: (d) => asciiWeight(d.toString(), false),
};

// KERN & Sohn (KCP / simple ASCII output): "w" requests the current weight.
export const Kern: ScaleProtocol = {
    id: 'kern',
    name: 'KERN (KCP/ASCII)',
    description: 'KERN & Sohn: команда «w», ASCII-масса с единицей',
    pollingRequired: true,
    defaultBaudRate: 9600, parity: 'none', dataBits: 8, stopBits: 1,
    getWeightCommand: () => Buffer.from('w\r\n'),
    parse: (d) => asciiWeight(d.toString(), false),
};

// Dini Argeo (DFW/DGT/3590; Rice Lake) — short string: [CC]HH,KK,PPPPPPPP,UM
//   HH = ST (stable) / US (unstable) / OL|UL|TL (error)
//   KK = 2-letter weight type (GS/NT/TS)
//   PPPPPPPP = weight field WITH decimal point  → explicit-in-ascii (no scaling risk)
// The mandatory 2-letter type field distinguishes the short format from the extended
// one ("ST,1,…"), so this regex only matches the short string. Verified against
// official Dini Argeo technical manuals (DFW / 3590EKR series).
export const DiniArgeo: ScaleProtocol = {
    id: 'dini_argeo',
    name: 'Dini Argeo (DFW/DGT/3590)',
    description: 'Dini Argeo: запрос «READ», строка «ST,GS,вес,ед»',
    pollingRequired: true,
    defaultBaudRate: 9600, parity: 'none', dataBits: 8, stopBits: 1,
    getWeightCommand: () => Buffer.from('READ\r\n'),
    parse: (d): ScaleReading | null => {
        const t = d.toString();
        const m = t.match(/(ST|US|OL|UL|TL)\s*,\s*[A-Za-z]{2}\s*,\s*([+-]?\d+(?:\.\d+)?)\s*,?\s*(kg|g|lb)?/);
        if (!m) return null;
        if (m[1] !== 'ST' && m[1] !== 'US') return null; // OL/UL/TL = over/under/tare error
        let weight = parseFloat(m[2]);
        let unit = (m[3] || 'kg').toLowerCase();
        if (unit === 'g') { weight = weight / 1000; unit = 'kg'; }
        else if (unit !== 'kg' && unit !== 'lb') unit = 'kg';
        return { weight, unit: unit as 'kg' | 'lb', stable: m[1] === 'ST' };
    },
};
