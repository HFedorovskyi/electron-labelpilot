import { invoke } from '@tauri-apps/api/core';
import type {
    TauriPrinterGenerationPlan,
    TauriPrinterGenerationRequest,
    TauriUniversalPrinterPlan,
} from './tauriBridge';

interface PublicPrintOptions {
    labelDoc?: unknown;
    data?: unknown;
    printerConfig?: unknown;
    printerName?: unknown;
    jobIdempotencyKey?: unknown;
    printJobId?: unknown;
    jobId?: unknown;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function browserDriverConfig(options: PublicPrintOptions, doc: Record<string, unknown>): Record<string, unknown> {
    const provided = options.printerConfig && typeof options.printerConfig === 'object'
        ? { ...(options.printerConfig as Record<string, unknown>) }
        : {};
    const canvas = doc.canvas && typeof doc.canvas === 'object'
        ? doc.canvas as Record<string, unknown>
        : {};
    const driverName = String(options.printerName ?? provided.driverName ?? '').trim();
    const explicitTarget = String(provided.printTarget ?? '').toLowerCase();
    const pageSheet = explicitTarget === 'page-sheet' || (!explicitTarget && String(canvas.labelType ?? '').toLowerCase() === 'pallet');
    return {
        ...provided,
        id: String(provided.id ?? 'browser-driver'),
        active: provided.active !== false,
        name: String(provided.name ?? (driverName || 'Windows default printer')),
        connection: 'windows_driver',
        protocol: 'browser',
        driverName,
        printTarget: pageSheet ? 'page-sheet' : 'label-roll',
        pageFit: String(provided.pageFit ?? 'fit-printable'),
        dpi: Number(provided.dpi ?? (pageSheet ? 300 : (doc.dpi ?? canvas.dpi ?? 203))),
    };
}

function normalizeRequest(optionsValue: unknown): TauriPrinterGenerationRequest {
    const options = objectValue(optionsValue, 'print options') as PublicPrintOptions;
    const doc = objectValue(options.labelDoc, 'label document');
    const data = options.data === undefined ? {} : objectValue(options.data, 'label data');
    const provided = options.printerConfig && typeof options.printerConfig === 'object'
        ? options.printerConfig as Record<string, unknown>
        : undefined;
    const isBrowser = !provided || String(provided.protocol ?? 'browser').toLowerCase() === 'browser';
    const baseConfig = isBrowser
        ? browserDriverConfig(options, doc)
        : objectValue(provided, 'printer config');
    const idempotencyKey = String(
        options.jobIdempotencyKey
        ?? options.printJobId
        ?? options.jobId
        ?? baseConfig.jobIdempotencyKey
        ?? '',
    ).trim();
    const config = idempotencyKey
        ? { ...baseConfig, jobIdempotencyKey: idempotencyKey }
        : baseConfig;
    return { config, doc, data };
}

export async function printTauriLabel(optionsValue: unknown): Promise<boolean> {
    try {
        const request = normalizeRequest(optionsValue);
        const backendPlan = await invoke<TauriUniversalPrinterPlan>('desktop_printer_plan_backend', {
            payload: { config: request.config, doc: request.doc },
        });
        if (!backendPlan.ready) {
            throw new Error(`printer backend is not ready: ${backendPlan.reasons.join(', ')}`);
        }
        if (backendPlan.printTarget === 'page-sheet') {
            const bitmapModule = await import('./tauriBitmapFallback');
            const pageConfig: Record<string, unknown> = {
                ...(request.config as Record<string, unknown>),
                protocol: 'browser',
                printTarget: 'page-sheet',
                dpi: backendPlan.rasterDpi,
            };
            const pageRequest = { ...request, config: pageConfig };
            const bitmap = await bitmapModule.renderTauriBitmap(pageRequest);
            const configuredMargins = pageConfig.pageMarginsMm;
            const marginsMm = configuredMargins && typeof configuredMargins === 'object' && !Array.isArray(configuredMargins)
                ? configuredMargins as Record<string, unknown>
                : { top: 0, right: 0, bottom: 0, left: 0 };
            await invoke('desktop_printer_send_driver_page', {
                payload: {
                    config: pageConfig,
                    widthDots: bitmap.widthDots,
                    heightDots: bitmap.heightDots,
                    dataBase64: bitmapModule.bytesToBase64(bitmap.mono),
                    pageWidthMm: backendPlan.pageWidthMm,
                    pageHeightMm: backendPlan.pageHeightMm,
                    marginsMm,
                    fitMode: backendPlan.fitMode,
                    documentName: String(pageConfig.documentName ?? 'LabelPilot pallet sheet'),
                },
            });
            console.info(
                `[TauriPrint] page-sheet backend=${backendPlan.backend} raster=${backendPlan.rasterDpi}dpi `
                + `source=${bitmap.widthDots}x${bitmap.heightDots} render=${bitmap.renderMs.toFixed(1)}ms`,
            );
            return true;
        }
        const plan = await invoke<TauriPrinterGenerationPlan>('desktop_printer_plan_generation', {
            payload: request,
        });
        if (plan.nativeEligible) {
            await invoke('desktop_printer_generate_and_send', { payload: request });
            return true;
        }

        const bitmapModule = await import('./tauriBitmapFallback');
        const config = request.config as Record<string, unknown>;
        const protocol = String(config.protocol ?? plan.effectiveProtocol).toLowerCase();
        const useNativeZplBarcodes = protocol === 'zpl' || protocol === 'image';
        const nativeZplBarcodes = useNativeZplBarcodes
            ? bitmapModule.collectNativeZplBarcodeCommands(request)
            : [];
        const encodeStarted = performance.now();
        const bitmap = await bitmapModule.renderTauriBitmap(request, {
            omitNativeZplBarcodes: nativeZplBarcodes.length > 0,
        });

        if (protocol === 'browser') {
            await invoke('desktop_printer_send_driver_bitmap', {
                payload: {
                    config,
                    widthDots: bitmap.widthDots,
                    heightDots: bitmap.heightDots,
                    dataBase64: bitmapModule.bytesToBase64(bitmap.mono),
                },
            });
            return true;
        }

        if (!['zpl', 'image', 'tspl', 'epl', 'cpcl', 'dpl', 'sbpl'].includes(protocol)) {
            throw new Error(`unsupported raster adapter protocol: ${protocol}`);
        }
        const bytes = bitmapModule.encodePortableRaster(
            protocol as 'zpl' | 'image' | 'tspl' | 'epl' | 'cpcl' | 'dpl' | 'sbpl',
            bitmap,
            config,
            nativeZplBarcodes,
        );
        console.info(
            `[TauriPrint] fallback protocol=${protocol} render=${bitmap.renderMs.toFixed(1)}ms `
            + `total=${(performance.now() - encodeStarted).toFixed(1)}ms bytes=${bytes.length} `
            + `nativeBarcodes=${nativeZplBarcodes.length}`,
        );
        await invoke('desktop_printer_send_fallback_raw', {
            payload: { config, dataBase64: bitmapModule.bytesToBase64(bytes) },
        });
        return true;
    } catch (error) {
        console.error('[TauriPrint] print-label failed:', error);
        return false;
    }
}
