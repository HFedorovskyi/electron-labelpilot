import dgram from 'dgram';
import { networkInterfaces } from 'os';
import { BrowserWindow } from 'electron';
import { getOrCreateClientUUID } from './database';

const DISCOVERY_PORT = 5555;
const BROADCAST_ADDR = '255.255.255.255';

export class DiscoveryManager {
    private socket: dgram.Socket;
    private mode: 'server' | 'station' = 'station';
    private broadcastInterval: NodeJS.Timeout | null = null;
    private mainWindow: BrowserWindow | null = null;
    // private discoveredEndpoints: Map<string, any> = new Map();

    constructor() {
        this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        this.socket.on('message', (msg, rinfo) => this.handleMessage(msg, rinfo));
        this.socket.on('error', (err) => console.error('Discovery Error:', err));

        // Bind to random port to avoid conflict with Docker/Server on localhost
        this.socket.bind(0, () => {
            this.socket.setBroadcast(true);
            console.log(`Discovery: Listening on port ${this.socket.address().port}`);
        });
    }

    setMainWindow(win: BrowserWindow) {
        this.mainWindow = win;
    }

    setMode(mode: 'server' | 'station') {
        console.log(`Discovery: Switching to ${mode} mode`);
        this.mode = mode;
        this.startBroadcasting();
    }

    private getLocalIp() {
        const nets = networkInterfaces();
        for (const name of Object.keys(nets)) {
            for (const net of nets[name]!) {
                if (net.family === 'IPv4' && !net.internal) {
                    return net.address;
                }
            }
        }
        return '127.0.0.1';
    }

    private startBroadcasting() {
        if (this.broadcastInterval) clearInterval(this.broadcastInterval);

        this.broadcastInterval = setInterval(() => {
            try {
                const msg = JSON.stringify({
                    type: this.mode === 'server' ? 'LABELPILOT_SERVER' : 'LABELPILOT_STATION',
                    ip: this.getLocalIp(),
                    uuid: getOrCreateClientUUID(),
                    port: 5556,
                    timestamp: Date.now()
                });

                this.socket.send(msg, DISCOVERY_PORT, BROADCAST_ADDR, (err) => {
                    if (err) console.error('Discovery Broadcast Error:', err);
                });

                // Also send to 127.0.0.1 specifically to pierce Docker Desktop bridge
                this.socket.send(msg, DISCOVERY_PORT, '127.0.0.1', (err) => {
                    if (err) { /* ignore loopback errors */ }
                });
            } catch (e) {
                console.error("Broadcast preparation error:", e);
            }
        }, 3000);
    }

    private handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo) {
        try {
            // Ignore self-messages
            if (this.getLocalIp() === rinfo.address) return;

            const message = JSON.parse(msg.toString());

            // Only forward relevant messages based on mode
            if (this.mode === 'station' && message.type === 'LABELPILOT_SERVER') {
                // If message overrides port, use it, else default to 8000 (Django)
                const serverPort = message.port || 8000;

                console.log(`Discovery: Found Server at ${rinfo.address}:${serverPort}`);
                this.mainWindow?.webContents.send('discovery-event', {
                    type: 'server-found',
                    ip: rinfo.address,
                    port: serverPort,
                    ...message
                });
            } else if (this.mode === 'server' && message.type === 'LABELPILOT_STATION') {
                console.log(`Discovery: Found Station at ${rinfo.address}`);
                this.mainWindow?.webContents.send('discovery-event', {
                    type: 'station-found',
                    ip: rinfo.address,
                    ...message
                });
            }
        } catch (e) {
            // content format error
        }
    }

    stop() {
        if (this.broadcastInterval) clearInterval(this.broadcastInterval);
        this.socket.close();
    }
}

export const discoveryManager = new DiscoveryManager();
