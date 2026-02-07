import { type ScaleProtocol, type ScaleReading } from './types';
import { CAS_Simple } from './cas';
import { Mettler_SICS } from './mettler';
import { MassaK_100, MassaK_Lite } from './massak_extended';
import { Shtrih_M } from './shtrihm';
import { Mertech } from './mertech';
import { Simulator } from './simulator';

export const PROTOCOLS: Record<string, ScaleProtocol> = {
    [CAS_Simple.id]: CAS_Simple,
    [Mettler_SICS.id]: Mettler_SICS,
    [MassaK_100.id]: MassaK_100,
    [MassaK_Lite.id]: MassaK_Lite,
    [Shtrih_M.id]: Shtrih_M,
    [Mertech.id]: Mertech,
    [Simulator.id]: Simulator,

    'generic': {
        id: 'generic',
        name: 'Generic Text',
        description: 'Parses first number found in output',
        pollingRequired: false,
        parse: (data) => {
            const text = data.toString();
            const match = text.match(/(\d+\.\d+)/);
            if (match) {
                return {
                    weight: parseFloat(match[1]),
                    unit: 'kg',
                    stable: false
                };
            }
            return null;
        }
    }
};

export const getProtocol = (id: string): ScaleProtocol => {
    return PROTOCOLS[id] || PROTOCOLS['generic'];
};

export type { ScaleProtocol, ScaleReading };
