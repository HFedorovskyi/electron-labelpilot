import fs from 'fs';
import path from 'path';
import { app, BrowserWindow } from 'electron';

import { buildReportPayload } from './offline_sync';
import { uploadReport } from './report_upload';
import { getReportState, setReportState } from './report_state';
import { loadPrinterConfig } from './config';
import { serverStatusManager } from './server_status';
import { hasLicenseToken } from './encryption';

// Marking-report exchange (station -> server). On each trigger we build a DELTA report
// (only packs/errors newer than the watermark); if the server is reachable we POST it,
// otherwise we spool the encrypted blob to userData/outbox and a background flusher retries
// it on the periodic timer and on reconnect. The interactive "Export to USB" button is the
// manual escape hatch for long/permanent outages.

function outboxDir(): string {
    const dir = path.join(app.getPath('userData'), 'outbox');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    return dir;
}

// All outbox work runs on one serial chain so concurrent triggers (box-close + pallet-close
// + periodic + reconnect) never build overlapping deltas or interleave a flush with a send.
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn) as Promise<T>;
    chain = next.catch(() => undefined);
    return next;
}

function reportLang(): string {
    try { return (loadPrinterConfig() as any).language || 'ru'; } catch { return 'ru'; }
}
function autoReportEnabled(): boolean {
    try { return (loadPrinterConfig() as any).autoReport !== false; } catch { return true; }
}
function intervalMs(): number {
    try { return (loadPrinterConfig() as any).reportIntervalMs || 5 * 60 * 1000; } catch { return 5 * 60 * 1000; }
}
function serverIp(): string {
    try { return loadPrinterConfig().serverIp || ''; } catch { return ''; }
}

function spool(blob: Buffer): void {
    const f = path.join(outboxDir(), `report_${Date.now()}_${Math.floor(Math.random() * 1e6)}.lpr`);
    fs.writeFileSync(f, blob);
}

// A station with no license token cannot encrypt its reports, so they can be neither sent nor
// spooled. The marking data is NOT lost (the watermark is never advanced, so the rows stay in
// the local DB and upload once a valid .lpi is imported) — but this must be VISIBLE, not a
// silent drop. Rate-limited so a recurring trigger warns at most ~once per 30 min.
let lastLicenseWarnAt = 0;
function warnNotLicensed(): void {
    const now = Date.now();
    if (now - lastLicenseWarnAt < 30 * 60 * 1000) return;
    lastLicenseWarnAt = now;
    console.warn('[outbox] marking data is pending but this station has NO license — reports are not being recorded for upload until a station identity (.lpi) is imported.');
    try {
        for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.webContents.send('report-warning', { reason: 'no-license' });
        }
    } catch { /* ignore */ }
}

/** Build a delta report for everything new since the watermark; send if online, else spool. */
export function enqueueReport(reason: string): Promise<void> {
    return serialize(async () => {
        if (!autoReportEnabled()) return;
        const st = getReportState();
        let built;
        try {
            built = buildReportPayload({ sincePackId: st.lastPackId, sinceErrorId: st.lastErrorId });
        } catch (e) {
            // The usual cause is encrypt() throwing because no license token is stored yet
            // (station not activated). Surface that distinctly instead of dropping silently.
            if (!hasLicenseToken()) warnNotLicensed();
            else console.error('[outbox] build failed:', e);
            return;
        }
        if (!built.hasData) return;

        const ip = serverIp();
        let sent = false;
        if (ip && serverStatusManager.getStatus() === 'connected') {
            try { sent = (await uploadReport(ip, built.blob, reportLang())).ok; } catch { sent = false; }
        }
        if (!sent) {
            try { spool(built.blob); } catch (e) { console.error('[outbox] spool failed (keeping watermark):', e); return; }
        }
        // Only advance the watermark once the data is durably sent OR spooled.
        setReportState({ lastPackId: built.maxPackId, lastErrorId: built.maxErrorId });
        console.log(`[outbox] report(${reason}): ${built.labelCount} labels, ${built.logCount} logs -> ${sent ? 'sent' : 'spooled'}`);
    });
}

/** Drain the spool: re-POST each pending blob, deleting it on success; stop on first failure. */
export function flushOutbox(): Promise<void> {
    return serialize(async () => {
        const ip = serverIp();
        if (!ip || serverStatusManager.getStatus() !== 'connected') return;
        let files: string[];
        try { files = fs.readdirSync(outboxDir()).filter((f) => f.endsWith('.lpr')).sort(); } catch { return; }
        for (const name of files) {
            const p = path.join(outboxDir(), name);
            let blob: Buffer;
            try { blob = fs.readFileSync(p); } catch { continue; }
            const r = await uploadReport(ip, blob, reportLang());
            if (r.ok) {
                try { fs.unlinkSync(p); } catch { /* ignore */ }
            } else {
                break; // server unreachable again — retry on the next tick
            }
        }
    });
}

let timer: NodeJS.Timeout | null = null;

export function startReportScheduler(): void {
    stopReportScheduler();
    const tick = async () => {
        await enqueueReport('periodic');
        await flushOutbox();
        const base = intervalMs();
        // Jitter ±20% so many stations don't all hit the server on the same tick.
        timer = setTimeout(tick, base + Math.floor(base * 0.2 * Math.random()));
    };
    const base = intervalMs();
    timer = setTimeout(tick, base + Math.floor(base * 0.2 * Math.random()));

    // A reconnect immediately drains whatever queued while the LAN was down.
    serverStatusManager.onReconnect(() => { void flushOutbox().then(() => enqueueReport('reconnect')); });
}

export function stopReportScheduler(): void {
    if (timer) { clearTimeout(timer); timer = null; }
}
