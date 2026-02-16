"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TcpStrategy = void 0;
const net = __importStar(require("net"));
class TcpStrategy {
    socket = null;
    connected = false;
    // private config: PrinterDeviceConfig | null = null;
    async connect(config) {
        // this.config = config;
        return new Promise((resolve, reject) => {
            if (this.socket) {
                this.disconnect();
            }
            if (!config.ip) {
                return reject(new Error('IP address missing for TCP printer'));
            }
            const socket = new net.Socket();
            socket.setTimeout(3000); // 3s connection timeout
            socket.once('connect', () => {
                this.socket = socket;
                this.connected = true;
                // Remove timeout listener/setup for long-lived connection if needed
                socket.setTimeout(0);
                resolve();
            });
            socket.once('error', (err) => {
                this.connected = false;
                reject(err);
            });
            socket.once('timeout', () => {
                socket.destroy();
                this.connected = false;
                reject(new Error('Connection timed out'));
            });
            socket.connect(config.port || 9100, config.ip);
        });
    }
    async disconnect() {
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        this.connected = false;
    }
    async send(data) {
        return new Promise((resolve, reject) => {
            if (!this.socket || !this.connected) {
                // Auto-reconnect attempt could go here, but let's fail fast for now
                return reject(new Error('Printer not connected'));
            }
            this.socket.write(data, (err) => {
                if (err)
                    reject(err);
                else
                    resolve();
            });
        });
    }
    isConnected() {
        // We might want to check if socket is actually writable
        return this.connected && !!this.socket && !this.socket.destroyed;
    }
}
exports.TcpStrategy = TcpStrategy;
