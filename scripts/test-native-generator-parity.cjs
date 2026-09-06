'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const previousTsLoader = Module._extensions['.ts'];

Module._extensions['.ts'] = function compileTypeScript(mod, filename) {
    const source = fs.readFileSync(filename, 'utf8');
    const output = ts.transpileModule(source, {
        compilerOptions: {
            esModuleInterop: true,
            module: ts.ModuleKind.CommonJS,
            moduleResolution: ts.ModuleResolutionKind.NodeJs,
            target: ts.ScriptTarget.ES2022,
        },
        fileName: filename,
        reportDiagnostics: true,
    });
    mod._compile(output.outputText, filename);
};

(async () => {
    try {
        const { ZplGenerator } = require('../src/main/printer/generator/ZplGenerator.ts');
        const { TsplGenerator } = require('../src/main/printer/generator/TsplGenerator.ts');
        const { resolvePrinterProfile } = require('../src/shared/printerProfiles.ts');
        const fixture = JSON.parse(read('tests/fixtures/printer-native-golden.json'));

        assert.equal(fixture.version, 1);
        assert.equal(fixture.cases.length, 2);
        let totalBytes = 0;
        for (const item of fixture.cases) {
            const generator = item.config.protocol === 'zpl' ? new ZplGenerator() : new TsplGenerator();
            const bytes = await generator.generate(item.doc, item.data, {
                dpi: item.config.dpi,
                widthMm: item.config.widthMm,
                heightMm: item.config.heightMm,
                darkness: item.config.darkness,
                printSpeed: item.config.printSpeed,
                gapMm: item.config.gapMm,
                profile: resolvePrinterProfile(item.config),
            });
            const expected = Buffer.from(item.expectedBase64, 'base64');
            assert.equal(bytes.length, item.expectedBytes, `${item.name}: byte count changed`);
            assert.deepEqual(bytes, expected, `${item.name}: TypeScript output changed`);
            totalBytes += bytes.length;
        }

        const rustTypes = read('src-tauri/src/generator/types.rs');
        const rustModule = read('src-tauri/src/generator/mod.rs');
        const commands = read('src-tauri/src/commands.rs');
        const runtime = read('src-tauri/src/lib.rs');
        const bridge = read('src/renderer/platform/tauriBridge.ts');
        assert.match(rustTypes, /MAX_LABEL_ELEMENTS:\s*usize\s*=\s*1024/);
        assert.match(rustTypes, /MAX_GENERATOR_INPUT_BYTES:\s*usize\s*=\s*8\s*\*\s*1024\s*\*\s*1024/);
        assert.match(rustTypes, /MAX_GENERATED_BYTES:\s*usize\s*=\s*16\s*\*\s*1024\s*\*\s*1024/);
        assert.match(rustTypes + rustModule, /electron-bitmap/);
        assert.match(rustTypes + rustModule, /rust-native/);

        for (const command of [
            'desktop_printer_plan_generation',
            'desktop_printer_generate_native',
            'desktop_printer_generate_and_send',
            'desktop_printer_generator_summary',
        ]) {
            assert.ok(commands.includes(`fn ${command}`), `${command} is missing`);
            assert.ok(runtime.includes(`commands::${command}`), `${command} is not registered`);
            assert.ok(bridge.includes(`'${command}'`), `${command} is not exposed to the renderer`);
        }

        console.log(`native generator parity: ${fixture.cases.length} fixtures, ${totalBytes} exact bytes`);
        console.log('native generator routing: bounded Rust native path plus explicit Electron bitmap fallback');
    } finally {
        if (previousTsLoader) Module._extensions['.ts'] = previousTsLoader;
        else delete Module._extensions['.ts'];
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
