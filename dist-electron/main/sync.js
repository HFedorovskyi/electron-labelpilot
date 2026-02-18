"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.testConnectionFull = testConnectionFull;
exports.testConnection = testConnection;
const axios_1 = __importDefault(require("axios"));
const compatibility_1 = require("./updater/compatibility");
const logger_1 = __importDefault(require("./logger"));
/**
 * testConnection: Lightweight server check with version info.
 * Uses /api/v1/stations/ping/ and returns full ServerInfo.
 * The server should respond with: { status, server_version, min_client_version }
 */
async function testConnectionFull(serverIp) {
    if (!serverIp) {
        return { online: false, compatible: true };
    }
    const baseUrl = `http://${serverIp}:8000/api/v1`;
    try {
        const { getClientUUID } = require('./database');
        const uuid = getClientUUID();
        if (!uuid) {
            logger_1.default.info('Connection Test: Station is unconfigured (no UUID). Skipping ping.');
            return { online: false, compatible: true };
        }
        logger_1.default.info(`Connection Test: Pinging ${baseUrl}/stations/ping/?station_uuid=${uuid}`);
        const response = await axios_1.default.get(`${baseUrl}/stations/ping/`, {
            params: { station_uuid: uuid },
            timeout: 3000
        });
        if (response.data && response.data.status === 'online') {
            const serverVersion = response.data.server_version;
            const minClientVersion = response.data.min_client_version;
            // Level 2 compatibility check
            const compatResult = (0, compatibility_1.checkOnlineCompatibility)(minClientVersion);
            if (!compatResult.compatible) {
                logger_1.default.warn(`Connection Test: Client is outdated. ${compatResult.reason}`);
            }
            else {
                logger_1.default.info(`Connection Test: SUCCESS. Server v${serverVersion ?? 'unknown'}`);
            }
            return {
                online: true,
                serverVersion,
                minClientVersion,
                compatible: compatResult.compatible,
                compatibilityReason: compatResult.reason,
            };
        }
        logger_1.default.warn('Connection Test: Unexpected response format:', response.data);
        return { online: false, compatible: true };
    }
    catch (err) {
        if (err.response) {
            logger_1.default.error(`Connection Test Server Error: ${err.response.status}`);
        }
        else {
            logger_1.default.error('Connection Test Error:', err.message);
        }
        return { online: false, compatible: true };
    }
}
/**
 * Legacy boolean wrapper — keeps existing callers working unchanged.
 */
async function testConnection(serverIp) {
    const info = await testConnectionFull(serverIp);
    return info.online;
}
