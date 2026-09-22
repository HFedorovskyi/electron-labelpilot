import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, Check } from 'lucide-react';
import { useTranslation } from '../i18n';
import {
    getTauriDurablePrintJobs,
    type TauriDurablePrintJobRecord,
    type TauriDurablePrintState,
} from '../platform/tauriBridge';

const UNRESOLVED_STATES: TauriDurablePrintState[] = [
    'queued',
    'rendering',
    'sending',
    'failed',
    'uncertain',
];

function shortId(value: string): string {
    return value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-7)}` : value;
}

interface StartupUnresolvedPrintModalProps {
    onReviewQueue: () => void;
}

export default function StartupUnresolvedPrintModal({ onReviewQueue }: StartupUnresolvedPrintModalProps) {
    const { t } = useTranslation();
    const [jobs, setJobs] = useState<TauriDurablePrintJobRecord[] | null>(null);
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        if (window.desktopBridge?.runtime !== 'tauri') return;
        let active = true;
        void Promise.all(UNRESOLVED_STATES.map(state => getTauriDurablePrintJobs(state, 5_000)))
            .then(groups => {
                if (!active) return;
                const unresolved = groups
                    .flat()
                    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
                setJobs(unresolved);
                setVisible(unresolved.length > 0);
            })
            .catch(() => {
                if (active) setJobs([]);
            });
        return () => { active = false; };
    }, []);

    if (!visible || jobs === null) return null;

    const review = () => {
        setVisible(false);
        onReviewQueue();
    };

    return (
        <div className="fixed inset-0 z-[400] flex items-center justify-center bg-black/65 p-4" role="dialog" aria-modal="true" aria-labelledby="startup-unresolved-title">
            <div className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl dark:bg-neutral-900">
                <header className="flex items-start gap-4 border-b border-amber-200 bg-amber-50 p-6 dark:border-amber-500/30 dark:bg-amber-500/10">
                    <AlertTriangle className="h-9 w-9 shrink-0 text-amber-600" />
                    <div>
                        <h2 id="startup-unresolved-title" className="text-2xl font-black">{t('queue.startupUnresolvedTitle')}</h2>
                        <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-300">
                            {t('queue.startupUnresolvedText', { count: String(jobs.length) })}
                        </p>
                    </div>
                </header>
                <div className="min-h-0 flex-1 overflow-auto p-4">
                    <div className="space-y-2">
                        {jobs.map(job => (
                            <article key={job.jobId} className="grid gap-2 rounded-xl border border-neutral-200 p-3 sm:grid-cols-[minmax(180px,1fr)_minmax(150px,1fr)_auto] sm:items-center dark:border-neutral-700">
                                <div className="min-w-0">
                                    <div className="truncate font-black" title={job.printerName}>{job.printerName}</div>
                                    <div className="mt-1 truncate text-xs text-neutral-500" title={job.jobId}>ID {shortId(job.jobId)}</div>
                                </div>
                                <div className="text-sm text-neutral-600 dark:text-neutral-300">
                                    {job.protocol.toUpperCase()} / {job.connection} · {job.attemptCount}
                                </div>
                                <span className="rounded-lg bg-amber-100 px-3 py-1.5 text-xs font-black uppercase text-amber-900 dark:bg-amber-500/15 dark:text-amber-300">
                                    {t(`queue.state.${job.state}`)}
                                </span>
                                {job.lastError && <p className="sm:col-span-3 break-words text-xs text-red-600 dark:text-red-300">{job.lastError}</p>}
                            </article>
                        ))}
                    </div>
                </div>
                <footer className="flex flex-wrap justify-end gap-3 border-t border-neutral-200 p-4 dark:border-neutral-700">
                    <button type="button" onClick={() => setVisible(false)} className="flex min-h-12 items-center gap-2 rounded-xl border border-neutral-300 px-5 font-bold dark:border-neutral-600">
                        <Check className="h-5 w-5" /> {t('queue.startupAcknowledge')}
                    </button>
                    <button type="button" onClick={review} className="flex min-h-12 items-center gap-2 rounded-xl bg-amber-500 px-5 font-black text-neutral-950 hover:bg-amber-400">
                        {t('queue.startupReview')} <ArrowRight className="h-5 w-5" />
                    </button>
                </footer>
            </div>
        </div>
    );
}
