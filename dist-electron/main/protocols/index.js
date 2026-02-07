"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getProtocol = exports.PROTOCOLS = void 0;
const cas_1 = require("./cas");
const mettler_1 = require("./mettler");
const massak_extended_1 = require("./massak_extended");
const shtrihm_1 = require("./shtrihm");
const mertech_1 = require("./mertech");
const simulator_1 = require("./simulator");
exports.PROTOCOLS = {
    [cas_1.CAS_Simple.id]: cas_1.CAS_Simple,
    [mettler_1.Mettler_SICS.id]: mettler_1.Mettler_SICS,
    [massak_extended_1.MassaK_100.id]: massak_extended_1.MassaK_100,
    [massak_extended_1.MassaK_Lite.id]: massak_extended_1.MassaK_Lite,
    [shtrihm_1.Shtrih_M.id]: shtrihm_1.Shtrih_M,
    [mertech_1.Mertech.id]: mertech_1.Mertech,
    [simulator_1.Simulator.id]: simulator_1.Simulator,
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
const getProtocol = (id) => {
    return exports.PROTOCOLS[id] || exports.PROTOCOLS['generic'];
};
exports.getProtocol = getProtocol;
