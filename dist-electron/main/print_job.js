"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processOnlinePrintJob = processOnlinePrintJob;
exports.processPrintJobFileData = processPrintJobFileData;
exports.importPrintJobFile = importPrintJobFile;
const electron_1 = require("electron");
const electron_2 = require("electron");
const fs_1 = __importDefault(require("fs"));
const encryption_1 = require("./encryption");
const identity_1 = require("./identity");
const logger_1 = __importDefault(require("./logger"));
// ── Online (HTTP POST /api/print_job) ──
function processOnlinePrintJob(data) {
    if (!data || data.type !== 'PRINT_JOB') {
        throw new Error('Invalid print job format: expected type PRINT_JOB');
    }
    const job = {
        job_id: data.job_id,
        nomenclature_id: data.nomenclature_id,
        nomenclature_name: data.nomenclature_name || '',
        nomenclature_article: data.nomenclature_article || '',
        quantity: data.quantity,
        quantity_unit: data.quantity_unit === 'kg' ? 'kg' : 'pcs',
        batch_number: data.batch_number || '',
        marking_date: data.marking_date || null,
    };
    validateJob(job);
    const { savePrintJob } = require('./database');
    savePrintJob(job);
    logger_1.default.info(`[PrintJob] Online job received: #${job.job_id} "${job.nomenclature_name}" qty=${job.quantity} ${job.quantity_unit}`);
    return job;
}
// ── USB (.lpj file) ──
function processPrintJobFileData(data) {
    const identity = (0, identity_1.loadIdentity)();
    const stationUuid = identity?.station_uuid;
    if (!stationUuid) {
        throw new Error('Station identity not configured. Import identity file first.');
    }
    let jobs = [];
    if (data.type === 'PRINT_JOB') {
        // Single station file — verify station UUID matches
        if (data.station && data.station.uuid !== stationUuid) {
            throw new Error(`Job file is for station "${data.station.name}" (${data.station.uuid}), not this station.`);
        }
        if (Array.isArray(data.jobs)) {
            jobs = data.jobs.map(normalizeJob);
        }
    }
    else if (data.type === 'PRINT_JOB_BUNDLE') {
        // Bundle — find our station in the list
        if (!Array.isArray(data.stations)) {
            throw new Error('Invalid PRINT_JOB_BUNDLE: missing stations array');
        }
        const myStation = data.stations.find((s) => s.station?.uuid === stationUuid);
        if (!myStation) {
            throw new Error(`No jobs found for this station (UUID: ${stationUuid}) in the bundle.`);
        }
        if (Array.isArray(myStation.jobs)) {
            jobs = myStation.jobs.map(normalizeJob);
        }
    }
    else {
        throw new Error(`Unknown print job file type: ${data.type}`);
    }
    // Validate and save each job
    const { savePrintJob } = require('./database');
    for (const job of jobs) {
        validateJob(job);
        savePrintJob(job);
    }
    logger_1.default.info(`[PrintJob] File import: ${jobs.length} job(s) loaded for station ${stationUuid}`);
    return jobs;
}
async function importPrintJobFile() {
    try {
        const result = await electron_2.dialog.showOpenDialog({
            title: 'Выберите файл задания (.lpj)',
            filters: [{ name: 'LabelPilot Print Job', extensions: ['lpj'] }],
            properties: ['openFile'],
        });
        if (result.canceled || result.filePaths.length === 0) {
            return { success: false, message: 'Cancelled' };
        }
        const filePath = result.filePaths[0];
        const content = fs_1.default.readFileSync(filePath);
        const data = (0, encryption_1.decrypt)(content);
        const jobs = processPrintJobFileData(data);
        // Notify all windows
        electron_1.BrowserWindow.getAllWindows().forEach((win) => {
            win.webContents.send('print-jobs-updated');
        });
        return { success: true, message: `Imported ${jobs.length} job(s)`, count: jobs.length };
    }
    catch (error) {
        logger_1.default.error('[PrintJob] File import error:', error);
        return { success: false, message: error.message };
    }
}
// ── Helpers ──
function normalizeJob(raw) {
    return {
        job_id: raw.job_id,
        nomenclature_id: raw.nomenclature_id,
        nomenclature_name: raw.nomenclature_name || '',
        nomenclature_article: raw.nomenclature_article || '',
        quantity: raw.quantity,
        quantity_unit: raw.quantity_unit === 'kg' ? 'kg' : 'pcs',
        batch_number: raw.batch_number || '',
        marking_date: raw.marking_date || null,
    };
}
function validateJob(job) {
    if (!job.job_id)
        throw new Error('Job missing job_id');
    if (!job.nomenclature_id)
        throw new Error('Job missing nomenclature_id');
    if (job.quantity <= 0)
        throw new Error('Job quantity must be positive');
}
