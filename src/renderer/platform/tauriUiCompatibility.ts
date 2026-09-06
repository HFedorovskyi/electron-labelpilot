import { invoke } from '@tauri-apps/api/core';
import { printTauriLabel } from './tauriPrintOrchestrator';
import { queryTauriPrinterStatus, warmupTauriRawPrinter } from './tauriBridge';

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown, label: string): JsonObject {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(label + ' must be an object');
    }
    return value as JsonObject;
}

type DetectablePrinterProtocol = 'zpl' | 'tspl' | 'epl' | 'cpcl' | 'dpl' | 'sbpl';

function protocolFor(config: JsonObject): DetectablePrinterProtocol | undefined {
    const protocol = String(config.protocol ?? '').toLowerCase();
    if (protocol === 'image') return 'zpl';
    if (['zpl', 'tspl', 'epl', 'cpcl', 'dpl', 'sbpl'].includes(protocol)) {
        return protocol as DetectablePrinterProtocol;
    }
    return undefined;
}

function compatibleProfileFor(protocol: DetectablePrinterProtocol): string {
    const profiles: Record<DetectablePrinterProtocol, string> = {
        zpl: 'generic-zpl-safe',
        tspl: 'generic-tspl-safe',
        epl: 'generic-epl-raster',
        cpcl: 'generic-cpcl-raster',
        dpl: 'generic-dpl-raster',
        sbpl: 'generic-sbpl-raster',
    };
    return profiles[protocol];
}

function printerEndpointKey(config: JsonObject): string {
    const connection = String(config.connection ?? '');
    if (connection === 'tcp') {
        return 'tcp:' + String(config.ip ?? '').toLowerCase() + ':' + Number(config.port ?? 9100);
    }
    if (connection === 'serial') {
        return 'serial:' + String(config.serialPort ?? '').toUpperCase() + ':' + Number(config.baudRate ?? 9600);
    }
    return 'spooler:' + String(config.driverName ?? '<default>').toLowerCase();
}

function normalizedDpi(config: JsonObject): 203 | 300 | 600 {
    const dpi = Number(config.dpi ?? 203);
    if (dpi >= 450) return 600;
    if (dpi >= 250) return 300;
    return 203;
}

export async function detectTauriPrinterCapabilities(value: unknown): Promise<JsonObject> {
    const config = objectValue(value, 'printer config');
    const detectedAt = Date.now();
    const protocol = protocolFor(config);
    const endpointKey = printerEndpointKey(config);
    const connection = String(config.connection ?? '');
    try {
        const statusReport = await queryTauriPrinterStatus(config);
        return {
            detected: protocol !== undefined,
            cached: false,
            source: protocol ? 'probe' : 'unavailable',
            confidence: protocol
                ? (statusReport.supportsBidirectionalStatus ? 'high' : 'medium')
                : 'none',
            ...(protocol ? { protocol } : {}),
            dpi: normalizedDpi(config),
            dotsPerMm: normalizedDpi(config) / 25.4,
            status: statusReport.status === 'reachable' ? 'ready' : statusReport.status,
            statusDetails: statusReport.details,
            supportsBidirectionalStatus: statusReport.supportsBidirectionalStatus,
            ...(protocol ? {
                recommendedProfileId: compatibleProfileFor(protocol),
                endpointKey,
            } : {}),
            evidence: [
                'transport:' + connection,
                'configured-protocol:' + String(config.protocol ?? ''),
                'status-response-bytes:' + statusReport.responseBytes,
            ],
            detectedAt,
            expiresAt: detectedAt + 15 * 60_000,
        };
    } catch (error) {
        return {
            detected: false,
            cached: false,
            source: 'unavailable',
            confidence: 'none',
            ...(protocol ? { protocol } : {}),
            dpi: normalizedDpi(config),
            dotsPerMm: normalizedDpi(config) / 25.4,
            status: 'error',
            statusDetails: [error instanceof Error ? error.message : String(error)],
            supportsBidirectionalStatus: false,
            endpointKey,
            evidence: ['transport:' + connection, 'probe-failed'],
            detectedAt,
            expiresAt: detectedAt + 30_000,
        };
    }
}

export async function testTauriPrinter(value: unknown): Promise<{ success: boolean; message?: string }> {
    const config = objectValue(value, 'printer config');
    const testDocument = {
        id: 'tauri-test',
        name: 'LabelPilot test',
        widthMm: Number(config.widthMm ?? 58),
        heightMm: Number(config.heightMm ?? 40),
        canvas: {
            width: 400,
            height: 300,
            background: '#ffffff',
        },
        elements: [
            {
                id: 'test-title',
                type: 'text',
                text: 'LABELPILOT TEST',
                x: 30,
                y: 45,
                w: 340,
                h: 48,
                fontSize: 30,
                fontWeight: 'bold',
            },
            {
                id: 'test-printer',
                type: 'text',
                text: String(config.name ?? 'Printer'),
                x: 30,
                y: 115,
                w: 340,
                h: 34,
                fontSize: 18,
            },
            {
                id: 'test-protocol',
                type: 'text',
                text: 'Protocol: ' + String(config.protocol ?? ''),
                x: 30,
                y: 165,
                w: 340,
                h: 34,
                fontSize: 18,
            },
        ],
    };
    const success = await printTauriLabel({
        labelDoc: testDocument,
        data: { batch_number: 'TEST' },
        printerConfig: config,
    });
    return success ? { success: true } : {
        success: false,
        message: 'Native printer pipeline reported a send failure',
    };
}

export async function warmupConfiguredTauriPrinters(value: unknown): Promise<JsonObject> {
    const request = value && typeof value === 'object' ? value as JsonObject : {};
    const requested = Array.isArray(request.printerIds)
        ? request.printerIds.map(String)
        : ['pack', 'box', 'pallet'];
    const saved = await invoke<JsonObject>('desktop_get_printer_config');
    const results: Record<string, string> = {};

    for (const role of requested) {
        const configKey = role === 'pack'
            ? 'packPrinter'
            : role === 'box'
                ? 'boxPrinter'
                : role === 'pallet'
                    ? 'palletPrinter'
                    : role;
        const raw = saved[configKey];
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            results[role] = 'unconfigured';
            continue;
        }
        const config = raw as JsonObject;
        if (config.active === false) {
            results[role] = 'unconfigured';
            continue;
        }
        try {
            await warmupTauriRawPrinter(config);
            results[role] = String(config.connection ?? '') === 'windows_driver' ? 'driver' : 'ready';
        } catch {
            results[role] = 'unreachable';
        }
    }
    return { ok: true, results };
}

export async function recordAndPrintTauri(value: unknown): Promise<JsonObject> {
    const options = objectValue(value, 'record-and-print options');
    const record = objectValue(options.record, 'record');
    const result = await invoke<JsonObject>('desktop_record_pack', { payload: record });
    if (result.success !== true) {
        return { ...result, printDispatched: false };
    }

    const hasPrintPayload = options.labelDoc
        && typeof options.labelDoc === 'object'
        && options.printerConfig
        && typeof options.printerConfig === 'object';
    if (!hasPrintPayload) {
        return { ...result, printDispatched: false };
    }

    const sourceData = options.data && typeof options.data === 'object'
        ? options.data as JsonObject
        : {};
    const printData = {
        ...sourceData,
        box_number: result.boxNumber,
        ...(result.barcodeValue ? { barcode: result.barcodeValue } : {}),
    };
    const recordIdempotencyKey = String(
        options.jobIdempotencyKey
        ?? result.packId
        ?? result.id
        ?? record.id
        ?? result.barcodeValue
        ?? '',
    ).trim();
    const printDispatched = await printTauriLabel({
        labelDoc: options.labelDoc,
        data: printData,
        printerConfig: options.printerConfig,
        ...(recordIdempotencyKey
            ? { jobIdempotencyKey: `record-pack:${recordIdempotencyKey}` }
            : {}),
    });
    return { ...result, printDispatched };
}