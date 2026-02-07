"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('electron', {
    send: (channel, data) => electron_1.ipcRenderer.send(channel, data),
    on: (channel, func) => {
        const subscription = (_event, ...args) => func(...args);
        electron_1.ipcRenderer.on(channel, subscription);
        return () => electron_1.ipcRenderer.removeListener(channel, subscription);
    },
    invoke: (channel, data) => electron_1.ipcRenderer.invoke(channel, data),
});
