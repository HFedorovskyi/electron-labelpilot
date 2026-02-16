"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SerialStrategy = void 0;
const serialport_1 = require("serialport");
class SerialStrategy {
    port = null;
    connected = false;
    async connect(config) {
        return new Promise((resolve, reject) => {
            if (this.port && this.port.isOpen) {
                return resolve();
            }
            if (!config.serialPort) {
                return reject(new Error('Serial port name missing'));
            }
            this.port = new serialport_1.SerialPort({
                path: config.serialPort,
                baudRate: config.baudRate || 9600,
                autoOpen: false
            });
            this.port.open((err) => {
                if (err) {
                    this.connected = false;
                    reject(err);
                }
                else {
                    this.connected = true;
                    resolve();
                }
            });
        });
    }
    async disconnect() {
        return new Promise((resolve, reject) => {
            if (this.port && this.port.isOpen) {
                this.port.close((err) => {
                    this.port = null;
                    this.connected = false;
                    if (err)
                        reject(err);
                    else
                        resolve();
                });
            }
            else {
                this.connected = false;
                resolve();
            }
        });
    }
    async send(data) {
        return new Promise((resolve, reject) => {
            if (!this.port || !this.port.isOpen) {
                return reject(new Error('Serial port not open'));
            }
            this.port.write(data, (err) => {
                if (err)
                    reject(err);
                else {
                    this.port.drain((drainErr) => {
                        if (drainErr)
                            reject(drainErr);
                        else
                            resolve();
                    });
                }
            });
        });
    }
    isConnected() {
        return this.connected && !!this.port && this.port.isOpen;
    }
}
exports.SerialStrategy = SerialStrategy;
