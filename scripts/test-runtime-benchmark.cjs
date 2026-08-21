'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const benchmarkPath = path.join(root, 'scripts', 'measure-tauri-runtime.ps1');
const soakPath = path.join(root, 'scripts', 'soak-tauri-runtime.cjs');
const packagePath = path.join(root, 'package.json');

const benchmark = fs.readFileSync(benchmarkPath, 'utf8');
const soak = fs.readFileSync(soakPath, 'utf8');
const scripts = JSON.parse(fs.readFileSync(packagePath, 'utf8')).scripts;

for (const token of [
    'fullProductionUi = $true',
    'isolatedDataDirectories = $true',
    'metricsIncludeProcessTree = $true',
    'targetViewport',
    'WindowWidth = 1366',
    'WindowHeight = 768',
    'coldStartMs',
    'medianWorkingSetBytes',
    'medianPrivateBytes',
    'peakSamplePrivateBytes',
    'idleCpuPercentNormalized',
    'medianThreads',
    'medianHandles',
    "kind = 'labelpilot-tauri-runtime-benchmark'",
    'Port 5556 is already in use',
]) {
    assert.ok(benchmark.includes(token), 'benchmark contract is missing ' + token);
}
assert.doesNotMatch(benchmark, /Remove-Item[^\r\n]*[-*?]/i, 'benchmark must not perform wildcard deletion');
assert.doesNotMatch(benchmark, /electron/i, 'retired runtime must not be part of the benchmark');
assert.match(benchmark, /coldStartMs\s*=\s*2500/);
assert.match(benchmark, /idleTreeWorkingSetBytes\s*=\s*120MB/);
assert.match(benchmark, /ordinaryPeakTreePrivateBytes\s*=\s*200MB/);
assert.match(benchmark, /idleCpuPercentNormalized\s*=\s*5\.0/);

for (const token of [
    'labelpilot-runtime-soak',
    'duration-seconds',
    'printer-disconnect-every',
    'scale-disconnect-every',
    'desktop_printer_generate_and_send',
    'desktop_printer_transport_summary',
    'desktop_printer_durable_summary',
    'desktop_printer_generator_summary',
    'desktop_scale_summary',
    'desktop_ingress_summary',
    '/api/full_sync',
    'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS',
    'LABELPILOT_DATA_DIR',
    'privateGrowthBytes',
    'workingSetGrowthBytes',
    'firstLabelMs',
    'hundredLabelsMs',
]) {
    assert.ok(soak.includes(token), 'soak contract is missing ' + token);
}
assert.doesNotMatch(soak, /rmSync\([^\r\n]*recursive\s*:\s*true/i, 'soak must preserve its isolated evidence directory');
assert.match(scripts['test:runtime-qualification'], /test-runtime-benchmark\.cjs/);
assert.match(scripts['soak:tauri'], /soak-tauri-runtime\.cjs/);

console.log('Runtime qualification contracts: benchmark metrics/gates and bounded soak workload passed');
