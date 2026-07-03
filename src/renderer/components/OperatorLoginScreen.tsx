import React, { useEffect, useState } from 'react';
import { User, RefreshCw, ArrowRight, LogIn } from 'lucide-react';
import { useTranslation } from '../i18n';
import NumericKeypad from './NumericKeypad';
import { useSession } from './SessionProvider';

interface OperatorTile {
    uuid: string;
    full_name: string;
    short_code: string | null;
    has_pin: boolean;
}

interface OperatorLoginScreenProps {
    /** Called once an operator is logged in (or the user chose to continue without one). */
    onLoggedIn: () => void;
}

/**
 * Operator PIN-login (Layer C). Shows tappable tiles of active operators. Tapping a tile with
 * no PIN logs in immediately; a tile with a PIN opens a masked NumericKeypad. FAIL-OPEN:
 * if there are no operators yet, the screen offers "Sync" and "Continue without operator".
 */
const OperatorLoginScreen: React.FC<OperatorLoginScreenProps> = ({ onLoggedIn }) => {
    const { t } = useTranslation();
    const { refresh } = useSession();

    const [operators, setOperators] = useState<OperatorTile[]>([]);
    const [lastUuid, setLastUuid] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [selected, setSelected] = useState<OperatorTile | null>(null);
    const [pin, setPin] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [syncing, setSyncing] = useState(false);

    const loadOperators = async () => {
        setLoading(true);
        try {
            const res = await window.electron.invoke('operators:list');
            setOperators(res?.operators || []);
            setLastUuid(res?.lastOperatorUuid || null);
        } catch (e) {
            setOperators([]);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadOperators();
        // Refresh tiles when a sync completes (operators may have just arrived).
        const remove = window.electron.on('data-updated', () => loadOperators());
        return () => remove();
    }, []);

    const doLogin = async (uuid: string, enteredPin: string) => {
        setBusy(true);
        setError(null);
        try {
            const res = await window.electron.invoke('session:set', { uuid, pin: enteredPin });
            if (res?.ok) {
                await refresh();
                // Deliberately NOT calling onLoggedIn() here: the gate closes via the
                // session-changed broadcast (currentOperator gets set). onLoggedIn() is
                // ONLY the "continue without operator" fail-open — calling it on a real
                // login marked the session as 'entered anyway' and permanently disabled
                // the "switch operator" button (logout cleared the operator but the
                // stuck flag kept the login screen from ever showing again).
            } else {
                setError(res?.reason === 'bad_pin' ? t('operator.wrongPin') : t('operator.loginFailed'));
            }
        } catch (e) {
            setError(t('operator.loginFailed'));
        } finally {
            setBusy(false);
        }
    };

    const handleTileClick = (op: OperatorTile) => {
        setError(null);
        if (op.has_pin) {
            setSelected(op);
            setPin('');
        } else {
            // No PIN → one-tap login.
            doLogin(op.uuid, '');
        }
    };

    const handleSync = async () => {
        setSyncing(true);
        setError(null);
        try {
            // Reuse the existing offline import flow (prompts for a .lps bundle).
            await window.electron.invoke('offline-import');
        } catch (e) {
            /* ignore — user may have cancelled */
        } finally {
            setSyncing(false);
            loadOperators();
        }
    };

    const handleContinueWithoutOperator = () => {
        // FAIL-OPEN fallback: enter with no operator (operator stays null).
        onLoggedIn();
    };

    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-white p-6 relative overflow-hidden transition-colors">
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-emerald-100/50 dark:from-emerald-900/20 via-neutral-50 dark:via-neutral-950 to-neutral-50 dark:to-neutral-950 pointer-events-none transition-colors" />

            <div className="z-10 w-full max-w-3xl text-center animate-in fade-in slide-in-from-bottom-4 duration-500">
                <div className="mb-8 flex flex-col items-center">
                    <div className="w-16 h-16 bg-emerald-50 dark:bg-emerald-500/10 rounded-2xl flex items-center justify-center border border-emerald-200 dark:border-emerald-500/20 shadow-[0_0_30px_rgba(16,185,129,0.15)] mb-4">
                        <LogIn className="w-8 h-8 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <h1 className="text-3xl font-bold bg-gradient-to-r from-neutral-900 dark:from-white to-neutral-500 dark:to-neutral-400 bg-clip-text text-transparent">
                        {t('operator.selectOperator')}
                    </h1>
                </div>

                {error && (
                    <div className="mb-6 mx-auto max-w-md p-4 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl text-red-600 dark:text-red-200 text-sm">
                        {error}
                    </div>
                )}

                {loading ? (
                    <div className="text-neutral-500 dark:text-neutral-400 py-12">…</div>
                ) : operators.length > 0 ? (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                        {operators.map((op) => (
                            <button
                                key={op.uuid}
                                onClick={() => handleTileClick(op)}
                                disabled={busy}
                                className={
                                    'group flex flex-col items-center gap-3 p-6 rounded-3xl border transition-all active:scale-[0.97] shadow-sm dark:shadow-none ' +
                                    (op.uuid === lastUuid
                                        ? 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-300 dark:border-emerald-500/40'
                                        : 'bg-white dark:bg-neutral-900/50 border-neutral-200 dark:border-neutral-600 hover:border-emerald-300 dark:hover:border-emerald-500/40 hover:bg-emerald-50/50 dark:hover:bg-emerald-500/5')
                                }
                            >
                                <div className="w-16 h-16 rounded-full bg-neutral-100 dark:bg-white/5 border border-neutral-200 dark:border-neutral-600 flex items-center justify-center group-hover:bg-emerald-100 dark:group-hover:bg-emerald-500/20 transition-colors">
                                    <User className="w-8 h-8 text-neutral-500 dark:text-neutral-400 group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors" />
                                </div>
                                <div className="min-h-[2.5rem] flex flex-col items-center justify-center">
                                    <span className="font-bold text-base text-neutral-900 dark:text-white break-words leading-tight">{op.full_name}</span>
                                    {op.short_code && (
                                        <span className="text-xs font-mono text-neutral-500 dark:text-neutral-500 mt-0.5">{op.short_code}</span>
                                    )}
                                </div>
                            </button>
                        ))}
                    </div>
                ) : (
                    /* NO-OPERATORS-YET empty state — never hard-lock. */
                    <div className="mx-auto max-w-md bg-white/80 dark:bg-neutral-900/50 backdrop-blur p-8 rounded-3xl border border-neutral-200 dark:border-neutral-600 shadow-sm">
                        <p className="text-neutral-500 dark:text-neutral-400 mb-8">{t('operator.noOperators')}</p>
                        <button
                            onClick={handleSync}
                            disabled={syncing}
                            className="w-full py-4 mb-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-medium transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                        >
                            <RefreshCw className={'w-5 h-5 ' + (syncing ? 'animate-spin' : '')} />
                            {t('operator.sync')}
                        </button>
                        <button
                            onClick={handleContinueWithoutOperator}
                            className="w-full py-4 bg-neutral-100 dark:bg-white/5 hover:bg-neutral-200 dark:hover:bg-white/10 border border-neutral-200 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300 rounded-xl font-medium transition-all flex items-center justify-center gap-2"
                        >
                            {t('operator.continueWithout')}
                            <ArrowRight className="w-5 h-5" />
                        </button>
                    </div>
                )}
            </div>

            {selected && (
                <NumericKeypad
                    value={pin}
                    mask
                    title={`${t('operator.enterPin')} — ${selected.full_name}`}
                    confirmLabel={t('operator.login')}
                    onUpdate={(v) => { setPin(v); setError(null); }}
                    onConfirm={() => { const op = selected; setSelected(null); doLogin(op.uuid, pin); }}
                    onClose={() => { setSelected(null); setPin(''); }}
                />
            )}
        </div>
    );
};

export default OperatorLoginScreen;
