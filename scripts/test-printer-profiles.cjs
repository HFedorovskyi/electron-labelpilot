'use strict';

require('./register-typescript.cjs');
const assert = require('node:assert/strict');
const {
    PRINTER_COMPATIBILITY_PROFILES,
    printerProfileEndpointKey,
    resolvePrinterProfile,
} = require('../src/shared/printerProfiles.ts');

const tcpZpl = {
    protocol: 'zpl',
    connection: 'tcp',
    ip: '10.0.0.8',
    port: 9100,
};

assert.equal(printerProfileEndpointKey(tcpZpl), 'tcp:10.0.0.8:9100');
assert.equal(resolvePrinterProfile(tcpZpl).id, 'generic-zpl-safe');
assert.equal(resolvePrinterProfile({ ...tcpZpl, compatibilityMode: 'compatible' }).id, 'generic-zpl-safe');
assert.equal(resolvePrinterProfile({ ...tcpZpl, compatibilityMode: 'advanced' }).id, 'zpl-full');
assert.equal(resolvePrinterProfile({
    ...tcpZpl,
    compatibilityMode: 'auto',
    detectedProfileId: 'zpl-full',
    detectedEndpointKey: 'tcp:10.0.0.8:9100',
}).id, 'zpl-full');
assert.equal(resolvePrinterProfile({
    ...tcpZpl,
    compatibilityMode: 'auto',
    detectedProfileId: 'zpl-full',
    detectedEndpointKey: 'tcp:10.0.0.9:9100',
}).id, 'generic-zpl-safe', 'Detection hint must stay bound to its physical endpoint');
assert.equal(resolvePrinterProfile({
    ...tcpZpl,
    connection: 'windows_driver',
    driverName: 'RAW Queue',
}).language, 'zpl', 'Windows RAW transport must preserve the selected printer language');
assert.equal(resolvePrinterProfile({
    protocol: 'browser',
    connection: 'windows_driver',
}).id, 'windows-driver');
assert.equal(resolvePrinterProfile({
    protocol: 'tspl',
    connection: 'serial',
    compatibilityMode: 'advanced',
    serialPort: 'COM4',
}).id, 'tspl2-full');

for (const [protocol, profile] of Object.entries({
    epl: 'generic-epl-raster',
    cpcl: 'generic-cpcl-raster',
    dpl: 'generic-dpl-raster',
    sbpl: 'generic-sbpl-raster',
})) {
    const resolved = resolvePrinterProfile({ protocol, connection: 'tcp', ip: '10.0.0.8' });
    assert.equal(resolved.id, profile);
    assert.equal(resolved.features.bitmap, true);
    assert.equal(resolved.features.nativeText, false);
}

for (const required of ['generic-zpl-safe', 'zpl-full', 'generic-tspl-safe', 'tspl2-full', 'windows-driver']) {
    assert.ok(PRINTER_COMPATIBILITY_PROFILES[required], `Printer profile ${required} is missing`);
}

console.log(`Printer profiles: ${Object.keys(PRINTER_COMPATIBILITY_PROFILES).length} Tauri-compatible profiles validated`);
