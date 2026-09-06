import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
    DesktopBridge,
    DesktopEventChannel,
    DesktopEventListener,
    DesktopInvokeChannel,
    DesktopSendChannel,
} from '../../shared/desktopBridge';

export interface TauriRuntimeSummary {
    runtime: 'tauri';
    invokeChannels: number;
    sendChannels: number;
    eventChannels: number;
    migratedCommands: string[];
}

export interface TauriNetworkSummary {
    status: 'connected' | 'disconnected';
    mode: 'station' | 'server';
    workerRunning: boolean;
    httpTimeoutMs: number;
    discoveryIntervalMs: number;
    discoveryDatagramLimit: number;
}
export interface TauriScaleSummary {
    status: 'connected' | 'connecting' | 'reconnecting' | 'disconnected';
    workerRunning: boolean;
    connectionType?: string;
    protocolId?: string;
    receivedFrames: number;
    emittedReadings: number;
    droppedReadings: number;
    reconnectAttempts: number;
    maxFrameBuffer: number;
    readingThrottleMs: number;
}
export interface TauriIngressSummary {
    bindAddress: string;
    workerRunning: boolean;
    headerTimeoutMs: number;
    requestTimeoutMs: number;
    syncBodyLimit: number;
    printJobBodyLimit: number;
    acceptedRequests: number;
    completedRequests: number;
    rejectedRequests: number;
}
export interface TauriTelemetrySummary {
    workerRunning: boolean;
    autoReportEnabled: boolean;
    intervalMs: number;
    uptimeMs: number;
    recordedEvents: number;
    reportCycles: number;
    sentReports: number;
    spooledReports: number;
    retriedReports: number;
    failedReports: number;
    deferredWithoutIdentity: number;
    pendingFiles: number;
    pendingBytes: number;
    outboxFileLimit: number;
    outboxByteLimit: number;
    lastSuccessAt?: string;
    lastError?: string;
}

export interface TauriPrinterTransportSummary {
    workerCount: number;
    queuedNow: number;
    activeNow: number;
    submittedJobs: number;
    completedJobs: number;
    failedJobs: number;
    rejectedJobs: number;
    bytesSent: number;
    reconnects: number;
    queueCapacityPerPrinter: number;
    maxWorkers: number;
    maxJobBytes: number;
    connectTimeoutMs: number;
    writeTimeoutMs: number;
    idleCloseMs: number;
    breakerMs: number;
    tcpJobs: number;
    serialJobs: number;
    spoolerJobs: number;
    driverBitmapJobs: number;
    driverPageJobs: number;
    deduplicatedJobs: number;
    idempotencyConflicts: number;
    uncertainJobs: number;
    idempotencyTtlMs: number;
    maxIdempotencyEntries: number;
    supportedConnections: string[];
    supportedPrintTargets: string[];
    availableBackends: string[];
}

export interface TauriRawPrintReceipt {
    printerId: string;
    physicalKey: string;
    bytes: number;
    queueMs: number;
    sendMs: number;
    attempts: number;
    reusedConnection: boolean;
    deliveryState: 'reachable' | 'transport-accepted' | 'spooler-accepted';
    confirmationMode: 'connect-probe' | 'transport-write' | 'windows-spooler';
    idempotencyKey?: string;
    deduplicated: boolean;
    durableJobId?: string;
    durableState?: TauriDurablePrintState;
}

export type TauriDurablePrintState =
    | 'queued'
    | 'rendering'
    | 'sending'
    | 'accepted'
    | 'uncertain'
    | 'failed'
    | 'cancelled';

export interface TauriDurablePrintJobRecord {
    jobId: string;
    state: TauriDurablePrintState;
    printerId: string;
    printerName: string;
    physicalKey: string;
    protocol: string;
    connection: string;
    idempotencyKey?: string;
    fingerprint: string;
    actionKind: 'raw' | 'driver-bitmap' | 'driver-page';
    payloadBytes: number;
    attemptCount: number;
    createdAtMs: number;
    updatedAtMs: number;
    acceptedAtMs?: number;
    lastError?: string;
    receipt?: TauriRawPrintReceipt;
}

export interface TauriDurableQueueSummary {
    queued: number;
    rendering: number;
    sending: number;
    accepted: number;
    uncertain: number;
    failed: number;
    cancelled: number;
    total: number;
    startupMarkedUncertain: number;
    maxRecoveryJobs: number;
    maxListJobs: number;
    retentionMs: number;
}

export interface TauriDurableJobUpdate {
    jobId: string;
    state: TauriDurablePrintState;
    error?: string;
    updatedAtMs: number;
}
export interface TauriPrinterStatusReport {
    printerId: string;
    printerName: string;
    physicalKey: string;
    protocol: string;
    connection: string;
    reachable: boolean;
    status: string;
    details: string[];
    supportsBidirectionalStatus: boolean;
    responseBytes: number;
    responsePreview?: string;
    rawResponseHex?: string;
    queriedAtMs: number;
}
export interface TauriPrinterGenerationRequest {
    config: Record<string, unknown>;
    doc: Record<string, unknown>;
    data: Record<string, unknown>;
}

export interface TauriPrinterGenerationPlan {
    requestedProtocol: string;
    effectiveProtocol: string;
    backend: 'rust-native' | 'renderer-bitmap' | 'tauri-raster-adapter';
    nativeEligible: boolean;
    profileId: string;
    reasons: string[];
}

export interface TauriUniversalPrinterPlan {
    printTarget: 'label-roll' | 'page-sheet';
    backend: 'zpl-hybrid' | 'tspl-hybrid' | 'zpl-bitmap' | 'epl-raster' | 'cpcl-raster' | 'dpl-raster' | 'sbpl-raster' | 'windows-gdi-label' | 'windows-gdi-page' | 'unsupported';
    transport: 'tcp-raw' | 'serial-raw' | 'windows-spooler' | 'unsupported';
    requestedProtocol: string;
    effectiveProtocol: string;
    profileId: string;
    ready: boolean;
    rasterDpi: 203 | 300 | 600;
    pageWidthMm?: number;
    pageHeightMm?: number;
    fitMode: 'fit-printable' | 'actual-size';
    reasons: string[];
    availableBackends: string[];
    extensionLanguageSlots: string[];
}

export interface TauriPrinterGenerationMetadata {
    protocol: string;
    profileId: string;
    bytes: number;
    widthDots: number;
    heightDots: number;
    elementCount: number;
    generateMicros: number;
}

export interface TauriNativeGenerationReceipt extends TauriPrinterGenerationMetadata {
    dataBase64: string;
}

export interface TauriGeneratedPrintReceipt {
    generation: TauriPrinterGenerationMetadata;
    transport: TauriRawPrintReceipt;
}

export interface TauriDiagnosticExportReceipt {
    success: boolean;
    path: string;
    format: 'zip' | 'json';
    bytes: number;
    sha256: string;
    reportSha256: string;
}

export interface TauriPrinterGeneratorSummary {
    generatedJobs: number;
    fallbackJobs: number;
    failedJobs: number;
    bytesGenerated: number;
    fallbackBytesGenerated: number;
    maxElements: number;
    maxInputBytes: number;
    maxGeneratedBytes: number;
    supportedProtocols: string[];
}

const MIGRATED_INVOKES = new Map<DesktopInvokeChannel, string>([
    ['updater:get-version', 'desktop_get_version'],
    ['updater:check', 'desktop_updater_check'],
    ['updater:download', 'desktop_updater_download'],
    ['updater:install', 'desktop_updater_install'],
    ['updater:install-offline', 'desktop_updater_install_offline'],
    ['updater:list-backups', 'desktop_updater_list_backups'],
    ['updater:refresh-server-version', 'desktop_updater_refresh_server_version'],
    ['updater:rollback', 'desktop_updater_rollback'],
    ['import-identity-file', 'desktop_import_identity_file'],
    ['offline-import', 'desktop_offline_import'],
    ['offline-export', 'desktop_offline_export'],
    ['import-print-job-file', 'desktop_import_print_job_file'],
    ['usb-export', 'desktop_usb_export'],
    ['usb-import', 'desktop_usb_import'],
    ['demo:status', 'desktop_demo_status'],
    ['seed-demo-data', 'desktop_seed_demo_data'],
    ['exit-demo', 'desktop_exit_demo'],
    ['reset-database', 'desktop_reset_database'],
    ['get-scale-config', 'desktop_get_scale_config'],
    ['get-scale-status', 'desktop_get_scale_status'],
    ['get-serial-ports', 'desktop_get_serial_ports'],
    ['get-protocols', 'desktop_get_protocols'],
    ['get-numbering-config', 'desktop_get_numbering_config'],
    ['get-printer-config', 'desktop_get_printer_config'],
    ['get-identity', 'desktop_get_identity'],
    ['get-next-sequence', 'desktop_get_next_sequence'],
    ['sync-data', 'desktop_sync_data'],
    ['get-server-status', 'desktop_get_server_status'],
    ['get-license-status', 'desktop_get_license_status'],
    ['get-station-info', 'desktop_get_station_info'],
    ['get-products', 'desktop_get_products'],
    ['get-fixed-weight-products', 'desktop_get_fixed_weight_products'],
    ['get-containers', 'desktop_get_containers'],
    ['get-label', 'desktop_get_label'],
    ['get-all-labels', 'desktop_get_all_labels'],
    ['get-barcode-template', 'desktop_get_barcode_template'],
    ['get-printers', 'desktop_get_printers'],
    ['get-print-jobs', 'desktop_get_print_jobs'],
    ['update-print-job-progress', 'desktop_update_print_job_progress'],
    ['complete-print-job', 'desktop_complete_print_job'],
    ['delete-print-job', 'desktop_delete_print_job'],
    ['record-pack', 'desktop_record_pack'],
    ['close-box', 'desktop_close_box'],
    ['get-latest-counters', 'desktop_get_latest_counters'],
    ['get-open-pallet-content', 'desktop_get_open_pallet_content'],
    ['get-pallet-render-data', 'desktop_get_pallet_render_data'],
    ['close-pallet', 'desktop_close_pallet'],
    ['delete-pack', 'desktop_delete_pack'],
    ['delete-box', 'desktop_delete_box'],
    ['operators:list', 'desktop_list_operators'],
    ['session:get', 'desktop_session_get'],
    ['session:set', 'desktop_session_set'],
    ['session:logout', 'desktop_session_logout'],
]);

function reportDispatchError(operation: string, error: unknown): void {
    console.error(`[TauriBridge] ${operation}:`, error);
}

function dispatchSend(channel: DesktopSendChannel, data: unknown): void {
    switch (channel) {
        case 'quit-app':
            void invoke('desktop_quit_app').catch(error => reportDispatchError(channel, error));
            return;
        case 'open-logs-folder':
            void invoke('desktop_open_logs_folder').catch(error => reportDispatchError(channel, error));
            return;
        case 'log-to-main':
            void invoke('desktop_log', { payload: data }).catch(error => reportDispatchError(channel, error));
            return;
        case 'connect-scale':
            void invoke('desktop_connect_scale', { payload: data }).catch(error => reportDispatchError(channel, error));
            return;
        case 'disconnect-scale':
            void invoke('desktop_disconnect_scale').catch(error => reportDispatchError(channel, error));
            return;
        case 'save-scale-config':
            void invoke('desktop_save_scale_config', { payload: data }).catch(error => reportDispatchError(channel, error));
            return;
        case 'save-numbering-config':
            void invoke('desktop_save_numbering_config', { payload: data }).catch(error => reportDispatchError(channel, error));
            return;
        case 'save-printer-config':
            void invoke('desktop_save_printer_config', { payload: data }).catch(error => reportDispatchError(channel, error));
            return;
        case 'set-app-mode':
            void invoke('desktop_set_app_mode', { payload: data }).catch(error => reportDispatchError(channel, error));
            return;
        case 'renderer-ready':
            void invoke('desktop_renderer_ready').catch(error => reportDispatchError(channel, error));
            return;
        default:
            console.warn(`[TauriBridge] send channel '${channel}' is waiting for its Rust backend.`);
    }
}

function subscribe(channel: DesktopEventChannel, listener: DesktopEventListener): () => void {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void listen<unknown>(channel, event => listener(event.payload))
        .then(unlisten => {
            if (disposed) unlisten();
            else unsubscribe = unlisten;
        })
        .catch(error => reportDispatchError(`listen ${channel}`, error));

    return () => {
        disposed = true;
        unsubscribe?.();
    };
}

export function createTauriDesktopBridge(): DesktopBridge {
    return {
        runtime: 'tauri',
        send: dispatchSend,
        on: subscribe,
        invoke: async <TResult = unknown>(channel: DesktopInvokeChannel, data?: unknown) => {
            if (channel === 'print-label') {
                const { printTauriLabel } = await import('./tauriPrintOrchestrator');
                return await printTauriLabel(data) as TResult;
            }
            if (channel === 'record-and-print') {
                const { recordAndPrintTauri } = await import('./tauriUiCompatibility');
                return await recordAndPrintTauri(data) as TResult;
            }
            if (channel === 'detect-printer-capabilities') {
                const { detectTauriPrinterCapabilities } = await import('./tauriUiCompatibility');
                return await detectTauriPrinterCapabilities(data) as TResult;
            }
            if (channel === 'test-print') {
                const { testTauriPrinter } = await import('./tauriUiCompatibility');
                return await testTauriPrinter(data) as TResult;
            }
            if (channel === 'printer:warmup') {
                const { warmupConfiguredTauriPrinters } = await import('./tauriUiCompatibility');
                return await warmupConfiguredTauriPrinters(data) as TResult;
            }
            if (channel === 'printer:warmup-bg') {
                return { ok: true, skipped: 'Rust generator renders static content inline' } as TResult;
            }
            const command = MIGRATED_INVOKES.get(channel);
            if (!command) {
                throw new Error(`Desktop command '${channel}' is waiting for its Rust backend.`);
            }
            const args = data === undefined ? undefined : { payload: data };
            return invoke<TResult>(command, args);
        },
    };
}

export function installTauriDesktopBridge(): DesktopBridge {
    const bridge = createTauriDesktopBridge();
    Object.defineProperty(window, 'desktopBridge', {
        configurable: false,
        enumerable: true,
        value: bridge,
        writable: false,
    });
    return bridge;
}

export function getTauriRuntimeSummary(): Promise<TauriRuntimeSummary> {
    return invoke<TauriRuntimeSummary>('desktop_contract_summary');
}

export function getTauriNetworkSummary(): Promise<TauriNetworkSummary> {
    return invoke<TauriNetworkSummary>('desktop_network_summary');
}
export function getTauriIngressSummary(): Promise<TauriIngressSummary> {
    return invoke<TauriIngressSummary>('desktop_ingress_summary');
}
export function getTauriTelemetrySummary(): Promise<TauriTelemetrySummary> {
    return invoke<TauriTelemetrySummary>('desktop_telemetry_summary');
}

export function flushTauriTelemetry(): Promise<TauriTelemetrySummary> {
    return invoke<TauriTelemetrySummary>('desktop_telemetry_flush');
}

export function getTauriScaleSummary(): Promise<TauriScaleSummary> {
    return invoke<TauriScaleSummary>('desktop_scale_summary');
}

export function getTauriPrinterTransportSummary(): Promise<TauriPrinterTransportSummary> {
    return invoke<TauriPrinterTransportSummary>('desktop_printer_transport_summary');
}

export function getTauriDurablePrintJobs(
    state?: TauriDurablePrintState,
    limit = 50,
): Promise<TauriDurablePrintJobRecord[]> {
    return invoke<TauriDurablePrintJobRecord[]>('desktop_printer_durable_jobs', {
        payload: { state, limit },
    });
}

export function getTauriDurableQueueSummary(): Promise<TauriDurableQueueSummary> {
    return invoke<TauriDurableQueueSummary>('desktop_printer_durable_summary');
}

export function retryTauriDurablePrintJob(jobId: string): Promise<TauriRawPrintReceipt> {
    return invoke<TauriRawPrintReceipt>('desktop_printer_retry_durable', {
        payload: { jobId },
    });
}

export function cancelTauriDurablePrintJob(jobId: string): Promise<TauriDurablePrintJobRecord> {
    return invoke<TauriDurablePrintJobRecord>('desktop_printer_cancel_durable', {
        payload: { jobId },
    });
}

export function listenTauriDurablePrintJobs(
    listener: (update: TauriDurableJobUpdate) => void,
): Promise<() => void> {
    return listen<TauriDurableJobUpdate>('printer-durable-job-update', event => listener(event.payload));
}
function bytesToBase64(data: Uint8Array): string {
    const chunkSize = 0x8000;
    const chunks: string[] = [];
    for (let offset = 0; offset < data.length; offset += chunkSize) {
        chunks.push(String.fromCharCode(...data.subarray(offset, offset + chunkSize)));
    }
    return btoa(chunks.join(''));
}

export function sendTauriRawPrint(config: unknown, data: Uint8Array): Promise<TauriRawPrintReceipt> {
    return invoke<TauriRawPrintReceipt>('desktop_printer_send_raw', {
        payload: { config, dataBase64: bytesToBase64(data) },
    });
}

export function warmupTauriRawPrinter(config: unknown): Promise<TauriRawPrintReceipt> {
    return invoke<TauriRawPrintReceipt>('desktop_printer_warmup_raw', { payload: config });
}

export function disconnectTauriRawPrinters(): Promise<void> {
    return invoke<void>('desktop_printer_disconnect_all');
}
export function queryTauriPrinterStatus(config: unknown): Promise<TauriPrinterStatusReport> {
    return invoke<TauriPrinterStatusReport>('desktop_printer_query_status', { payload: config });
}

export function planTauriPrinterBackend(
    request: Pick<TauriPrinterGenerationRequest, 'config' | 'doc'>,
): Promise<TauriUniversalPrinterPlan> {
    return invoke<TauriUniversalPrinterPlan>('desktop_printer_plan_backend', { payload: request });
}

export function planTauriPrinterGeneration(
    request: TauriPrinterGenerationRequest,
): Promise<TauriPrinterGenerationPlan> {
    return invoke<TauriPrinterGenerationPlan>('desktop_printer_plan_generation', { payload: request });
}

export function generateTauriNativeLabel(
    request: TauriPrinterGenerationRequest,
): Promise<TauriNativeGenerationReceipt> {
    return invoke<TauriNativeGenerationReceipt>('desktop_printer_generate_native', { payload: request });
}

export function generateAndSendTauriNativeLabel(
    request: TauriPrinterGenerationRequest,
): Promise<TauriGeneratedPrintReceipt> {
    return invoke<TauriGeneratedPrintReceipt>('desktop_printer_generate_and_send', { payload: request });
}

export function getTauriPrinterGeneratorSummary(): Promise<TauriPrinterGeneratorSummary> {
    return invoke<TauriPrinterGeneratorSummary>('desktop_printer_generator_summary');
}

export function writeTauriRuntimeLog(message: string): Promise<void> {
    return invoke<void>('desktop_log', { payload: { message } });
}

export function openTauriLogsFolder(): Promise<string> {
    return invoke<string>('desktop_open_logs_folder');
}



export function exportTauriPrinterDiagnostic(
    report: Record<string, unknown>,
    path?: string,
    format: 'zip' | 'json' = 'zip',
): Promise<TauriDiagnosticExportReceipt | null> {
    return invoke<TauriDiagnosticExportReceipt | null>('desktop_printer_export_diagnostic', {
        payload: { report, path, format },
    });
}
