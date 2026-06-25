import { useState } from 'react';
import type { ComponentType } from 'react';
import {
    KeyRound, ShieldCheck, ShieldAlert, Copy, Check, RefreshCw,
    Building2, CalendarClock, Server, Sparkles, Layers, Fingerprint,
} from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from '../i18n';
import { useLicenseStatus } from '../hooks/useLicenseStatus';

const cardCls =
    'p-6 bg-white dark:bg-white/5 border border-neutral-200 dark:border-neutral-600 rounded-2xl shadow-sm dark:shadow-none';

/** One label/value row in the details grid. */
const Row = ({ icon: Icon, label, value, valueCls }: {
    icon: ComponentType<{ className?: string }>;
    label: string;
    value: string;
    valueCls?: string;
}) => (
    <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-neutral-500 dark:text-neutral-400 shrink-0">
            <Icon className="w-4 h-4" />{label}
        </span>
        <span className={clsx('font-medium text-right truncate', valueCls)} title={value}>{value}</span>
    </div>
);

/** Green/red validity chip (signature / machine binding). */
const Indicator = ({ ok, okLabel, badLabel }: { ok: boolean; okLabel: string; badLabel: string }) => (
    <span className={clsx('flex items-center gap-1.5', ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
        {ok ? <ShieldCheck className="w-4 h-4" /> : <ShieldAlert className="w-4 h-4" />}
        {ok ? okLabel : badLabel}
    </span>
);

/**
 * Full in-app License panel. Reads the connected server's license/demo state via the same
 * hook the sidebar badge uses, and surfaces everything the operator needs for an OFFLINE,
 * machine-bound license: the server's `machine_id` (copyable — needed to obtain/renew a
 * licence), edition / customer / expiry / station cap / features, and the signature &
 * binding validity reported by the server. The client only READS status; activation itself
 * happens on the server, so the "how to" steps explain the offline issuance flow.
 */
const LicensePanel = () => {
    const { t } = useTranslation();
    const { license, refresh } = useLicenseStatus();
    const [copied, setCopied] = useState(false);

    const copyMachineId = async () => {
        if (!license?.machine_id) return;
        try {
            await navigator.clipboard.writeText(license.machine_id);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            /* clipboard unavailable — ignore */
        }
    };

    const isLicensed = license?.mode === 'licensed';
    const isDemo = license?.mode === 'demo';
    const expired = !!license?.expired;

    // Status pill descriptor.
    const pill = (() => {
        if (!license) return { label: t('license.statusUnknown'), cls: 'text-neutral-500 dark:text-neutral-400 bg-neutral-100 dark:bg-white/5 border-neutral-300 dark:border-neutral-600' };
        if (isDemo) return { label: t('license.demoBadge'), cls: 'text-amber-600 dark:text-amber-400 bg-amber-100/60 dark:bg-amber-500/10 border-amber-500/30' };
        if (expired) return { label: t('license.statusExpired'), cls: 'text-red-600 dark:text-red-400 bg-red-100/60 dark:bg-red-500/10 border-red-500/30' };
        return { label: t('license.statusActive'), cls: 'text-emerald-600 dark:text-emerald-400 bg-emerald-100/60 dark:bg-emerald-500/10 border-emerald-500/30' };
    })();

    const showHowTo = !license || isDemo || expired;

    return (
        <div className="max-w-5xl mx-auto space-y-6 pb-10">
            {/* Header */}
            <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-xl bg-emerald-100/60 dark:bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400">
                        <KeyRound className="w-6 h-6" />
                    </div>
                    <div>
                        <h1 className="text-2xl font-bold">{t('license.title')}</h1>
                        <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('license.subtitle')}</p>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    <span className={clsx('px-3 py-1 rounded-full border text-xs font-bold uppercase tracking-wider', pill.cls)}>{pill.label}</span>
                    <button
                        onClick={() => refresh()}
                        className="flex items-center gap-2 px-4 py-2 rounded-xl bg-neutral-100 dark:bg-white/5 border border-neutral-200 dark:border-neutral-600 text-sm font-medium text-neutral-600 dark:text-neutral-300 hover:text-emerald-600 dark:hover:text-emerald-400 hover:border-emerald-300 dark:hover:border-emerald-500/40 transition-colors"
                    >
                        <RefreshCw className="w-4 h-4" />
                        {t('license.refresh')}
                    </button>
                </div>
            </div>

            {/* Status banner */}
            {!license ? (
                <div className={clsx(cardCls, 'flex items-center gap-3 text-neutral-500 dark:text-neutral-400')}>
                    <ShieldAlert className="w-5 h-5 shrink-0 opacity-60" />
                    <span>{t('license.serverOffline')}</span>
                </div>
            ) : isDemo ? (
                <div className="p-5 rounded-2xl border bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/20">
                    <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300 font-semibold">
                        <ShieldAlert className="w-5 h-5 shrink-0" />
                        <span>{t('license.demo')}</span>
                    </div>
                    <p className="mt-2 text-sm text-amber-700/80 dark:text-amber-300/80">{t('license.demoHint')}</p>
                </div>
            ) : (
                <div className={clsx(
                    'p-5 rounded-2xl border',
                    expired
                        ? 'bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/20'
                        : 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/20',
                )}>
                    <div className={clsx('flex items-center gap-2 font-semibold', expired ? 'text-red-700 dark:text-red-300' : 'text-emerald-700 dark:text-emerald-300')}>
                        {expired ? <ShieldAlert className="w-5 h-5 shrink-0" /> : <ShieldCheck className="w-5 h-5 shrink-0" />}
                        <span>{t('license.licensed')}: {license.edition}</span>
                    </div>
                    {expired && <p className="mt-2 text-sm text-red-700/80 dark:text-red-300/80">{t('license.expired')}</p>}
                </div>
            )}

            {/* Details */}
            {license && (
                <div className={cardCls}>
                    <h2 className="text-lg font-semibold mb-5 flex items-center gap-2.5 text-emerald-600 dark:text-emerald-400">
                        <Layers className="w-5 h-5" /> {t('license.details')}
                    </h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4 text-sm">
                        <Row icon={Sparkles} label={t('license.editionLabel')} value={license.edition || '—'} />
                        <Row icon={Building2} label={t('license.customer')} value={license.customer || '—'} />
                        <Row
                            icon={CalendarClock}
                            label={t('license.expires')}
                            value={license.expires
                                ? license.expires + (expired ? ` (${t('license.statusExpired')})` : '')
                                : '—'}
                            valueCls={expired ? 'text-red-600 dark:text-red-400' : undefined}
                        />
                        {/* Stations: used / cap + a small fill bar when there is a finite cap. */}
                        <div className="flex flex-col gap-1.5">
                            <div className="flex items-center justify-between gap-2">
                                <span className="flex items-center gap-2 text-neutral-500 dark:text-neutral-400"><Server className="w-4 h-4" />{t('license.stations')}</span>
                                <span className="font-mono">{license.stations_used} / {license.max_stations ?? '∞'}</span>
                            </div>
                            {license.max_stations != null && license.max_stations > 0 && (
                                <div className="h-1.5 rounded-full bg-neutral-200 dark:bg-white/10 overflow-hidden">
                                    <div
                                        className={clsx('h-full rounded-full', license.stations_used > license.max_stations ? 'bg-red-500' : 'bg-emerald-500')}
                                        style={{ width: `${Math.min(100, (license.stations_used / license.max_stations) * 100)}%` }}
                                    />
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Features */}
                    <div className="mt-5 pt-5 border-t border-neutral-200 dark:border-neutral-600">
                        <div className="flex items-center gap-2 text-neutral-500 dark:text-neutral-400 text-sm mb-2"><Sparkles className="w-4 h-4" />{t('license.features')}</div>
                        {license.features && license.features.length > 0 ? (
                            <div className="flex flex-wrap gap-2">
                                {license.features.map((f) => (
                                    <span key={f} className="px-2.5 py-1 rounded-lg text-xs font-medium bg-emerald-100/60 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20">{f}</span>
                                ))}
                            </div>
                        ) : (
                            <span className="text-sm text-neutral-400 dark:text-neutral-500">{t('license.noFeatures')}</span>
                        )}
                    </div>
                </div>
            )}

            {/* Server binding (machine_id + validity) */}
            {license && (
                <div className={cardCls}>
                    <h2 className="text-lg font-semibold mb-5 flex items-center gap-2.5 text-emerald-600 dark:text-emerald-400">
                        <Fingerprint className="w-5 h-5" /> {t('license.binding')}
                    </h2>
                    <label className="text-sm text-neutral-500 dark:text-neutral-400">{t('license.machineId')}</label>
                    <div className="mt-2 flex items-center gap-2">
                        <code className="flex-1 px-3 py-2.5 rounded-xl bg-neutral-100 dark:bg-black/30 border border-neutral-200 dark:border-neutral-600 font-mono text-sm break-all select-all">{license.machine_id || '—'}</code>
                        <button
                            onClick={copyMachineId}
                            disabled={!license.machine_id}
                            className={clsx(
                                'flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors shrink-0',
                                copied
                                    ? 'bg-emerald-600 text-white'
                                    : 'bg-neutral-100 dark:bg-white/5 border border-neutral-200 dark:border-neutral-600 text-neutral-600 dark:text-neutral-300 hover:text-emerald-600 dark:hover:text-emerald-400 hover:border-emerald-300 dark:hover:border-emerald-500/40',
                                !license.machine_id && 'opacity-50 cursor-not-allowed',
                            )}
                        >
                            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                            {copied ? t('license.copied') : t('license.copy')}
                        </button>
                    </div>

                    {/* Validity indicators — only meaningful for a real (non-demo) license. */}
                    {isLicensed && (
                        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
                            <Indicator ok={license.signature_valid} okLabel={t('license.signatureValid')} badLabel={t('license.signatureInvalid')} />
                            <Indicator ok={license.machine_ok} okLabel={t('license.machineMatch')} badLabel={t('license.machineMismatch')} />
                            {license.strict && (
                                <span className="flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400"><ShieldCheck className="w-4 h-4" />{t('license.strictOn')}</span>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* How to obtain / renew — shown in demo, expired, or unknown states. */}
            {showHowTo && (
                <div className={clsx(cardCls, 'border-emerald-200 dark:border-emerald-500/20')}>
                    <h2 className="text-lg font-semibold mb-4 flex items-center gap-2.5 text-emerald-600 dark:text-emerald-400">
                        <KeyRound className="w-5 h-5" /> {t('license.howToTitle')}
                    </h2>
                    <ol className="space-y-3">
                        {[t('license.howToStep1'), t('license.howToStep2'), t('license.howToStep3')].map((step, i) => (
                            <li key={i} className="flex gap-3 text-sm text-neutral-700 dark:text-neutral-300">
                                <span className="shrink-0 w-6 h-6 rounded-full bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 flex items-center justify-center text-xs font-bold">{i + 1}</span>
                                <span className="pt-0.5">{step}</span>
                            </li>
                        ))}
                    </ol>
                </div>
            )}
        </div>
    );
};

export default LicensePanel;
