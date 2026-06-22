// Fetch the prebuilt better-sqlite3 binary matching the installed Electron's ABI.
//
// Why this exists: a plain `npm install` rebuilds better-sqlite3 against the *system Node*
// ABI, which then fails to load under Electron (different ABI). better-sqlite3 publishes
// prebuilt binaries per Electron version, so we just download the right one — no MSVC /
// node-gyp compile needed. @napi-rs/canvas and @serialport/bindings-cpp are N-API
// (ABI-stable across runtimes) and need no rebuild.
//
// Run after every `npm install`:  npm run rebuild:electron
const { execSync } = require('child_process');
const path = require('path');

const electronVersion = require('electron/package.json').version;
const cwd = path.join(process.cwd(), 'node_modules', 'better-sqlite3');

console.log(`[rebuild:electron] better-sqlite3 prebuild for Electron ${electronVersion} (${process.platform}-${process.arch})`);

try {
    // execSync runs through a shell, so `npx` resolves to npx.cmd on Windows without the
    // Node 24 EINVAL restriction on spawning .cmd files directly.
    execSync(
        `npx -y prebuild-install@latest --runtime electron --target ${electronVersion} --arch ${process.arch} --platform ${process.platform}`,
        { cwd, stdio: 'inherit' }
    );
    console.log('[rebuild:electron] Done — native binary matches Electron ABI.');
} catch (e) {
    console.error('[rebuild:electron] FAILED:', e.message);
    console.error('[rebuild:electron] If no prebuild exists for this Electron version, install MSVC build tools and run `npx electron-rebuild -f -o better-sqlite3`.');
    process.exit(1);
}
