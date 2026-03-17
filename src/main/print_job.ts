import { BrowserWindow } from 'electron';
import { dialog } from 'electron';
import fs from 'fs';
import { decrypt } from './encryption';
import { loadIdentity } from './identity';
import log from './logger';

// ── Types ──

export interface PrintJob {
    job_id: number;
    nomenclature_id: number;
    nomenclature_name: string;
    nomenclature_article: string;
    quantity: number;
    quantity_unit: 'pcs' | 'kg';
    batch_number: string;
}

// ── Online (HTTP POST /api/print_job) ──

export function processOnlinePrintJob(data: any): PrintJob {
    if (!data || data.type !== 'PRINT_JOB') {
        throw new Error('Invalid print job format: expected type PRINT_JOB');
    }

    const job: PrintJob = {
        job_id: data.job_id,
        nomenclature_id: data.nomenclature_id,
        nomenclature_name: data.nomenclature_name || '',
        nomenclature_article: data.nomenclature_article || '',
        quantity: data.quantity,
        quantity_unit: data.quantity_unit === 'kg' ? 'kg' : 'pcs',
        batch_number: data.batch_number || '',
    };

    validateJob(job);

    const { savePrintJob } = require('./database');
    savePrintJob(job);

    log.info(`[PrintJob] Online job received: #${job.job_id} "${job.nomenclature_name}" qty=${job.quantity} ${job.quantity_unit}`);
    return job;
}

// ── USB (.lpj file) ──

export function processPrintJobFileData(data: any): PrintJob[] {
    const identity = loadIdentity();
    const stationUuid = identity?.station_uuid;

    if (!stationUuid) {
        throw new Error('Station identity not configured. Import identity file first.');
    }

    let jobs: PrintJob[] = [];

    if (data.type === 'PRINT_JOB') {
        // Single station file — verify station UUID matches
        if (data.station && data.station.uuid !== stationUuid) {
            throw new Error(`Job file is for station "${data.station.name}" (${data.station.uuid}), not this station.`);
        }

        if (Array.isArray(data.jobs)) {
            jobs = data.jobs.map(normalizeJob);
        }
    } else if (data.type === 'PRINT_JOB_BUNDLE') {
        // Bundle — find our station in the list
        if (!Array.isArray(data.stations)) {
            throw new Error('Invalid PRINT_JOB_BUNDLE: missing stations array');
        }

        const myStation = data.stations.find((s: any) => s.station?.uuid === stationUuid);
        if (!myStation) {
            throw new Error(`No jobs found for this station (UUID: ${stationUuid}) in the bundle.`);
        }

        if (Array.isArray(myStation.jobs)) {
            jobs = myStation.jobs.map(normalizeJob);
        }
    } else {
        throw new Error(`Unknown print job file type: ${data.type}`);
    }

    // Validate and save each job
    const { savePrintJob } = require('./database');
    for (const job of jobs) {
        validateJob(job);
        savePrintJob(job);
    }

    log.info(`[PrintJob] File import: ${jobs.length} job(s) loaded for station ${stationUuid}`);
    return jobs;
}

export async function importPrintJobFile(): Promise<{ success: boolean; message: string; count?: number }> {
    try {
        const result = await dialog.showOpenDialog({
            title: 'Выберите файл задания (.lpj)',
            filters: [{ name: 'LabelPilot Print Job', extensions: ['lpj'] }],
            properties: ['openFile'],
        });

        if (result.canceled || result.filePaths.length === 0) {
            return { success: false, message: 'Cancelled' };
        }

        const filePath = result.filePaths[0];
        const content = fs.readFileSync(filePath);
        const data = decrypt(content);
        const jobs = processPrintJobFileData(data);

        // Notify all windows
        BrowserWindow.getAllWindows().forEach((win) => {
            win.webContents.send('print-jobs-updated');
        });

        return { success: true, message: `Imported ${jobs.length} job(s)`, count: jobs.length };
    } catch (error: any) {
        log.error('[PrintJob] File import error:', error);
        return { success: false, message: error.message };
    }
}

// ── Helpers ──

function normalizeJob(raw: any): PrintJob {
    return {
        job_id: raw.job_id,
        nomenclature_id: raw.nomenclature_id,
        nomenclature_name: raw.nomenclature_name || '',
        nomenclature_article: raw.nomenclature_article || '',
        quantity: raw.quantity,
        quantity_unit: raw.quantity_unit === 'kg' ? 'kg' : 'pcs',
        batch_number: raw.batch_number || '',
    };
}

function validateJob(job: PrintJob): void {
    if (!job.job_id) throw new Error('Job missing job_id');
    if (!job.nomenclature_id) throw new Error('Job missing nomenclature_id');
    if (job.quantity <= 0) throw new Error('Job quantity must be positive');
}
