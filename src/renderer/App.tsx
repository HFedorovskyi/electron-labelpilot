import { useState, useEffect, lazy, Suspense } from 'react';
import Sidebar from './components/Sidebar';
import WeighingStation from './components/WeighingStation';
import FixedWeightStation from './components/FixedWeightStation';
import PrintJobStation from './components/PrintJobStation';
import PrintView from './components/PrintView';
import OperatorLoginScreen from './components/OperatorLoginScreen';
import { SessionProvider } from './components/SessionProvider';
import type { CurrentOperator } from './components/SessionProvider';
import { useTranslation } from './i18n';
import { ThemeProvider } from './components/ThemeProvider';

// Heavy, non-station tabs: code-split so they don't bloat the initial chunk and are
// only mounted (and their effects/IPC run) when actually opened.
const Products = lazy(() => import('./components/Products'));
const Settings = lazy(() => import('./components/Settings'));

const App = () => {
    const { t } = useTranslation();
    const [activeTab, setActiveTab] = useState('weighing');
    const [toast, setToast] = useState<{ msg: string, type: 'info' | 'success' | 'error' } | null>(null);
    const [serverStatus, setServerStatus] = useState<string>('disconnected');
    const [stationNumber, setStationNumber] = useState<number | null>(null);
    const [loadingIdentity, setLoadingIdentity] = useState(true);
    const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

    // --- Operator login gate state ---
    // stationUuid: null until identity loads. provisioned = identity exists (has a uuid).
    // isDemo: sourced primarily from the DURABLE demo flag (demo.flag file in main, read via
    // the 'demo:status' IPC), with the station-uuid "demo-" prefix kept only as a
    // belt-and-suspenders fallback. currentOperator mirrors the ephemeral main-process
    // session. enteredAnyway: the user chose "continue without operator".
    const [stationUuid, setStationUuid] = useState<string | null>(null);
    const [provisioned, setProvisioned] = useState(false);
    const [durableDemo, setDurableDemo] = useState(false);
    const [currentOperator, setCurrentOperator] = useState<CurrentOperator | null>(null);
    const [enteredAnyway, setEnteredAnyway] = useState(false);

    // Durable flag is authoritative; uuid prefix is a fallback for legacy/transition cases.
    const isDemo = durableDemo || (!!stationUuid && stationUuid.startsWith('demo-'));
    // Synthetic operator for DEMO — bypasses the real login entirely. Prefer the
    // station uuid when present, but fall back to a stable id so the synthetic
    // operator is never null when demo is sourced from the durable flag alone.
    const demoOperator: CurrentOperator | null = isDemo
        ? { uuid: stationUuid || 'demo-operator', full_name: t('operator.demoOperator') }
        : null;

    // Global Sync Listener
    useEffect(() => {
        let serverTimeout: NodeJS.Timeout;

        const loadStationInfo = async () => {
            try {
                // Check for Identity (Physical Station ID)
                const id = await window.electron.invoke('get-identity');
                if (id) {
                    setStationNumber(parseInt(id.station_number));
                    setStationUuid(id.station_uuid || null);
                    setProvisioned(!!id.station_uuid);
                } else {
                    setStationUuid(null);
                    setProvisioned(false);
                }

                // Durable demo flag (main-process owned, survives uuid changes).
                try {
                    const demoStatus = await window.electron.invoke('demo:status');
                    setDurableDemo(!!demoStatus?.isDemo);
                } catch {
                    setDurableDemo(false);
                }

                // Current operator session (ephemeral, main-process owned).
                try {
                    const op = await window.electron.invoke('session:get');
                    setCurrentOperator(op ?? null);
                } catch {
                    setCurrentOperator(null);
                }

                // Also get config for legacy support or other settings
                await window.electron.invoke('get-scale-config');

                // Initial Server Status fetch
                const status = await window.electron.invoke('get-server-status');
                if (status) setServerStatus(status);
            } catch (err) {
                console.error('App: Failed to load station config/status', err);
            } finally {
                setLoadingIdentity(false);
            }
        };

        const removeSyncListener = window.electron.on('sync-complete', (data: any) => {
            if (data.success) {
                setToast({
                    msg: t('app.syncComplete'),
                    type: 'success'
                });
                loadStationInfo(); // Refresh station number and other info
            }
        });

        // Demo seeding and real provisioning both broadcast 'data-updated' — re-read
        // station info (incl. the durable demo flag) so the gate reflects the new state.
        const removeDataUpdatedListener = window.electron.on('data-updated', () => {
            loadStationInfo();
        });

        const removeWeightListener = window.electron.on('scale-weight', (_data: any) => {
            // scaleStatus removed from sidebar
        });

        const removeStatusListener = window.electron.on('server-status-updated', (data: any) => {
            if (data.status) {
                setServerStatus(data.status);
            }
        });

        // Keep the gate in sync when the operator logs in / out (broadcast from main).
        const removeSessionListener = window.electron.on('session-changed', (op: CurrentOperator | null) => {
            setCurrentOperator(op ?? null);
            if (op) setEnteredAnyway(false); // a real login supersedes the "continue without" choice
        });

        const removeDiscoveryListener = window.electron.on('discovery-event', (data: any) => {
            // Priority 1: Background polling status from ServerStatusManager (fallback)
            if (data.status) {
                setServerStatus(data.status);
            }
            // Priority 2: Legacy UDP discovery fallback
            else if (data.type === 'server-found' && !data.status) {
                setServerStatus('connected');
                clearTimeout(serverTimeout);
                serverTimeout = setTimeout(() => {
                    setServerStatus('disconnected');
                }, 10000); // 10 seconds timeout for UDP
            }
        });

        // Signal to main that renderer is ready for events
        window.electron.send('renderer-ready', {});

        loadStationInfo();

        return () => {
            removeSyncListener();
            removeDataUpdatedListener();
            removeWeightListener();
            removeDiscoveryListener();
            removeStatusListener();
            removeSessionListener();
            clearTimeout(serverTimeout);
        };
    }, []);

    // Toast Timer
    useEffect(() => {
        if (toast) {
            const timer = setTimeout(() => setToast(null), 3000);
            return () => clearTimeout(timer);
        }
    }, [toast]);

    // Check if this is a print-only window
    const isPrintWindow = new URLSearchParams(window.location.search).get('print') === 'true';

    if (isPrintWindow) {
        return <PrintView />;
    }

    if (loadingIdentity) {
        return <div className="h-screen w-full bg-neutral-50 dark:bg-neutral-950 flex items-center justify-center text-neutral-900 dark:text-white">Loading...</div>;
    }

    // --- Operator login GATE ---
    // needsLogin = the station is PROVISIONED, is NOT a demo station, the user hasn't already
    // chosen to continue without an operator, AND no operator is currently logged in.
    // FAIL-OPEN cases handled elsewhere:
    //   • DEMO (durable demo flag, or uuid starts with "demo-") → bypass login, use a
    //     synthetic "Демо оператор".
    //   • UNPROVISIONED (no identity) → login is never reached (provisioned === false).
    //   • NO-OPERATORS-YET → the login screen shows an empty state (Sync / Continue without).
    const needsLogin = provisioned && !isDemo && !currentOperator && !enteredAnyway;

    if (needsLogin) {
        return (
            <ThemeProvider defaultTheme="system" storageKey="app-theme">
                <SessionProvider>
                    <OperatorLoginScreen onLoggedIn={() => setEnteredAnyway(true)} />
                </SessionProvider>
            </ThemeProvider>
        );
    }

    return (
        <ThemeProvider defaultTheme="system" storageKey="app-theme">
            <SessionProvider demoOperator={demoOperator}>
            <div className="flex w-full h-screen bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-white font-sans overflow-hidden relative transition-colors duration-200">
                <Sidebar
                    activeTab={activeTab}
                    setActiveTab={setActiveTab}
                    serverStatus={serverStatus}
                    stationNumber={stationNumber}
                    isCollapsed={isSidebarCollapsed}
                    toggleCollapse={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
                />
                <main className="flex-1 overflow-auto p-6 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-white via-neutral-50 to-neutral-100 dark:from-emerald-900/20 dark:via-neutral-900 dark:to-neutral-950 transition-colors duration-200">
                    <div style={{ display: activeTab === 'weighing' ? 'block' : 'none', height: '100%' }}>
                        <WeighingStation activeTab={activeTab} />
                    </div>
                    <div style={{ display: activeTab === 'fixedWeight' ? 'block' : 'none', height: '100%' }}>
                        <FixedWeightStation activeTab={activeTab} />
                    </div>
                    <div style={{ display: activeTab === 'printJob' ? 'block' : 'none', height: '100%' }}>
                        <PrintJobStation activeTab={activeTab} />
                    </div>
                    {/* Lazy, mount-on-demand. Stations above stay mounted (they hold the
                        active weighing/print session); these reload cheaply when reopened. */}
                    {activeTab === 'products' && (
                        <div style={{ height: '100%' }}>
                            <Suspense fallback={null}><Products /></Suspense>
                        </div>
                    )}
                    {activeTab === 'settings' && (
                        <div style={{ height: '100%' }}>
                            <Suspense fallback={null}><Settings /></Suspense>
                        </div>
                    )}
                </main>

                {/* Global Toast Notification */}
                {
                    toast && (
                        <div className={`fixed bottom-8 right-8 px-6 py-4 rounded-2xl shadow-2xl backdrop-blur border flex items-center gap-3 animate-in slide-in-from-right duration-300 z-[200] ${toast.type === 'success' ? 'bg-emerald-100/90 dark:bg-emerald-900/80 border-emerald-500/30 text-emerald-900 dark:text-emerald-100' :
                            toast.type === 'error' ? 'bg-red-100/90 dark:bg-red-900/80 border-red-500/30 text-red-900 dark:text-red-100' :
                                'bg-white/90 dark:bg-neutral-900/80 border-neutral-200 dark:border-white/10 text-neutral-900 dark:text-white'
                            }`}>
                            {toast.type === 'success' && <div className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.5)]" />}
                            {toast.type === 'error' && <div className="w-2 h-2 rounded-full bg-red-400 shadow-[0_0_10px_rgba(248,113,113,0.5)]" />}
                            <span className="font-medium">{toast.msg}</span>
                        </div>
                    )
                }
            </div>
            </SessionProvider>
        </ThemeProvider>
    );
};

export default App;
