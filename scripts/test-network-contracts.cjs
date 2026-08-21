'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const network = read('src-tauri/src/network.rs');
const commands = read('src-tauri/src/commands.rs');
const runtime = read('src-tauri/src/lib.rs');
const adapter = read('src/renderer/platform/tauriBridge.ts');

assert.match(network, /const HTTP_TIMEOUT: Duration = Duration::from_secs\(3\)/);
assert.match(network, /const MAX_DISCOVERY_DATAGRAM: usize = 4 \* 1024/);
assert.match(network, /pool_max_idle_per_host\(1\)/);
assert.match(network, /name\("labelpilot-network"\.to_owned\(\)\)/);
assert.match(network, /POLL_CONNECTED: Duration = Duration::from_secs\(15\)/);
assert.match(network, /POLL_DISCONNECTED: Duration = Duration::from_secs\(5\)/);
assert.match(network, /POLL_HIDDEN: Duration = Duration::from_secs\(60\)/);
assert.match(network, /LABELPILOT_STATION/);
assert.match(network, /LABELPILOT_SERVER/);
assert.match(network, /Ipv4Addr::BROADCAST/);
assert.match(network, /UdpSocket::bind\(\(Ipv4Addr::UNSPECIFIED, DISCOVERY_PORT\)\)/);
assert.match(network, /or_else\(\|_\| UdpSocket::bind\(\(Ipv4Addr::UNSPECIFIED, 0\)\)\)/);
assert.match(network, /Ipv4Addr::LOCALHOST/);
assert.match(network, /object\.insert\("type"\.to_owned\(\), json!\("server-found"\)\)/);
assert.match(network, /station_uuid/);
assert.match(network, /min_client_version/);
assert.match(network, /api\/v1\/license/);
assert.match(commands, /spawn_blocking/);
assert.match(runtime, /network\s*\.start\(app\.handle\(\)\.clone\(\)\)/);

for (const [channel, command] of [
    ['sync-data', 'desktop_sync_data'],
    ['get-server-status', 'desktop_get_server_status'],
    ['get-license-status', 'desktop_get_license_status'],
    ['set-app-mode', 'desktop_set_app_mode'],
    ['renderer-ready', 'desktop_renderer_ready'],
]) {
    assert.ok(adapter.includes(`'${channel}'`), `${channel} bridge mapping missing`);
    assert.ok(commands.includes(`fn ${command}`), `${command} command missing`);
    assert.ok(runtime.includes(`commands::${command}`), `${command} registration missing`);
}

console.log('Rust network contracts: bounded HTTP, adaptive polling, UDP discovery and 5 IPC mappings verified');
