import type {
    TauriPrinterGenerationPlan,
    TauriPrinterStatusReport,
    TauriUniversalPrinterPlan,
} from './tauriBridge';
import {
    getTauriDurableQueueSummary,
    getTauriIngressSummary,
    getTauriNetworkSummary,
    getTauriPrinterGeneratorSummary,
    getTauriPrinterTransportSummary,
    getTauriRuntimeSummary,
    getTauriScaleSummary,
    planTauriPrinterBackend,
    planTauriPrinterGeneration,
    queryTauriPrinterStatus,
} from './tauriBridge';
import { printTauriLabel } from './tauriPrintOrchestrator';

export type PrinterRole = 'packPrinter' | 'boxPrinter' | 'palletPrinter';
export type PrinterConfig = Record<string, unknown>;

export interface CalibrationResult {
    attemptedAt: string;
    widthMm: number;
    heightMm: number;
    durationMs: number;
    success: boolean;
}

export interface PrinterDiagnosticResult {
    role: PrinterRole;
    startedAt: string;
    durationMs: number;
    success: boolean;
    statusQueryMs?: number;
    planningMs?: number;
    status?: TauriPrinterStatusReport;
    backendPlan?: TauriUniversalPrinterPlan;
    generationPlan?: TauriPrinterGenerationPlan;
    errors: string[];
    calibration?: CalibrationResult;
}

const PUBLIC_CONFIG_KEYS = [
    'id', 'name', 'active', 'connection', 'protocol', 'compatibilityMode',
    'detectedProfileId', 'ip', 'port', 'serialPort', 'baudRate', 'driverName',
    'dpi', 'widthMm', 'heightMm', 'printTarget', 'pageFit',
    'persistentConnection', 'darkness', 'printSpeed', 'gapMm',
] as const;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function roundedDuration(started: number): number {
    return Math.max(0, Math.round((performance.now() - started) * 10) / 10);
}

export function sanitizePrinterConfig(config: PrinterConfig): PrinterConfig {
    const result: PrinterConfig = {};
    for (const key of PUBLIC_CONFIG_KEYS) {
        if (config[key] !== undefined) result[key] = config[key];
    }
    return result;
}

export function defaultCalibrationSize(role: PrinterRole, config: PrinterConfig): { widthMm: number; heightMm: number } {
    const pageSheet = role === 'palletPrinter' && (
        String(config.printTarget ?? '').toLowerCase() === 'page-sheet'
        || String(config.connection ?? '').toLowerCase() === 'windows_driver'
        || String(config.protocol ?? '').toLowerCase() === 'browser'
    );
    const widthMm = Number(config.widthMm);
    const heightMm = Number(config.heightMm);
    return {
        widthMm: Number.isFinite(widthMm) && widthMm > 0 ? widthMm : (pageSheet ? 210 : 58),
        heightMm: Number.isFinite(heightMm) && heightMm > 0 ? heightMm : (pageSheet ? 297 : 40),
    };
}

function rect(id: string, x: number, y: number, w: number, h: number): Record<string, unknown> {
    return { id, type: 'rect', x, y, w, h, fill: '#000000', backgroundColor: '#000000' };
}

export function buildCalibrationLabel(role: PrinterRole, config: PrinterConfig, widthMm: number, heightMm: number): Record<string, unknown> {
    const pageSheet = String(config.printTarget ?? '').toLowerCase() === 'page-sheet'
        || (role === 'palletPrinter' && (String(config.connection ?? '').toLowerCase() === 'windows_driver' || String(config.protocol ?? '').toLowerCase() === 'browser'));
    const safeWidth = Math.min(500, Math.max(20, Number(widthMm) || 58));
    const safeHeight = Math.min(500, Math.max(20, Number(heightMm) || 40));
    const canvasWidth = 1000;
    const canvasHeight = Math.min(1400, Math.max(400, Math.round(canvasWidth * safeHeight / safeWidth)));
    const margin = Math.max(12, Math.round(Math.min(canvasWidth, canvasHeight) * 0.025));
    const elements: Record<string, unknown>[] = [
        rect('border-top', margin, margin, canvasWidth - margin * 2, 4),
        rect('border-bottom', margin, canvasHeight - margin - 4, canvasWidth - margin * 2, 4),
        rect('border-left', margin, margin, 4, canvasHeight - margin * 2),
        rect('border-right', canvasWidth - margin - 4, margin, 4, canvasHeight - margin * 2),
        rect('center-v', Math.round(canvasWidth / 2), margin, 2, canvasHeight - margin * 2),
        rect('center-h', margin, Math.round(canvasHeight / 2), canvasWidth - margin * 2, 2),
    ];
    const xScale = (canvasWidth - margin * 2) / safeWidth;
    const yScale = (canvasHeight - margin * 2) / safeHeight;
    for (let mm = 10; mm < safeWidth; mm += 10) {
        const x = Math.round(margin + mm * xScale);
        elements.push(rect(`tick-x-top-${mm}`, x, margin, 2, 22));
        elements.push(rect(`tick-x-bottom-${mm}`, x, canvasHeight - margin - 22, 2, 22));
    }
    for (let mm = 10; mm < safeHeight; mm += 10) {
        const y = Math.round(margin + mm * yScale);
        elements.push(rect(`tick-y-left-${mm}`, margin, y, 22, 2));
        elements.push(rect(`tick-y-right-${mm}`, canvasWidth - margin - 22, y, 22, 2));
    }
    const qrSize = Math.max(100, Math.min(220, Math.round(canvasHeight * 0.24)));
    const codeValue = `LP${Date.now().toString().slice(-10)}`;
    elements.push(
        { id: 'title', type: 'text', x: margin + 28, y: margin + 28, w: canvasWidth - margin * 2 - 56, h: 58, text: 'LABELPILOT / КАЛИБРОВКА', fontSize: 32, fontWeight: 'bold', align: 'center' },
        { id: 'meta', type: 'text', x: margin + 28, y: margin + 88, w: canvasWidth - margin * 2 - 56, h: 38, text: `${role} · ${safeWidth} × ${safeHeight} mm · ${Number(config.dpi ?? 203)} DPI`, fontSize: 21, align: 'center' },
        { id: 'chars', type: 'text', x: margin + 32, y: Math.round(canvasHeight * 0.29), w: canvasWidth - margin * 2 - 64, h: 48, text: 'ABC abc 0123456789 · АБВ абв · ÄÖÜ', fontSize: 25, align: 'center' },
        { id: 'code128', type: 'barcode', x: margin + 48, y: Math.round(canvasHeight * 0.55), w: Math.max(260, canvasWidth - margin * 2 - qrSize - 120), h: Math.max(95, Math.round(canvasHeight * 0.2)), barcodeType: 'code128', value: codeValue, showText: true },
        { id: 'qr', type: 'barcode', x: canvasWidth - margin - qrSize - 38, y: Math.round(canvasHeight * 0.52), w: qrSize, h: qrSize, barcodeType: 'qrcode', value: `LP|${role}|${safeWidth}x${safeHeight}|${Number(config.dpi ?? 203)}` },
        { id: 'footer', type: 'text', x: margin + 28, y: canvasHeight - margin - 62, w: canvasWidth - margin * 2 - 56, h: 34, text: 'Углы · центр · штрихи каждые 10 мм', fontSize: 18, align: 'center' },
    );
    return {
        name: 'LabelPilot printer calibration',
        dpi: Number(config.dpi ?? 203),
        canvas: { width: canvasWidth, height: canvasHeight, widthCm: safeWidth / 10, heightCm: safeHeight / 10, labelType: pageSheet ? 'pallet' : 'label' },
        elements,
    };
}

export async function probePrinter(role: PrinterRole, config: PrinterConfig): Promise<PrinterDiagnosticResult> {
    const started = performance.now();
    const result: PrinterDiagnosticResult = { role, startedAt: new Date().toISOString(), durationMs: 0, success: false, errors: [] };
    const size = defaultCalibrationSize(role, config);
    const doc = buildCalibrationLabel(role, config, size.widthMm, size.heightMm);
    const statusStarted = performance.now();
    try {
        result.status = await queryTauriPrinterStatus(config);
    } catch (error) {
        result.errors.push(errorMessage(error));
    } finally {
        result.statusQueryMs = roundedDuration(statusStarted);
    }
    const planningStarted = performance.now();
    const [backend, generation] = await Promise.allSettled([
        planTauriPrinterBackend({ config, doc }),
        planTauriPrinterGeneration({ config, doc, data: {} }),
    ]);
    result.planningMs = roundedDuration(planningStarted);
    if (backend.status === 'fulfilled') result.backendPlan = backend.value;
    else result.errors.push(errorMessage(backend.reason));
    if (generation.status === 'fulfilled') result.generationPlan = generation.value;
    else result.errors.push(errorMessage(generation.reason));
    result.success = result.errors.length === 0 && !!result.backendPlan?.ready && !!result.status?.reachable;
    result.durationMs = roundedDuration(started);
    return result;
}

export async function printCalibration(role: PrinterRole, config: PrinterConfig, widthMm: number, heightMm: number): Promise<CalibrationResult> {
    const started = performance.now();
    const safeConfig = { ...config, widthMm, heightMm };
    const success = await printTauriLabel({
        labelDoc: buildCalibrationLabel(role, safeConfig, widthMm, heightMm),
        data: {},
        printerConfig: safeConfig,
        jobIdempotencyKey: `printer-calibration:${role}:${Date.now()}`,
    });
    return { attemptedAt: new Date().toISOString(), widthMm, heightMm, durationMs: roundedDuration(started), success };
}

async function settled<T>(promise: Promise<T>): Promise<T | { error: string }> {
    try { return await promise; } catch (error) { return { error: errorMessage(error) }; }
}

export async function buildDiagnosticReport(
    appVersion: string,
    configs: Partial<Record<PrinterRole, PrinterConfig>>,
    results: Partial<Record<PrinterRole, PrinterDiagnosticResult>>,
): Promise<Record<string, unknown>> {
    const [runtime, network, ingress, scale, transport, durableQueue, generator] = await Promise.all([
        settled(getTauriRuntimeSummary()), settled(getTauriNetworkSummary()), settled(getTauriIngressSummary()),
        settled(getTauriScaleSummary()), settled(getTauriPrinterTransportSummary()),
        settled(getTauriDurableQueueSummary()), settled(getTauriPrinterGeneratorSummary()),
    ]);
    return {
        schemaVersion: 1,
        kind: 'labelpilot-printer-diagnostic',
        generatedAt: new Date().toISOString(),
        app: { version: appVersion, runtime: window.desktopBridge?.runtime ?? 'unknown' },
        environment: {
            userAgent: navigator.userAgent,
            language: navigator.language,
            hardwareConcurrency: navigator.hardwareConcurrency,
            deviceMemoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
            viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
            screen: { width: window.screen.width, height: window.screen.height },
        },
        runtimeSummaries: { runtime, network, ingress, scale, transport, durableQueue, generator },
        printers: Object.fromEntries(Object.entries(configs).map(([role, config]) => [role, sanitizePrinterConfig(config)])),
        diagnostics: results,
    };
}
