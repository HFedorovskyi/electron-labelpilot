/**
 * RamCacheCoordinator — decides whether a given printer supports the
 * ~DG / R:<file>.GRF / ^XG flow used by CanvasBitmapGenerator's RAM-cache.
 *
 * Strategy:
 *   1. Default decision for any unknown printer is 'inline' — safe for everyone.
 *   2. After the first real print, kick off a probe (fire-and-forget):
 *        a) ~DG R:LP_PROBE.GRF with a tiny known payload
 *        b) ^XA^HWR:LP_PROBE.GRF^XZ — Host Directory query
 *        c) read response within PROBE_TIMEOUT_MS
 *        d) if the response mentions LP_PROBE.GRF → RAM works → switch to 'ram'
 *        e) cleanup: ^XA^IDR:LP_PROBE.GRF^XZ
 *   3. On reconnect / error / TTL expiry → forget the decision and probe again.
 *
 * The probe only runs on strategies that expose `query()`. Spooler has no
 * read channel, so it stays on 'inline' forever (the safe path).
 *
 * config.ramCache overrides the decision:
 *   'on'   → always 'ram'
 *   'off'  → always 'inline'
 *   'auto' → use probe result, default 'inline' until probe confirms 'ram'
 */

import log from '../logger';
import type { PrinterDeviceConfig } from '../config';
import type { IConnectionStrategy } from './types';

type Decision = 'ram' | 'inline';
type ProbeState = 'unknown' | 'probing' | 'done';

interface Entry {
    decision: Decision;
    state: ProbeState;
    decidedAt: number;
}

// TCP replies arrive in tens of ms; serial at 9600 baud needs seconds for the ^HW
// directory listing to round-trip (hundreds of bytes at ~960B/s + printer processing).
// A flat 600ms silently locked every serial Zebra to the slow inline path.
const PROBE_TIMEOUT_TCP_MS = 600;
const PROBE_TIMEOUT_SERIAL_MS = 3000;
const PROBE_TTL_MS = 30 * 60 * 1000; // 30 min — re-probe periodically

class RamCacheCoordinator {
    private entries: Map<string, Entry> = new Map();

    /**
     * Synchronous decision lookup — never blocks the print path.
     * Honors explicit config.ramCache ('on'/'off'); 'auto' uses cached probe result.
     */
    getDecision(config: PrinterDeviceConfig): Decision {
        const mode = config.ramCache || 'auto';
        if (mode === 'on') return 'ram';
        if (mode === 'off') return 'inline';

        const entry = this.entries.get(config.id);
        if (!entry) return 'inline'; // first print → safe fallback
        // Stale-while-revalidate: past the TTL we keep honoring the last decision and
        // let the next maybeProbe() refresh it in the background. Hard-flipping to
        // 'inline' here would permanently degrade printers that print less often than
        // the TTL (the re-probe confirmation would always arrive after the label).
        return entry.decision;
    }

    /**
     * Invalidate cached decision — call on reconnect or printer error.
     * Next print falls back to 'inline' and a fresh probe will run.
     */
    invalidate(printerId: string): void {
        if (this.entries.delete(printerId)) {
            log.info(`[RamCacheCoordinator] decision invalidated for "${printerId}"`);
        }
    }

    /**
     * Kick off a probe if we haven't decided yet for this printer in 'auto' mode.
     * Fire-and-forget: caller doesn't await. Idempotent — multiple calls coalesce.
     */
    maybeProbe(config: PrinterDeviceConfig, strategy: IConnectionStrategy): void {
        void this.probeInternal(config, strategy);
    }

    /**
     * Awaitable probe for warmup paths (station entry): resolves once the decision is
     * known, so a warmupBackground() that follows sees 'ram' instead of the pre-probe
     * 'inline' default and can actually pre-upload. Off the print hot path.
     */
    async ensureDecision(config: PrinterDeviceConfig, strategy: IConnectionStrategy): Promise<Decision> {
        await this.probeInternal(config, strategy);
        return this.getDecision(config);
    }

    private probeInternal(config: PrinterDeviceConfig, strategy: IConnectionStrategy): Promise<void> {
        const mode = config.ramCache || 'auto';
        if (mode !== 'auto') return Promise.resolve(); // explicit on/off doesn't need probing

        const existing = this.entries.get(config.id);
        if (existing && existing.state !== 'unknown' &&
            Date.now() - existing.decidedAt < PROBE_TTL_MS) {
            return Promise.resolve(); // already decided or in-flight
        }

        if (typeof strategy.query !== 'function') {
            // No read channel (e.g. Windows spooler) — lock decision to inline.
            this.entries.set(config.id, { decision: 'inline', state: 'done', decidedAt: Date.now() });
            log.info(`[RamCacheCoordinator] "${config.id}" has no read channel → inline locked`);
            return Promise.resolve();
        }

        // Preserve the previous decision while the re-probe is in flight
        // (stale-while-revalidate) — only first-ever probes start from 'inline'.
        const carry = existing?.decision || 'inline';
        this.entries.set(config.id, { decision: carry, state: 'probing', decidedAt: Date.now() });
        return this.runProbe(config, strategy).catch((e) => {
            log.warn(`[RamCacheCoordinator] probe crashed for "${config.id}": ${e}`);
            this.entries.set(config.id, { decision: 'inline', state: 'done', decidedAt: Date.now() });
        });
    }

    private async runProbe(config: PrinterDeviceConfig, strategy: IConnectionStrategy): Promise<void> {
        if (!strategy.query) return;
        if (!strategy.isConnected()) {
            log.info(`[RamCacheCoordinator] probe skipped for "${config.id}" — not connected`);
            return;
        }

        // Tiny 1-byte all-black GRF: 1 row × 1 byte. Compressed RLE: "FF" (literal byte).
        const PROBE_NAME = 'LP_PROBE.GRF';
        const upload = `~DGR:${PROBE_NAME},1,1,FF\n`;
        const query = `^XA^HWR:LP_PROBE.GRF^XZ\n`;
        const cleanup = `^XA^IDR:LP_PROBE.GRF^XZ\n`;
        const timeoutMs = config.connection === 'serial' ? PROBE_TIMEOUT_SERIAL_MS : PROBE_TIMEOUT_TCP_MS;
        // Early-resolve as soon as the reply mentions the probe file — the warmup path
        // awaits this probe, so on TCP this turns a fixed 600ms wait into ~tens of ms.
        const doneWhen = (buf: Buffer) => buf.toString('ascii').toUpperCase().includes('LP_PROBE.GRF');

        try {
            const reply = await strategy.query(Buffer.from(upload + query, 'utf-8'), timeoutMs, doneWhen);

            let decision: Decision = 'inline';
            if (reply && reply.length > 0) {
                const text = reply.toString('ascii').toUpperCase();
                // Zebra ^HW response includes the file name when present.
                // Format: "-DIR R:*.* ... LP_PROBE.GRF       <size>"
                if (text.includes('LP_PROBE.GRF')) decision = 'ram';
            }

            this.entries.set(config.id, { decision, state: 'done', decidedAt: Date.now() });
            log.info(`[RamCacheCoordinator] probe done for "${config.id}" → ${decision} (reply ${reply?.length ?? 0}B)`);

            // Best-effort cleanup. Ignore errors — the file is 1 byte, no harm if it stays.
            try {
                if (strategy.isConnected()) await strategy.send(Buffer.from(cleanup, 'utf-8'));
            } catch { /* ignore */ }
        } catch (e) {
            log.warn(`[RamCacheCoordinator] probe failed for "${config.id}": ${e}`);
            this.entries.set(config.id, { decision: 'inline', state: 'done', decidedAt: Date.now() });
        }
    }
}

export const ramCacheCoordinator = new RamCacheCoordinator();
