"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.testConnection = testConnection;
const axios_1 = __importDefault(require("axios"));
/**
 * testConnection: Lightweight server check.
 * Uses the server's new /api/v1/stations/ping/ endpoint.
 */
async function testConnection(serverIp) {
    if (!serverIp)
        throw new Error('Server IP not provided');
    // Default Port is 8000 (Django server)
    const baseUrl = `http://${serverIp}:8000/api/v1`;
    try {
        // Get Local UUID for the ping (identification)
        const { getClientUUID } = require('./database');
        const uuid = getClientUUID();
        if (!uuid) {
            try {
                console.log('Connection Test: Station is unconfigured (no UUID). Skipping ping.');
            }
            catch (e) { }
            return false;
        }
        // Log locally for debugging
        try {
            console.log(`Connection Test: Pinging ${baseUrl}/stations/ping/?station_uuid=${uuid}`);
        }
        catch (e) { }
        const response = await axios_1.default.get(`${baseUrl}/stations/ping/`, {
            params: { station_uuid: uuid },
            timeout: 3000
        });
        // Verify LabelPilot specific response
        if (response.data && response.data.status === 'online') {
            try {
                console.log('Connection Test: SUCCESS (LabelPilot Server identified)');
            }
            catch (e) { }
            return true;
        }
        try {
            console.warn('Connection Test: Unexpected response format:', response.data);
        }
        catch (e) { }
        return false;
    }
    catch (err) {
        if (err.response) {
            try {
                console.error(`Connection Test Server Error: ${err.response.status}`);
            }
            catch (e) { }
        }
        else {
            try {
                console.error('Connection Test Error:', err.message);
            }
            catch (e) { }
        }
        return false;
    }
}
