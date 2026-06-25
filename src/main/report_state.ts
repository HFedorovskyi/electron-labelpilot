import fs from 'fs';
import path from 'path';
import { app } from 'electron';

/**
 * Watermark of what has already been put into a report, so each report carries only NEW
 * packs/labels and errors (not the whole table) — important when 10-20 stations report on
 * a 5-min cadence. Advanced only AFTER a report is successfully sent OR durably spooled to
 * the outbox; the server still dedupes (unique_id / event_uid), so a watermark glitch can
 * never double-count.
 */
export interface ReportState {
    lastPackId: number;
    lastErrorId: number;
}

const DEFAULT: ReportState = { lastPackId: 0, lastErrorId: 0 };

function statePath(): string {
    return path.join(app.getPath('userData'), 'report_state.json');
}

export function getReportState(): ReportState {
    try {
        return { ...DEFAULT, ...JSON.parse(fs.readFileSync(statePath(), 'utf-8')) };
    } catch {
        return { ...DEFAULT };
    }
}

export function setReportState(patch: Partial<ReportState>): void {
    try {
        fs.writeFileSync(statePath(), JSON.stringify({ ...getReportState(), ...patch }));
    } catch (e) {
        console.error('[report_state] write failed:', e);
    }
}
