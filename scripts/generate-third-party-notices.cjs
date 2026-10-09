'use strict';

// Builds resources/THIRD-PARTY-NOTICES.txt: the licences of everything the Windows client
// ships. Rust crates linked into the executables (normal dependencies of both builds, Tauri
// and Slint), the native libraries inside them (third-party/native-components.json), the
// fonts and the npm packages of the Tauri web UI. Installed next to LabelPilot.exe.
//
//   node scripts/generate-third-party-notices.cjs           write the file
//   node scripts/generate-third-party-notices.cjs --check   fail when it is out of date or a
//                                                          licence is not on the allow list

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const OUTPUT = path.join(root, 'resources', 'THIRD-PARTY-NOTICES.txt');
const VENDORED = path.join(root, 'third-party', 'licenses');
const FEATURE_SETS = [[], ['--no-default-features', '--features', 'slint-ui']];

// Licences we may ship in a proprietary product. Where a crate offers a choice, the first
// one here that satisfies it is used (so Slint is taken under its royalty-free licence).
const PREFERENCE = [
    'MIT', 'Apache-2.0', 'BSD-3-Clause', 'BSD-2-Clause', 'ISC', 'Zlib', 'Unicode-3.0', 'BSL-1.0',
    '0BSD', 'MIT-0', 'CC0-1.0', 'Unlicense', 'MPL-2.0', 'LicenseRef-Slint-Royalty-free-2.0',
];
const ALLOWED = new Set(PREFERENCE);
// File-level copyleft: the notice says where the source of these crates is.
const SOURCE_OFFER = new Set(['MPL-2.0']);

const MIT_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const BSD3_BODY = `Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

const normalize = (text) => text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
    .split('\n').map((line) => line.trimEnd()).join('\n').replace(/^\n+|\n+$/g, '');

// ── SPDX expressions ────────────────────────────────────────────────────────────────────
function parseExpression(text) {
    const tokens = text.replace(/\//g, ' OR ').replace(/([()])/g, ' $1 ').split(/\s+/).filter(Boolean);
    let at = 0;
    const expr = () => {
        const options = [term()];
        while (tokens[at] === 'OR') { at += 1; options.push(term()); }
        return options.length === 1 ? options[0] : { or: options };
    };
    const term = () => {
        const parts = [factor()];
        while (tokens[at] === 'AND') { at += 1; parts.push(factor()); }
        return parts.length === 1 ? parts[0] : { and: parts };
    };
    const factor = () => {
        if (tokens[at] === '(') { at += 1; const inner = expr(); assert.equal(tokens[at], ')', text); at += 1; return inner; }
        assert.ok(tokens[at], `incomplete licence expression: ${text}`);
        return tokens[at++];
    };
    const tree = expr();
    assert.equal(at, tokens.length, `bad licence expression: ${text}`);
    return tree;
}

const rank = (id) => (ALLOWED.has(id) ? PREFERENCE.indexOf(id) : 1000 + id.length);
const cost = (ids) => Math.max(...ids.map(rank));

/** The licences we comply with for an expression: every AND part, the best OR option. */
function chooseLicences(tree) {
    if (typeof tree === 'string') return [tree];
    if (tree.and) return [...new Set(tree.and.flatMap(chooseLicences))];
    return tree.or.map(chooseLicences).sort((a, b) => cost(a) - cost(b))[0];
}

// ── Licence files ───────────────────────────────────────────────────────────────────────
const LICENCE_FILE = /^(licen[cs]e|copying|notice|unlicense)/i;

function fileLicence(name) {
    const upper = name.toUpperCase();
    const spdx = /^LICENSES\/(.+)\.(txt|md)$/i.exec(name);
    if (spdx) return spdx[1];
    if (upper.includes('APACHE')) return 'Apache-2.0';
    if (upper.includes('0BSD')) return '0BSD';
    if (upper.includes('BSD')) return 'BSD';
    if (upper.includes('BOOST')) return 'BSL-1.0';
    if (upper.includes('ZLIB')) return 'Zlib';
    if (upper.includes('ISC')) return 'ISC';
    if (upper.includes('CC0')) return 'CC0-1.0';
    if (/(^|[-_.])MIT($|[-_.])/.test(upper) && !upper.includes('LIBM')) return 'MIT';
    if (upper.startsWith('UNLICENSE')) return 'Unlicense';
    return null; // a general licence or notice file: always included
}

function licenceFiles(dir) {
    const names = fs.readdirSync(dir).filter((name) => LICENCE_FILE.test(name) && !/\.spdx$/i.test(name)
        && fs.statSync(path.join(dir, name)).isFile());
    const nested = path.join(dir, 'LICENSES');
    if (fs.existsSync(nested) && fs.statSync(nested).isDirectory()) {
        names.push(...fs.readdirSync(nested).map((name) => `LICENSES/${name}`));
    }
    return names.sort();
}

let standardTexts = null;
/** Apache-2.0, MPL-2.0, BSL-1.0 ... carry no copyright line: their text can stand in. */
function standardText(id, crates) {
    if (!standardTexts) {
        standardTexts = new Map();
        for (const crate of crates) {
            for (const name of licenceFiles(crate.dir)) {
                const licence = fileLicence(name) ?? (crate.licences.length === 1 ? crate.licences[0] : null);
                if (licence && !standardTexts.has(licence) && ['Apache-2.0', 'MPL-2.0', 'BSL-1.0'].includes(licence)) {
                    standardTexts.set(licence, normalize(fs.readFileSync(path.join(crate.dir, name), 'utf8')));
                }
            }
        }
    }
    return standardTexts.get(id) ?? null;
}

function crateTexts(crate, crates) {
    const chosen = new Set(crate.licences);
    const texts = [];
    const covered = new Set();
    for (const name of licenceFiles(crate.dir)) {
        const licence = fileLicence(name);
        if (licence === 'BSD' ? ![...chosen].some((id) => id.startsWith('BSD')) : licence && !chosen.has(licence)) continue;
        texts.push(normalize(fs.readFileSync(path.join(crate.dir, name), 'utf8')));
        if (licence) covered.add(licence === 'BSD' ? [...chosen].find((id) => id.startsWith('BSD')) : licence);
        else crate.licences.forEach((id) => covered.add(id));
    }
    const holders = crate.authors.length ? crate.authors.map((a) => a.replace(/\s*<[^>]*>/, '')).join(', ') : `the ${crate.name} authors`;
    for (const id of crate.licences.filter((id) => !covered.has(id))) {
        if (id === 'MIT') texts.push(`Copyright (c) ${holders}\n\n${MIT_BODY}`);
        else if (id === 'BSD-3-Clause') texts.push(`Copyright (c) ${holders}\n\n${BSD3_BODY}`);
        else {
            const text = standardText(id, crates);
            assert.ok(text, `no licence text for ${crate.name} ${crate.version} (${id})`);
            texts.push(`Copyright (c) ${holders}\n\n${text}`);
        }
    }
    return texts;
}

// ── Rust crates ─────────────────────────────────────────────────────────────────────────
function rustCrates() {
    const crates = new Map();
    for (const extra of FEATURE_SETS) {
        // Offline when the build sets CARGO_NET_OFFLINE; CI may still have to fetch the index.
        const meta = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1',
            '--filter-platform', 'x86_64-pc-windows-msvc', '--manifest-path', path.join(root, 'src-tauri', 'Cargo.toml'), ...extra],
        { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
        const packages = new Map(meta.packages.map((p) => [p.id, p]));
        const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
        const seen = new Set();
        const stack = [meta.resolve.root];
        while (stack.length) {
            const id = stack.pop();
            if (seen.has(id)) continue;
            seen.add(id);
            for (const dep of nodes.get(id).deps) {
                if (dep.dep_kinds.some((kind) => kind.kind === null)) stack.push(dep.pkg);
            }
        }
        for (const id of seen) {
            const p = packages.get(id);
            // Our own path crates and compile-time-only proc macros are not third-party code we ship.
            if (!p.source || p.targets.some((t) => t.kind.includes('proc-macro'))) continue;
            const key = `${p.name} ${p.version}`;
            if (crates.has(key)) continue;
            assert.ok(p.license, `${key} declares no licence`);
            crates.set(key, {
                name: p.name, version: p.version, expression: p.license, licences: chooseLicences(parseExpression(p.license)),
                authors: p.authors ?? [], url: p.repository || `https://crates.io/crates/${p.name}`, dir: path.dirname(p.manifest_path),
            });
        }
    }
    return [...crates.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

// ── npm packages of the Tauri web UI ────────────────────────────────────────────────────
function npmPackages() {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    return Object.entries(lock.packages)
        .filter(([at, p]) => at && !p.dev && !p.devOptional && !p.optional)
        .map(([at, p]) => {
            const dir = path.join(root, at);
            const name = at.split('node_modules/').pop();
            assert.ok(fs.existsSync(dir), `${name} is not installed: run npm ci`);
            const files = fs.readdirSync(dir).filter((f) => LICENCE_FILE.test(f)).sort();
            assert.ok(files.length, `${name} ships no licence file`);
            return { name, version: p.version, expression: p.license, licences: chooseLicences(parseExpression(p.license)),
                url: `https://www.npmjs.com/package/${name}`, texts: files.map((f) => normalize(fs.readFileSync(path.join(dir, f), 'utf8'))) };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

// ── Fonts: the copyright line comes from the font's own name table ──────────────────────
function fontCopyright(file) {
    const data = fs.readFileSync(file);
    const tables = data.readUInt16BE(4);
    for (let i = 0; i < tables; i += 1) {
        const at = 12 + 16 * i;
        if (data.toString('latin1', at, at + 4) !== 'name') continue;
        const offset = data.readUInt32BE(at + 8);
        const count = data.readUInt16BE(offset + 2);
        const strings = offset + data.readUInt16BE(offset + 4);
        for (let j = 0; j < count; j += 1) {
            const record = offset + 6 + 12 * j;
            const [platform, , language, nameId, length, start] = [0, 2, 4, 6, 8, 10].map((o) => data.readUInt16BE(record + o));
            if (platform === 3 && language === 0x409 && nameId === 0) {
                return data.subarray(strings + start, strings + start + length).swap16().toString('utf16le').trim();
            }
        }
    }
    throw new Error(`no copyright in ${file}`);
}

// ── Output ──────────────────────────────────────────────────────────────────────────────
function section(title) {
    return `\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}\n`;
}

/** Components with exactly the same licence texts are listed together, the texts once. */
function grouped(components) {
    const groups = new Map();
    for (const component of components) {
        const key = crypto.createHash('sha256').update(component.texts.join('\n\f\n')).digest('hex');
        if (!groups.has(key)) groups.set(key, { texts: component.texts, members: [] });
        groups.get(key).members.push(component);
    }
    return [...groups.values()].map(({ texts, members }) => [
        ...members.map((m) => `* ${m.name} ${m.version} (${m.expression}) ${m.url}`),
        '',
        texts.join(`\n\n${'- '.repeat(20).trim()}\n\n`),
    ].join('\n')).join(`\n\n${'-'.repeat(78)}\n\n`);
}

function build() {
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const crates = rustCrates();
    const npm = npmPackages();
    const native = JSON.parse(fs.readFileSync(path.join(root, 'third-party', 'native-components.json'), 'utf8'));
    const vendored = (name) => normalize(fs.readFileSync(path.join(VENDORED, name), 'utf8'));

    const refused = [...crates, ...npm].filter((c) => c.licences.some((id) => !ALLOWED.has(id)));
    assert.deepEqual(refused.map((c) => `${c.name} ${c.version}: ${c.expression}`), [],
        'licences not on the allow list (scripts/generate-third-party-notices.cjs PREFERENCE)');
    for (const crate of crates) crate.texts = crateTexts(crate, crates);

    const offered = crates.filter((c) => c.licences.some((id) => SOURCE_OFFER.has(id)));
    const out = [
        `LabelPilot client ${version} - third-party software notices`,
        '',
        'LabelPilot (c) Hryhorii Fedorovskyi, Hilden, Germany. LabelPilot itself is proprietary',
        'software; the components below are used under their own licences, reproduced here.',
        '',
        'Source code of the components under the Mozilla Public License 2.0 is available, unmodified,',
        'from the locations below:',
        ...offered.map((c) => `  ${c.name} ${c.version}: https://crates.io/crates/${c.name}/${c.version} (${c.url})`),
        '',
        'The station user interface is made with Slint (https://slint.dev), used under the Slint',
        'Royalty-free Desktop, Mobile, and Web Applications License 2.0.',
        section('Rust crates'),
        grouped(crates),
        section('Native libraries inside the crates above'),
        native.components.map((c) => [
            `* ${c.name} - ${c.via} (${c.license}) ${c.url}`, '',
            c.text ? vendored(c.text) : `${c.copyright}\n\n${standardText(c.spdx, crates)}`,
        ].join('\n')).join(`\n\n${'-'.repeat(78)}\n\n`),
        section('Fonts'),
        native.fonts.map((f) => [
            `* ${f.name} (${f.license})`, fontCopyright(path.join(root, f.file)), '',
            vendored(f.text ?? 'ofl-1.1.txt'),
        ].join('\n')).join(`\n\n${'-'.repeat(78)}\n\n`),
        section('npm packages of the web interface'),
        grouped(npm),
        '',
    ].join('\n');
    return out;
}

const text = build();
if (process.argv.includes('--check')) {
    // A checkout may have turned the line endings into CRLF.
    const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8').replace(/\r\n/g, '\n') : '';
    assert.ok(current === text, 'resources/THIRD-PARTY-NOTICES.txt is out of date: run node scripts/generate-third-party-notices.cjs');
    console.log('Third-party notices: up to date, every licence on the allow list');
} else {
    fs.writeFileSync(OUTPUT, text, 'utf8');
    console.log(`Wrote ${path.relative(root, OUTPUT)} (${Math.round(text.length / 1024)} KB)`);
}
