'use strict';

require('./register-typescript.cjs');

const assert = require('node:assert/strict');
const {
    parseServerPingResponse,
    parseUnifiedSyncEnvelope,
} = require('../src/shared/serverContract.ts');

const currentEnvelope = {
    station: {
        uuid: 'station-uuid',
        number: 7,
        name: 'Line 7',
        server_url: 'http://127.0.0.1:8000',
    },
    payload: {
        operators: [{ uuid: 'operator-uuid' }],
        barcodes: [],
        labels: [{ id: 1, structure: '{}' }],
        containers: [],
        nomenclature: [],
        global_attributes: [],
        product_pack_links: [],
        packs: [],
    },
    meta: {
        type: 'full_sync',
        format_version: '1.0',
        server_version: '1.3.16',
        min_client_version: '1.3.0',
        generated_at: '2026-08-13T12:00:00Z',
    },
};

const demoEnvelope = {
    station: {
        uuid: 'demo-station',
        number: '01',
        name: 'Demo',
        server_url: 'http://127.0.0.1:8000',
    },
    payload: {
        barcode_templates: [],
        label_templates: [],
        container: [],
        nomenclatures: [],
    },
    meta: {
        type: 'demo_seed',
        generated_at: '2026-08-13T12:00:00Z',
    },
};

assert.equal(parseUnifiedSyncEnvelope(currentEnvelope), currentEnvelope);
assert.equal(parseUnifiedSyncEnvelope(demoEnvelope), demoEnvelope);
assert.deepEqual(parseServerPingResponse({
    status: 'online',
    server_version: '1.3.16',
    min_client_version: '1.3.0',
}), {
    status: 'online',
    server_version: '1.3.16',
    min_client_version: '1.3.0',
});

const invalidEnvelopes = [
    null,
    { station: currentEnvelope.station, meta: currentEnvelope.meta },
    { ...currentEnvelope, station: { ...currentEnvelope.station, number: '' } },
    { ...currentEnvelope, payload: { labels: {} } },
    { ...currentEnvelope, meta: { ...currentEnvelope.meta, generated_at: 123 } },
];
for (const value of invalidEnvelopes) {
    assert.throws(() => parseUnifiedSyncEnvelope(value), /Invalid unified data format/);
}
assert.throws(() => parseServerPingResponse({ status: 200 }), /Invalid server ping response|must be a string/);

console.log('server contract: current + legacy/demo envelopes accepted');
console.log(`server contract: ${invalidEnvelopes.length + 1} malformed inputs rejected`);