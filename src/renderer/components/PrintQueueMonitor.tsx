import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Activity,
    AlertTriangle,
    CheckCircle2,
    Clock3,
    Loader2,
    Printer,
    RefreshCw,
    RotateCcw,
    Wifi,
    XCircle,
    type LucideIcon,
} from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from '../i18n';
import {
    cancelTauriDurablePrintJob,
    getTauriDurablePrintJobs,
    getTauriDurableQueueSummary,
    listenTauriDurablePrintJobs,
    queryTauriPrinterStatus,
    retryTauriDurablePrintJob,
    type TauriDurablePrintJobRecord,
    type TauriDurablePrintState,
    type TauriDurableQueueSummary,
    type TauriPrinterStatusReport,
} from '../platform/tauriBridge';

type QueueFilter = 'attention' | 'active' | 'accepted' | 'all';
type PrinterRole = 'packPrinter' | 'boxPrinter' | 'palletPrinter';
type PrinterConfig = Record<string, unknown>;

const EMPTY_SUMMARY: TauriDurableQueueSummary = {
    queued: 0,
    rendering: 0,
    sending: 0,
    accepted: 0,
    uncertain: 0,
    failed: 0,
    cancelled: 0,
    total: 0,
    startupMarkedUncertain: 0,
    maxRecoveryJobs: 0,
    maxListJobs: 200,
    retentionMs: 0,
};

const ACTIVE_STATES = new Set<TauriDurablePrintState>(['queued', 'rendering', 'sending']);
const ATTENTION_STATES = new Set<TauriDurablePrintState>(['uncertain', 'failed']);
const CANCELLABLE_STATES = new Set<TauriDurablePrintState>(['queued', 'failed', 'uncertain']);
const RETRYABLE_STATES = new Set<TauriDurablePrintState>(['failed', 'uncertain']);

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function stateTone(state: TauriDurablePrintState): string {
    if (state === 'accepted') return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300';
    if (state === 'failed') return 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300';
    if (state === 'uncertain') return 'bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300';
    if (state === 'cancelled') return 'bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-300';
    return 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300';
}

function printerStatusTone(report?: TauriPrinterStatusReport): string {
    if (!report) return 'border-neutral-200 dark:border-neutral-700';
    if (!report.reachable || ['offline', 'error', 'paper-out', 'paper-jam', 'head-open'].includes(report.status)) {
        return 'border-red-300 bg-red-50/60 dark:border-red-500/40 dark:bg-red-500/5';
    }
    if (['paused', 'printing', 'reachable'].includes(report.status)) {
        return 'border-amber-300 bg-amber-50/60 dark:border-amber-500/40 dark:bg-amber-500/5';
    }
    return 'border-emerald-300 bg-emerald-50/60 dark:border-emerald-500/40 dark:bg-emerald-500/5';
}

function formatTime(timestamp?: number): string {
    if (!timestamp) return '—';
    return new Date(timestamp).toLocaleString([], {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

function shortId(value: string): string {
    return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

const PrintQueueMonitor = () => {
    const { t } = useTranslation();
    const isTauri = window.desktopBridge?.runtime === 'tauri';
    const [summary, setSummary] = useState<TauriDurableQueueSummary>(EMPTY_SUMMARY);
    const [jobs, setJobs] = useState<TauriDurablePrintJobRecord[]>([]);
    const [filter, setFilter] = useState<QueueFilter>('attention');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [busyJobId, setBusyJobId] = useState<string | null>(null);
    const [confirmRetry, setConfirmRetry] = useState<TauriDurablePrintJobRecord | null>(null);
    const [printerConfigs, setPrinterConfigs] = useState<Partial<Record<PrinterRole, PrinterConfig>>>({});
    const [printerReports, setPrinterReports] = useState<Partial<Record<PrinterRole, TauriPrinterStatusReport>>>({});
    const [printerErrors, setPrinterErrors] = useState<Partial<Record<PrinterRole, string>>>({});
    const [checkingPrinters, setCheckingPrinters] = useState(false);
    const mountedRef = useRef(true);
    const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const loadQueue = useCallback(async (showSpinner = false) => {
        if (!isTauri) {
            setLoading(false);
            return;
        }
        if (showSpinner) setLoading(true);
        try {
            const [nextSummary, nextJobs] = await Promise.all([
                getTauriDurableQueueSummary(),
                getTauriDurablePrintJobs(undefined, 200),
            ]);
            if (!mountedRef.current) return;
            setSummary(nextSummary);
            setJobs(nextJobs);
            setError(null);
        } catch (loadError) {
            if (mountedRef.current) setError(messageOf(loadError));
        } finally {
            if (mountedRef.current) setLoading(false);
        }
    }, [isTauri]);

    const scheduleRefresh = useCallback(() => {
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = setTimeout(() => void loadQueue(false), 120);
    }, [loadQueue]);

    useEffect(() => {
        mountedRef.current = true;
        void loadQueue(true);
        let unlisten: (() => void) | undefined;
        if (isTauri) {
            void listenTauriDurablePrintJobs(scheduleRefresh).then(remove => {
                if (!mountedRef.current) remove();
                else unlisten = remove;
            }).catch(listenerError => {
                if (mountedRef.current) setError(messageOf(listenerError));
            });
        }
        const interval = setInterval(() => {
            if (document.visibilityState === 'visible') void loadQueue(false);
        }, 5_000);
        return () => {
            mountedRef.current = false;
            unlisten?.();
            clearInterval(interval);
            if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        };
    }, [isTauri, loadQueue, scheduleRefresh]);

    const visibleJobs = useMemo(() => jobs.filter(job => {
        if (filter === 'attention') return ATTENTION_STATES.has(job.state);
        if (filter === 'active') return ACTIVE_STATES.has(job.state);
        if (filter === 'accepted') return job.state === 'accepted';
        return true;
    }), [filter, jobs]);

    const runRetry = useCallback(async (job: TauriDurablePrintJobRecord) => {
        setBusyJobId(job.jobId);
        setError(null);
        try {
            await retryTauriDurablePrintJob(job.jobId);
            setConfirmRetry(null);
            await loadQueue(false);
        } catch (actionError) {
            setError(messageOf(actionError));
        } finally {
            setBusyJobId(null);
        }
    }, [loadQueue]);

    const requestRetry = (job: TauriDurablePrintJobRecord) => {
        if (job.state === 'uncertain') setConfirmRetry(job);
        else void runRetry(job);
    };

    const cancelJob = useCallback(async (job: TauriDurablePrintJobRecord) => {
        setBusyJobId(job.jobId);
        setError(null);
        try {
            await cancelTauriDurablePrintJob(job.jobId);
            await loadQueue(false);
        } catch (actionError) {
            setError(messageOf(actionError));
        } finally {
            setBusyJobId(null);
        }
    }, [loadQueue]);

    const checkPrinters = useCallback(async () => {
        if (!isTauri || checkingPrinters) return;
        setCheckingPrinters(true);
        setPrinterErrors({});
        try {
            const saved = await window.desktopBridge.invoke('get-printer-config') as Record<string, unknown> | null;
            const roles: PrinterRole[] = ['packPrinter', 'boxPrinter', 'palletPrinter'];
            const configs: Partial<Record<PrinterRole, PrinterConfig>> = {};
            for (const role of roles) {
                const value = saved?.[role];
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                    configs[role] = value as PrinterConfig;
                }
            }
            setPrinterConfigs(configs);
            const reports: Partial<Record<PrinterRole, TauriPrinterStatusReport>> = {};
            const errors: Partial<Record<PrinterRole, string>> = {};
            await Promise.all(roles.map(async role => {
                const config = configs[role];
                if (!config || config.active === false) return;
                try {
                    reports[role] = await queryTauriPrinterStatus(config);
                } catch (statusError) {
                    errors[role] = messageOf(statusError);
                }
            }));
            if (mountedRef.current) {
                setPrinterReports(reports);
                setPrinterErrors(errors);
            }
        } catch (configError) {
            setError(messageOf(configError));
        } finally {
            if (mountedRef.current) setCheckingPrinters(false);
        }
    }, [checkingPrinters, isTauri]);

    const filters: Array<{ id: QueueFilter; label: string; count: number }> = [
        { id: 'attention', label: t('queue.filterAttention'), count: summary.failed + summary.uncertain },
        { id: 'active', label: t('queue.filterActive'), count: summary.queued + summary.rendering + summary.sending },
        { id: 'accepted', label: t('queue.filterAccepted'), count: summary.accepted },
        { id: 'all', label: t('queue.filterAll'), count: summary.total },
    ];

    const roleLabels: Record<PrinterRole, string> = {
        packPrinter: t('settings.packPrinter'),
        boxPrinter: t('settings.boxPrinter'),
        palletPrinter: t('settings.palletPrinter'),
    };
    const summaryCards: Array<{ label: string; count: number; icon: LucideIcon; tone: string }> = [
        { label: t('queue.total'), count: summary.total, icon: Activity, tone: 'text-neutral-700 dark:text-neutral-200' },
        { label: t('queue.active'), count: summary.queued + summary.rendering + summary.sending, icon: Clock3, tone: 'text-sky-600' },
        { label: t('queue.accepted'), count: summary.accepted, icon: CheckCircle2, tone: 'text-emerald-600' },
        { label: t('queue.uncertain'), count: summary.uncertain, icon: AlertTriangle, tone: 'text-amber-600' },
        { label: t('queue.failed'), count: summary.failed, icon: XCircle, tone: 'text-red-600' },
        { label: t('queue.cancelled'), count: summary.cancelled, icon: XCircle, tone: 'text-neutral-500' },
    ];

    return (
        <section className="mx-auto flex min-h-full w-full max-w-[1600px] flex-col gap-4 pb-3" data-testid="print-queue-monitor">
            <header className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h2 className="flex items-center gap-3 text-2xl font-black tracking-tight">
                        <Printer className="h-7 w-7 text-emerald-600" />
                        {t('queue.title')}
                    </h2>
                    <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{t('queue.subtitle')}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <button
                        type="button"
                        onClick={() => void checkPrinters()}
                        disabled={!isTauri || checkingPrinters}
                        className="flex min-h-12 items-center gap-2 rounded-xl border border-neutral-200 bg-white px-4 font-bold shadow-sm hover:border-emerald-400 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900"
                    >
                        {checkingPrinters ? <Loader2 className="h-5 w-5 animate-spin" /> : <Wifi className="h-5 w-5" />}
                        {t('queue.checkPrinters')}
                    </button>
                    <button
                        type="button"
                        onClick={() => void loadQueue(true)}
                        disabled={!isTauri || loading}
                        className="flex min-h-12 items-center gap-2 rounded-xl bg-neutral-900 px-5 font-bold text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-emerald-600 dark:hover:bg-emerald-500"
                    >
                        <RefreshCw className={clsx('h-5 w-5', loading && 'animate-spin')} />
                        {t('queue.refresh')}
                    </button>
                </div>
            </header>

            {!isTauri && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 font-medium text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
                    {t('queue.tauriOnly')}
                </div>
            )}
            {error && (
                <div role="alert" className="flex items-start gap-3 rounded-xl border border-red-300 bg-red-50 p-4 text-red-900 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                    <span className="break-all">{error}</span>
                </div>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                {summaryCards.map(({ label, count, icon: Icon, tone }) => (
                    <div key={label} className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-700 dark:bg-neutral-900">
                        <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold uppercase tracking-wide text-neutral-500">{label}</span>
                            <Icon className={clsx('h-5 w-5', tone)} />
                        </div>
                        <div className="mt-2 text-3xl font-black tabular-nums">{count}</div>
                    </div>
                ))}
            </div>

            <div className="rounded-2xl border border-neutral-200 bg-white shadow-sm dark:border-neutral-700 dark:bg-neutral-900">
                <div className="flex flex-wrap gap-2 border-b border-neutral-200 p-3 dark:border-neutral-700">
                    {filters.map(item => (
                        <button
                            key={item.id}
                            type="button"
                            onClick={() => setFilter(item.id)}
                            className={clsx(
                                'min-h-11 rounded-xl px-4 text-sm font-bold transition-colors',
                                filter === item.id
                                    ? 'bg-emerald-600 text-white'
                                    : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700',
                            )}
                        >
                            {item.label} <span className="ml-1 tabular-nums opacity-80">{item.count}</span>
                        </button>
                    ))}
                </div>

                <div className="max-h-[min(46vh,420px)] overflow-auto p-3">
                    {loading && jobs.length === 0 ? (
                        <div className="flex min-h-40 items-center justify-center gap-3 text-neutral-500">
                            <Loader2 className="h-6 w-6 animate-spin" /> {t('queue.loading')}
                        </div>
                    ) : visibleJobs.length === 0 ? (
                        <div className="flex min-h-40 flex-col items-center justify-center gap-2 text-center text-neutral-500">
                            <CheckCircle2 className="h-10 w-10 text-emerald-500" />
                            <strong className="text-neutral-700 dark:text-neutral-200">{t('queue.empty')}</strong>
                            <span className="text-sm">{t('queue.emptyHint')}</span>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {visibleJobs.map(job => {
                                const busy = busyJobId === job.jobId;
                                return (
                                    <article key={job.jobId} className="grid gap-3 rounded-xl border border-neutral-200 p-3 md:grid-cols-[minmax(200px,1.2fr)_minmax(160px,1fr)_auto] md:items-center dark:border-neutral-700">
                                        <div className="min-w-0">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <span className={clsx('rounded-lg px-2.5 py-1 text-xs font-black uppercase', stateTone(job.state))}>
                                                    {t(`queue.state.${job.state}`)}
                                                </span>
                                                <strong className="truncate" title={job.printerName}>{job.printerName}</strong>
                                            </div>
                                            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-neutral-500">
                                                <span title={job.jobId}>ID {shortId(job.jobId)}</span>
                                                <span>{job.protocol.toUpperCase()} / {job.connection}</span>
                                                <span>{job.payloadBytes.toLocaleString()} B</span>
                                            </div>
                                            {job.lastError && <p className="mt-2 line-clamp-2 text-sm text-red-600 dark:text-red-300">{job.lastError}</p>}
                                        </div>
                                        <div className="text-sm text-neutral-600 dark:text-neutral-300">
                                            <div>{t('queue.attempts')}: <strong>{job.attemptCount}</strong></div>
                                            <div className="mt-1">{t('queue.updated')}: <strong>{formatTime(job.updatedAtMs)}</strong></div>
                                        </div>
                                        <div className="flex flex-wrap justify-start gap-2 md:justify-end">
                                            {RETRYABLE_STATES.has(job.state) && (
                                                <button
                                                    type="button"
                                                    onClick={() => requestRetry(job)}
                                                    disabled={busy}
                                                    className="flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 font-bold text-white hover:bg-emerald-500 disabled:opacity-50"
                                                >
                                                    {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <RotateCcw className="h-5 w-5" />}
                                                    {t('queue.retry')}
                                                </button>
                                            )}
                                            {CANCELLABLE_STATES.has(job.state) && (
                                                <button
                                                    type="button"
                                                    onClick={() => void cancelJob(job)}
                                                    disabled={busy}
                                                    className="flex min-h-11 items-center gap-2 rounded-xl border border-red-300 px-4 font-bold text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-500/40 dark:text-red-300 dark:hover:bg-red-500/10"
                                                >
                                                    <XCircle className="h-5 w-5" /> {t('queue.cancel')}
                                                </button>
                                            )}
                                        </div>
                                    </article>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>

            <section className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-700 dark:bg-neutral-900">
                <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                        <h3 className="font-black">{t('queue.printerStatus')}</h3>
                        <p className="text-xs text-neutral-500">{t('queue.printerStatusHint')}</p>
                    </div>
                    {checkingPrinters && <Loader2 className="h-5 w-5 animate-spin text-emerald-600" />}
                </div>
                <div className="grid gap-3 lg:grid-cols-3">
                    {(['packPrinter', 'boxPrinter', 'palletPrinter'] as PrinterRole[]).map(role => {
                        const config = printerConfigs[role];
                        const report = printerReports[role];
                        const roleError = printerErrors[role];
                        return (
                            <div key={role} className={clsx('min-h-24 rounded-xl border p-3', printerStatusTone(report))}>
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                        <div className="text-xs font-bold uppercase tracking-wide text-neutral-500">{roleLabels[role]}</div>
                                        <div className="mt-1 truncate font-black" title={String(config?.name ?? report?.printerName ?? '')}>
                                            {String(config?.name ?? report?.printerName ?? t('queue.notChecked'))}
                                        </div>
                                    </div>
                                    <span className="rounded-lg bg-white/70 px-2 py-1 text-xs font-black uppercase dark:bg-neutral-950/40">
                                        {report ? report.status : roleError ? t('queue.unreachable') : t('queue.notChecked')}
                                    </span>
                                </div>
                                <div className="mt-2 text-xs text-neutral-600 dark:text-neutral-300">
                                    {roleError || report?.details.join(' · ') || t('queue.checkOnDemand')}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </section>

            {confirmRetry && (
                <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/55 p-4" role="dialog" aria-modal="true">
                    <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl dark:bg-neutral-900">
                        <div className="flex items-start gap-3">
                            <AlertTriangle className="h-8 w-8 shrink-0 text-amber-500" />
                            <div>
                                <h3 className="text-xl font-black">{t('queue.retryUncertainTitle')}</h3>
                                <p className="mt-2 text-neutral-600 dark:text-neutral-300">{t('queue.retryUncertainText')}</p>
                                <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm font-bold text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
                                    {confirmRetry.printerName} · {shortId(confirmRetry.jobId)}
                                </p>
                            </div>
                        </div>
                        <div className="mt-6 flex flex-wrap justify-end gap-2">
                            <button type="button" onClick={() => setConfirmRetry(null)} className="min-h-12 rounded-xl border border-neutral-300 px-5 font-bold dark:border-neutral-600">
                                {t('queue.close')}
                            </button>
                            <button type="button" onClick={() => void runRetry(confirmRetry)} className="flex min-h-12 items-center gap-2 rounded-xl bg-amber-500 px-5 font-black text-neutral-950 hover:bg-amber-400">
                                <RotateCcw className="h-5 w-5" /> {t('queue.retryAnyway')}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </section>
    );
};

export default PrintQueueMonitor;