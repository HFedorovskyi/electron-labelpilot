'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');

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

try {
    const {
        resolveGenerator,
        UnsupportedPrinterProtocolError,
    } = require('../src/main/printer/generator/registry.ts');

    const zpl = { generate: async () => Buffer.from('ZPL') };
    const image = { generate: async () => Buffer.from('IMAGE') };
    const tspl = { generate: async () => Buffer.from('TSPL') };
    const registry = new Map([
        ['zpl', zpl],
        ['image', image],
        ['tspl', tspl],
    ]);

    assert.equal(resolveGenerator('zpl', registry), zpl);
    assert.equal(resolveGenerator('image', registry), image);
    assert.equal(resolveGenerator('tspl', registry), tspl);

    for (const unsupported of ['browser', '', 'ZPL', 'TSPL']) {
        assert.throws(
            () => resolveGenerator(unsupported, registry),
            (error) => {
                assert.ok(error instanceof UnsupportedPrinterProtocolError);
                assert.equal(error.protocol, unsupported);
                assert.deepEqual(error.supportedProtocols, ['image', 'tspl', 'zpl']);
                assert.match(error.message, /has no generator/);
                return true;
            },
            (unsupported || '<empty>') + ' must fail closed',
        );
    }

    console.log('printer generator routing: 7 checks passed');
} finally {
    if (previousTsLoader) Module._extensions['.ts'] = previousTsLoader;
    else delete Module._extensions['.ts'];
}