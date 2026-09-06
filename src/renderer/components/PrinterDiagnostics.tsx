import { createPortal } from 'react-dom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Activity, AlertTriangle, CheckCircle2, Download, FileJson, Gauge,
    Loader2, Printer, QrCode, Ruler, Stethoscope, Wifi, type LucideIcon,
} from 'lucide-react';
import clsx from 'clsx';
import packageJson from '../../../package.json';
import { useTranslation } from '../i18n';
import { exportTauriPrinterDiagnostic } from '../platform/tauriBridge';
import {
    buildDiagnosticReport, defaultCalibrationSize, printCalibration, probePrinter,
    type PrinterConfig, type PrinterDiagnosticResult, type PrinterRole,
} from '../platform/printerDiagnostics';

const ROLES: PrinterRole[] = ['packPrinter', 'boxPrinter', 'palletPrinter'];

type Dimensions = Record<PrinterRole, { widthMm: number; heightMm: number }>;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function endpoint(config?: PrinterConfig): string {
    if (!config) return '—';
    const connection = String(config.connection ?? '—');
    if (connection === 'tcp' || connection === 'ethernet') return `${String(config.ip ?? '—')}:${Number(config.port ?? 9100)}`;
    if (connection === 'serial') return `${String(config.serialPort ?? '—')} · ${Number(config.baudRate ?? 9600)}`;
    return String(config.driverName ?? connection);
}

function statusTone(result?: PrinterDiagnosticResult): string {
    if (!result) return 'border-neutral-200 dark:border-neutral-700';
    if (!result.status?.reachable || !result.backendPlan?.ready) return 'border-red-300 dark:border-red-500/50';
    if (!result.success) return 'border-amber-300 dark:border-amber-500/50';
    return 'border-emerald-300 dark:border-emerald-500/50';
}

const PrinterDiagnostics = () => {
    const { t } = useTranslation();
    const isTauri = window.desktopBridge?.runtime === 'tauri';
    const mounted = useRef(true);
    const [configs, setConfigs] = useState<Partial<Record<PrinterRole, PrinterConfig>>>({});
    const [dimensions, setDimensions] = useState<Dimensions>({
        packPrinter: { widthMm: 58, heightMm: 40 },
        boxPrinter: { widthMm: 58, heightMm: 40 },
        palletPrinter: { widthMm: 210, heightMm: 297 },
    });
    const [results, setResults] = useState<Partial<Record<PrinterRole, PrinterDiagnosticResult>>>({});
    const [loading, setLoading] = useState(true);
    const [probing, setProbing] = useState<PrinterRole | 'all' | null>(null);
    const [printing, setPrinting] = useState<PrinterRole | null>(null);
    const [confirmCalibration, setConfirmCalibration] = useState<PrinterRole | null>(null);
    const [exporting, setExporting] = useState<'zip' | 'json' | null>(null);
    const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

    const roleLabels = useMemo<Record<PrinterRole, string>>(() => ({
        packPrinter: t('settings.packPrinter'),
        boxPrinter: t('settings.boxPrinter'),
        palletPrinter: t('settings.palletPrinter'),
    }), [t]);

    const loadConfigs = useCallback(async () => {
        setLoading(true);
        try {
            const value = await window.desktopBridge.invoke('get-printer-config') as Record<string, unknown> | null;
            const next: Partial<Record<PrinterRole, PrinterConfig>> = {};
            const sizes = { ...dimensions };
            for (const role of ROLES) {
                const config = value?.[role];
                if (config && typeof config === 'object' && !Array.isArray(config)) {
                    next[role] = config as PrinterConfig;
                    sizes[role] = defaultCalibrationSize(role, config as PrinterConfig);
                }
            }
            if (mounted.current) {
                setConfigs(next);
                setDimensions(sizes);
            }
        } catch (error) {
            if (mounted.current) setNotice({ tone: 'error', text: errorMessage(error) });
        } finally {
            if (mounted.current) setLoading(false);
        }
    }, []);

    useEffect(() => {
        mounted.current = true;
        void loadConfigs();
        return () => { mounted.current = false; };
    }, [loadConfigs]);

    const runOne = useCallback(async (role: PrinterRole) => {
        const config = configs[role];
        if (!isTauri || !config || config.active === false) return;
        setNotice(null);
        setProbing(role);
        try {
            const result = await probePrinter(role, config);
            if (mounted.current) setResults(current => ({ ...current, [role]: result }));
        } catch (error) {
            if (mounted.current) setNotice({ tone: 'error', text: errorMessage(error) });
        } finally {
            if (mounted.current) setProbing(null);
        }
    }, [configs, isTauri]);

    const runAll = useCallback(async () => {
        if (!isTauri || probing) return;
        setNotice(null);
        setProbing('all');
        try {
            const active = ROLES.filter(role => configs[role] && configs[role]?.active !== false);
            const reports = await Promise.all(active.map(async role => [role, await probePrinter(role, configs[role]!)] as const));
            if (mounted.current) setResults(current => ({ ...current, ...Object.fromEntries(reports) }));
        } catch (error) {
            if (mounted.current) setNotice({ tone: 'error', text: errorMessage(error) });
        } finally {
            if (mounted.current) setProbing(null);
        }
    }, [configs, isTauri, probing]);

    const performCalibration = useCallback(async () => {
        const role = confirmCalibration;
        if (!role) return;
        const config = configs[role];
        setConfirmCalibration(null);
        if (!config || config.active === false) return;
        setPrinting(role);
        setNotice(null);
        try {
            const size = dimensions[role];
            const calibration = await printCalibration(role, config, size.widthMm, size.heightMm);
            if (!mounted.current) return;
            setResults(current => ({
                ...current,
                [role]: current[role]
                    ? { ...current[role]!, calibration }
                    : { role, startedAt: calibration.attemptedAt, durationMs: calibration.durationMs, success: calibration.success, errors: [], calibration },
            }));
            setNotice({ tone: calibration.success ? 'success' : 'error', text: calibration.success ? t('diagnostics.printed') : t('diagnostics.printFailed') });
        } catch (error) {
            if (mounted.current) setNotice({ tone: 'error', text: errorMessage(error) });
        } finally {
            if (mounted.current) setPrinting(null);
        }
    }, [configs, confirmCalibration, dimensions, t]);

    const exportReport = useCallback(async (format: 'zip' | 'json') => {
        if (!isTauri) return;
        setExporting(format);
        setNotice(null);
        try {
            const report = await buildDiagnosticReport(packageJson.version, configs, results);
            const receipt = await exportTauriPrinterDiagnostic(report, undefined, format);
            if (receipt && mounted.current) {
                setNotice({ tone: 'success', text: `${t('diagnostics.reportExported')}: ${receipt.path}` });
            }
        } catch (error) {
            if (mounted.current) setNotice({ tone: 'error', text: errorMessage(error) });
        } finally {
            if (mounted.current) setExporting(null);
        }
    }, [configs, isTauri, results, t]);

    const activeCount = ROLES.filter(role => configs[role] && configs[role]?.active !== false).length;
    const checkedCount = Object.keys(results).length;
    const metrics: Array<{ label: string; value: number; Icon: LucideIcon }> = [
        { label: t('diagnostics.configured'), value: activeCount, Icon: Printer },
        { label: t('diagnostics.checked'), value: checkedCount, Icon: Stethoscope },
        { label: t('diagnostics.available'), value: Object.values(results).filter(value => value?.status?.reachable).length, Icon: Wifi },
        { label: t('diagnostics.ready'), value: Object.values(results).filter(value => value?.backendPlan?.ready).length, Icon: Gauge },
    ];

    return (
        <section className="mx-auto flex min-h-full w-full max-w-[1600px] flex-col gap-4 pb-3" data-testid="printer-diagnostics">
            <header className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <h2 className="flex items-center gap-3 text-2xl font-black tracking-tight">
                        <Stethoscope className="h-7 w-7 text-emerald-600" /> {t('diagnostics.title')}
                    </h2>
                    <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{t('diagnostics.subtitle')}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => void exportReport('json')} disabled={!isTauri || exporting !== null}
                        className="flex min-h-12 items-center gap-2 rounded-xl border border-neutral-200 bg-white px-4 font-bold shadow-sm disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900">
                        {exporting === 'json' ? <Loader2 className="h-5 w-5 animate-spin" /> : <FileJson className="h-5 w-5" />} JSON
                    </button>
                    <button type="button" onClick={() => void exportReport('zip')} disabled={!isTauri || exporting !== null}
                        className="flex min-h-12 items-center gap-2 rounded-xl border border-neutral-200 bg-white px-4 font-bold shadow-sm disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900">
                        {exporting === 'zip' ? <Loader2 className="h-5 w-5 animate-spin" /> : <Download className="h-5 w-5" />} ZIP
                    </button>
                    <button type="button" onClick={() => void runAll()} disabled={!isTauri || loading || !!probing || activeCount === 0}
                        className="flex min-h-12 items-center gap-2 rounded-xl bg-neutral-900 px-5 font-bold text-white disabled:opacity-50 dark:bg-emerald-600">
                        {probing === 'all' ? <Loader2 className="h-5 w-5 animate-spin" /> : <Activity className="h-5 w-5" />} {t('diagnostics.runAll')}
                    </button>
                </div>
            </header>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {metrics.map(({ label, value, Icon }) => (
                    <div key={label} className="flex items-center justify-between rounded-2xl border border-neutral-200 bg-white px-4 py-3 shadow-sm dark:border-neutral-700 dark:bg-neutral-900">
                        <div><div className="text-xs font-bold uppercase tracking-wide text-neutral-500">{label}</div><div className="text-2xl font-black tabular-nums">{value}</div></div>
                        <Icon className="h-6 w-6 text-emerald-600" />
                    </div>
                ))}
            </div>

            {!isTauri && <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900">{t('diagnostics.tauriOnly')}</div>}
            {notice && <div role="status" className={clsx('break-all rounded-xl border p-3 text-sm font-medium', notice.tone === 'success' ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200' : 'border-red-300 bg-red-50 text-red-900 dark:bg-red-500/10 dark:text-red-200')}>{notice.text}</div>}

            <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-3">
                {ROLES.map(role => {
                    const config = configs[role];
                    const result = results[role];
                    const active = !!config && config.active !== false;
                    const busy = probing === role || probing === 'all';
                    return (
                        <article key={role} data-printer-role={role} className={clsx('flex min-h-[360px] flex-col rounded-2xl border-2 bg-white p-4 shadow-sm dark:bg-neutral-900', statusTone(result))}>
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <h3 className="truncate text-lg font-black" title={roleLabels[role]}>{roleLabels[role]}</h3>
                                    <p className="truncate text-sm text-neutral-500" title={String(config?.name ?? '')}>{String(config?.name ?? t('diagnostics.notConfigured'))}</p>
                                </div>
                                {result ? (result.success ? <CheckCircle2 className="h-7 w-7 shrink-0 text-emerald-500" /> : <AlertTriangle className="h-7 w-7 shrink-0 text-amber-500" />) : <Printer className="h-7 w-7 shrink-0 text-neutral-400" />}
                            </div>

                            <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
                                <dt className="text-neutral-500">{t('diagnostics.connection')}</dt><dd className="truncate font-bold" title={endpoint(config)}>{endpoint(config)}</dd>
                                <dt className="text-neutral-500">{t('diagnostics.protocol')}</dt><dd className="font-bold">{String(config?.protocol ?? '—').toUpperCase()}</dd>
                                <dt className="text-neutral-500">DPI</dt><dd className="font-bold">{String(config?.dpi ?? 203)}</dd>
                                <dt className="text-neutral-500">{t('diagnostics.status')}</dt><dd className="font-bold">{result?.status?.status ?? t('diagnostics.notRun')}</dd>
                                <dt className="text-neutral-500">{t('diagnostics.backend')}</dt><dd className="truncate font-bold" title={result?.backendPlan?.backend}>{result?.backendPlan?.backend ?? '—'}</dd>
                                <dt className="text-neutral-500">{t('diagnostics.latency')}</dt><dd className="font-bold tabular-nums">{result ? `${result.statusQueryMs ?? 0} / ${result.planningMs ?? 0} ms` : '—'}</dd>
                            </dl>

                            {result?.errors.length ? <div className="mt-3 line-clamp-2 rounded-lg bg-red-50 p-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">{result.errors.join(' · ')}</div> : null}

                            <div className="mt-auto pt-4">
                                <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-neutral-500"><Ruler className="h-4 w-4" /> {t('diagnostics.exactSize')}</div>
                                <div className="grid grid-cols-2 gap-2">
                                    {(['widthMm', 'heightMm'] as const).map(field => (
                                        <label key={field} className="text-xs font-bold text-neutral-500">
                                            {field === 'widthMm' ? t('diagnostics.width') : t('diagnostics.height')}, mm
                                            <input type="number" min="20" max="500" step="0.1" value={dimensions[role][field]}
                                                onChange={event => setDimensions(current => ({ ...current, [role]: { ...current[role], [field]: Math.min(500, Math.max(20, Number(event.target.value) || 20)) } }))}
                                                className="mt-1 min-h-12 w-full rounded-xl border border-neutral-300 bg-white px-3 text-base font-black text-neutral-900 dark:border-neutral-600 dark:bg-neutral-800 dark:text-white" />
                                        </label>
                                    ))}
                                </div>
                                <div className="mt-3 grid grid-cols-2 gap-2">
                                    <button type="button" onClick={() => void runOne(role)} disabled={!active || !!probing || !!printing}
                                        className="flex min-h-12 items-center justify-center gap-2 rounded-xl border border-neutral-300 px-3 font-bold disabled:opacity-40 dark:border-neutral-600">
                                        {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Stethoscope className="h-5 w-5" />} {t('diagnostics.check')}
                                    </button>
                                    <button type="button" onClick={() => setConfirmCalibration(role)} disabled={!active || !!printing || !!probing}
                                        className="flex min-h-12 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-3 font-bold text-white disabled:opacity-40">
                                        {printing === role ? <Loader2 className="h-5 w-5 animate-spin" /> : <QrCode className="h-5 w-5" />} {t('diagnostics.calibrate')}
                                    </button>
                                </div>
                            </div>
                        </article>
                    );
                })}
            </div>

            <p className="flex items-center gap-2 text-xs text-neutral-500"><Activity className="h-4 w-4" /> {t('diagnostics.onDemandHint')}</p>

            {confirmCalibration && createPortal(
                <div className="fixed inset-0 z-[400] flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm" onClick={() => setConfirmCalibration(null)}>
                    <div className="w-full max-w-xl rounded-3xl border-2 border-emerald-400 bg-white p-7 shadow-2xl dark:bg-neutral-900" onClick={event => event.stopPropagation()}>
                        <div className="flex items-center gap-4"><div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-100 dark:bg-emerald-500/15"><QrCode className="h-8 w-8 text-emerald-600" /></div><h3 className="text-2xl font-black">{t('diagnostics.confirmTitle')}</h3></div>
                        <p className="mt-5 text-lg text-neutral-600 dark:text-neutral-300">{t('diagnostics.confirmText')}</p>
                        <div className="mt-4 rounded-2xl bg-neutral-100 p-4 text-center text-2xl font-black dark:bg-neutral-800">{dimensions[confirmCalibration].widthMm} × {dimensions[confirmCalibration].heightMm} mm</div>
                        <div className="mt-6 grid grid-cols-2 gap-3">
                            <button type="button" onClick={() => setConfirmCalibration(null)} className="min-h-14 rounded-xl border border-neutral-300 text-lg font-bold dark:border-neutral-600">{t('diagnostics.cancel')}</button>
                            <button type="button" onClick={() => void performCalibration()} className="min-h-14 rounded-xl bg-emerald-600 text-lg font-bold text-white">{t('diagnostics.printOne')}</button>
                        </div>
                    </div>
                </div>, document.body,
            )}
        </section>
    );
};

export default PrinterDiagnostics;
