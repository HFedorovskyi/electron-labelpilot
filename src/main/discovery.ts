import dgram from 'dgram';
import { networkInterfaces } from 'os';
import { BrowserWindow } from 'electron';

const DISCOVERY_PORT = 5555;
const BROADCAST_ADDR = '255.255.255.255';

export class DiscoveryManager {
    private socket: dgram.Socket;
    private mode: 'server' | 'station' = 'station';
    private broadcastInterval: NodeJS.Timeout | null = null;
    private mainWindow: BrowserWindow | null = null;
    private discoveredEndpoints: Map<string, any> = new Map();

    constructor() {
        this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        this.socket.on('message', (msg, rinfo) => this.handleMessage(msg, rinfo));
        this.socket.on('error', (err) => console.error('Discovery Error:', err));

        this.socket.bind(DISCOVERY_PORT, () => {
            this.socket.setBroadcast(true);
            console.log(`Discovery: Listening on port ${DISCOVERY_PORT}`);
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
            const msg = JSON.stringify({
                type: this.mode === 'server' ? 'LABELPILOT_SERVER' : 'LABELPILOT_STATION',
                ip: this.getLocalIp(),
                timestamp: Date.now()
            });

            this.socket.send(msg, DISCOVERY_PORT, BROADCAST_ADDR, (err) => {
                if (err) console.error('Discovery Broadcast Error:', err);
            });
        }, 3000);
    }

    private handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo) {
        try {
            // Ignore self-messages
            if (this.getLocalIp() === rinfo.address) return;

            const message = JSON.parse(msg.toString());
            const key = `${message.type}:${rinfo.address}`;

            // Debounce/Dedup logic can go here if needed, but for now we just forward
            // Only forward relevant messages based on mode
            if (this.mode === 'station' && message.type === 'LABELPILOT_SERVER') {
                console.log(`Discovery: Found Server at ${rinfo.address}`);
                this.mainWindow?.webContents.send('discovery-event', {
                    type: 'server-found',
                    ip: rinfo.address,
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
