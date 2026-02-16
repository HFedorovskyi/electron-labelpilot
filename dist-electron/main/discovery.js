"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.discoveryManager = exports.DiscoveryManager = void 0;
const dgram_1 = __importDefault(require("dgram"));
const os_1 = require("os");
const database_1 = require("./database");
const DISCOVERY_PORT = 5555;
const BROADCAST_ADDR = '255.255.255.255';
class DiscoveryManager {
    socket;
    mode = 'station';
    broadcastInterval = null;
    mainWindow = null;
    constructor() {
        this.socket = dgram_1.default.createSocket({ type: 'udp4', reuseAddr: true });
        this.socket.on('message', (msg, rinfo) => this.handleMessage(msg, rinfo));
        this.socket.on('error', (err) => console.error('Discovery Error:', err));
        this.socket.bind(0, () => {
            this.socket.setBroadcast(true);
            console.log(`Discovery: Listening on port ${this.socket.address().port}`);
        });
    }
    setMainWindow(win) {
        this.mainWindow = win;
    }
    setMode(mode) {
        console.log(`Discovery: Switching to ${mode} mode`);
        this.mode = mode;
        this.startBroadcasting();
    }
    getLocalIp() {
        const nets = (0, os_1.networkInterfaces)();
        for (const name of Object.keys(nets)) {
            for (const net of nets[name]) {
                if (net.family === 'IPv4' && !net.internal) {
                    return net.address;
                }
            }
        }
        return '127.0.0.1';
    }
    startBroadcasting() {
        if (this.broadcastInterval)
            clearInterval(this.broadcastInterval);
        this.broadcastInterval = setInterval(() => {
            try {
                const msg = JSON.stringify({
                    type: this.mode === 'server' ? 'LABELPILOT_SERVER' : 'LABELPILOT_STATION',
                    ip: this.getLocalIp(),
                    uuid: (0, database_1.getClientUUID)(),
                    port: 5556,
                    timestamp: Date.now()
                });
                this.socket.send(msg, DISCOVERY_PORT, BROADCAST_ADDR, (err) => {
                    if (err)
                        console.error('Discovery Broadcast Error:', err);
                });
                this.socket.send(msg, DISCOVERY_PORT, '127.0.0.1', (err) => {
                    if (err) { /* ignore loopback errors */ }
                });
            }
            catch (e) {
                console.error("Broadcast preparation error:", e);
            }
        }, 3000);
    }
    handleMessage(msg, rinfo) {
        try {
            if (this.getLocalIp() === rinfo.address)
                return;
            const message = JSON.parse(msg.toString());
            if (this.mode === 'station' && message.type === 'LABELPILOT_SERVER') {
                const serverPort = message.port || 8000;
                console.log(`Discovery: Found Server at ${rinfo.address}:${serverPort}`);
                this.mainWindow?.webContents.send('discovery-event', {
                    type: 'server-found',
                    ip: rinfo.address,
                    port: serverPort,
                    ...message
                });
            }
            else if (this.mode === 'server' && message.type === 'LABELPILOT_STATION') {
                console.log(`Discovery: Found Station at ${rinfo.address}`);
                this.mainWindow?.webContents.send('discovery-event', {
                    type: 'station-found',
                    ip: rinfo.address,
                    ...message
                });
            }
        }
        catch (e) { }
    }
    stop() {
        if (this.broadcastInterval)
            clearInterval(this.broadcastInterval);
        this.socket.close();
    }
}
exports.DiscoveryManager = DiscoveryManager;
exports.discoveryManager = new DiscoveryManager();
