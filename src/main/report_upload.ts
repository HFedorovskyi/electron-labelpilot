import axios from 'axios';
import FormData from 'form-data';

/**
 * POST an encrypted .lpr report blob to the server's upload_report endpoint — the SAME
 * payload the USB export writes, just over HTTP. Mirrors license.ts conventions:
 * base url http://<ip>:8000/api/v1, short timeout, and NEVER throws (returns ok/false)
 * so the caller can fall back to the USB outbox.
 */
export async function uploadReport(
    serverIp: string,
    blob: Buffer,
    lang = 'ru',
): Promise<{ ok: boolean; status?: number; error?: string }> {
    if (!serverIp) return { ok: false, error: 'no server ip' };
    try {
        const form = new FormData();
        form.append('file', blob, { filename: 'report.lpr', contentType: 'application/octet-stream' });
        const res = await axios.post(
            `http://${serverIp}:8000/api/v1/stations/upload_report/`,
            form,
            {
                headers: { ...form.getHeaders(), 'X-Lang': lang },
                timeout: 8000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            },
        );
        return { ok: res.status === 200, status: res.status };
    } catch (e: any) {
        return { ok: false, status: e?.response?.status, error: e?.message || String(e) };
    }
}
