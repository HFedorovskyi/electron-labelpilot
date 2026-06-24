import axios from 'axios';
import log from './logger';

/**
 * Shape of GET /api/v1/license/ (AllowAny) on the LabelPilot server.
 * Mirrors the server's serializer. Everything is optional on the client side so a
 * partial / older server response never throws — the UI degrades gracefully.
 */
export interface LicenseStatus {
    /** True only when the server reports a valid, active license. */
    licensed: boolean;
    /** 'demo' => product is UNLICENSED (seat-capped). 'licensed' => activated. */
    mode: 'demo' | 'licensed';
    edition: string;
    customer: string | null;
    expires: string | null;       // YYYY-MM-DD
    expired: boolean;
    max_stations: number;         // in demo this equals demo_max_stations
    demo_max_stations: number;
    license_id: string | null;
    features: string[];
    machine_id: string;
    strict: boolean;
    signature_valid: boolean;
    machine_ok: boolean;
    stations_used: number;
}

export interface LicenseFetchResult {
    /** True when the server answered the license endpoint. */
    online: boolean;
    license?: LicenseStatus;
}

/**
 * fetchLicenseStatus: ask the connected server whether it is in demo or licensed mode.
 * Reuses the same base-URL convention as testConnectionFull() (http://<ip>:8000/api/v1).
 * Never throws — returns { online:false } on any error so callers can render a neutral state.
 */
export async function fetchLicenseStatus(serverIp: string): Promise<LicenseFetchResult> {
    if (!serverIp) {
        return { online: false };
    }

    const baseUrl = `http://${serverIp}:8000/api/v1`;

    try {
        const response = await axios.get(`${baseUrl}/license/`, { timeout: 3000 });
        if (response.data && typeof response.data === 'object') {
            return { online: true, license: response.data as LicenseStatus };
        }
        log.warn('License Check: Unexpected response format:', response.data);
        return { online: false };
    } catch (err: any) {
        if (err.response) {
            log.error(`License Check Server Error: ${err.response.status}`);
        } else {
            log.error('License Check Error:', err.message);
        }
        return { online: false };
    }
}
