'use strict';

const fs = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');

if (!Module._extensions['.ts']?.labelPilotRegistered) {
    const loader = function loadTypeScript(module, filename) {
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
        module._compile(output.outputText, filename);
    };
    loader.labelPilotRegistered = true;
    Module._extensions['.ts'] = loader;
}
