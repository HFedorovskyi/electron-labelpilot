import type { FC } from 'react';
import clsx from 'clsx';
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { useTranslation } from '../i18n';
import type { LicenseStatus } from '../hooks/useLicenseStatus';

interface LicenseBadgeProps {
    license: LicenseStatus | null;
    /** When true the sidebar is collapsed — render a compact dot-only badge. */
    collapsed?: boolean;
}

/**
 * Small, non-blocking indicator of the connected server's license/demo state.
 *  - mode === 'demo'      -> amber "Демо" badge (product is UNLICENSED, seat-capped)
 *  - mode === 'licensed'  -> emerald "Лицензия: <edition>" badge
 * Renders nothing while the license status is unknown (server offline / not yet fetched),
 * so the sidebar layout never jumps.
 */
const LicenseBadge: FC<LicenseBadgeProps> = ({ license, collapsed }) => {
    const { t } = useTranslation();

    if (!license) return null;

    const isDemo = license.mode === 'demo';
    const expired = license.expired;
    const label = isDemo
        ? t('license.demoBadge')
        : `${t('license.licensed')}: ${license.edition}`;

    const tone = isDemo || expired
        ? 'text-amber-600 dark:text-amber-400 bg-amber-100/60 dark:bg-amber-500/10 border-amber-500/30'
        : 'text-emerald-600 dark:text-emerald-400 bg-emerald-100/60 dark:bg-emerald-500/10 border-emerald-500/30';

    const Icon = isDemo || expired ? ShieldAlert : ShieldCheck;

    if (collapsed) {
        return (
            <div
                title={isDemo ? t('license.demo') : `${t('license.licensed')}: ${license.edition}`}
                className={clsx('flex items-center justify-center rounded-lg border p-1.5', tone)}
            >
                <Icon className="w-4 h-4" />
            </div>
        );
    }

    return (
        <div
            title={isDemo ? t('license.demoHint') : `${t('license.licensed')}: ${license.edition}`}
            className={clsx(
                'flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[10px] font-bold uppercase tracking-wider',
                tone
            )}
        >
            <Icon className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">{label}</span>
        </div>
    );
};

export default LicenseBadge;
