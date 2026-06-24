import { useState, useEffect, useCallback } from 'react';

/** Mirror of the server's GET /api/v1/license/ payload (see src/main/license.ts). */
export interface LicenseStatus {
    licensed: boolean;
    mode: 'demo' | 'licensed';
    edition: string;
    customer: string | null;
    expires: string | null;
    expired: boolean;
    max_stations: number | null;       // null = unlimited (no station cap)
    demo_max_stations: number | null;   // null in demo — there is no station cap
    license_id: string | null;
    features: string[];
    machine_id: string;
    strict: boolean;
    signature_valid: boolean;
    machine_ok: boolean;
    stations_used: number;
}

interface LicenseFetchResult {
    online: boolean;
    license?: LicenseStatus;
}

/**
 * useLicenseStatus: non-blocking poll of the connected server's license/demo state.
 *
 * Re-fetches whenever the server connection comes up ('server-status-updated') and
 * after a data sync ('sync-complete'), plus on a slow background interval so a license
 * activation on the server is reflected without restarting the client. Stays null/neutral
 * when the server is offline or has no IP configured.
 */
export function useLicenseStatus(serverStatus?: string) {
    const [license, setLicense] = useState<LicenseStatus | null>(null);
    const [online, setOnline] = useState<boolean>(false);

    const refresh = useCallback(async () => {
        try {
            const res: LicenseFetchResult = await window.electron.invoke('get-license-status');
            if (res && res.online && res.license) {
                setLicense(res.license);
                setOnline(true);
            } else {
                setOnline(false);
                // Keep the last-known license so the badge doesn't flicker on a transient blip.
            }
        } catch {
            setOnline(false);
        }
    }, []);

    useEffect(() => {
        refresh();

        const removeStatus = window.electron.on('server-status-updated', (data: any) => {
            if (data?.status === 'connected') refresh();
        });
        const removeSync = window.electron.on('sync-complete', () => refresh());

        // Slow background refresh (60s) — license rarely changes; this just catches an
        // activation done on the server while the client is running.
        const interval = setInterval(refresh, 60000);

        return () => {
            removeStatus();
            removeSync();
            clearInterval(interval);
        };
    }, [refresh]);

    // Re-fetch when the connection state flips to connected (covers the case where the
    // hook is mounted while already connected, e.g. opening Settings later).
    useEffect(() => {
        if (serverStatus === 'connected') refresh();
    }, [serverStatus, refresh]);

    return { license, online, refresh };
}
