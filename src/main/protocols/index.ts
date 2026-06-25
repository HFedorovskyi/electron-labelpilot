import { type ScaleProtocol, type ScaleReading } from './types';
import { CAS_Simple } from './cas';
import { Mettler_SICS } from './mettler';
import { MassaK_100, MassaK_Lite, MassaK_Protocol1, MassaK_A_TB, MassaK_Continuous, MassaK_A_TB_P, MassaK_J } from './massak_extended';
import { Shtrih_M } from './shtrihm';
import { Mertech } from './mertech';
import { Dibal_Delta } from './dibal';
import { AND_Standard } from './and_std';
import { Ohaus, Sartorius_SBI, Radwag, Kern, DiniArgeo } from './eu_ascii';
import { Simulator } from './simulator';

export const PROTOCOLS: Record<string, ScaleProtocol> = {
    [CAS_Simple.id]: CAS_Simple,
    [Mettler_SICS.id]: Mettler_SICS,
    [MassaK_100.id]: MassaK_100,
    [MassaK_Protocol1.id]: MassaK_Protocol1,
    [MassaK_A_TB.id]: MassaK_A_TB,
    [MassaK_A_TB_P.id]: MassaK_A_TB_P,
    [MassaK_J.id]: MassaK_J,
    [MassaK_Continuous.id]: MassaK_Continuous,
    [MassaK_Lite.id]: MassaK_Lite,
    [Shtrih_M.id]: Shtrih_M,
    [Mertech.id]: Mertech,
    [AND_Standard.id]: AND_Standard,
    [Dibal_Delta.id]: Dibal_Delta,
    [Ohaus.id]: Ohaus,
    [Sartorius_SBI.id]: Sartorius_SBI,
    [Radwag.id]: Radwag,
    [Kern.id]: Kern,
    [DiniArgeo.id]: DiniArgeo,
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
