import { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import WeighingStation from './components/WeighingStation';
import Products from './components/Products';
import Settings from './components/Settings';
import PrintView from './components/PrintView';
import DatabaseViewer from './components/DatabaseViewer';
import { useTranslation } from './i18n';

const App = () => {
    const { t } = useTranslation();
    const [activeTab, setActiveTab] = useState('weighing');
    const [toast, setToast] = useState<{ msg: string, type: 'info' | 'success' | 'error' } | null>(null);
    const [serverStatus, setServerStatus] = useState<string>('disconnected');
    const [stationNumber, setStationNumber] = useState<number | null>(null);
    const [loadingIdentity, setLoadingIdentity] = useState(true);

    // Global Sync Listener
    useEffect(() => {
        let serverTimeout: NodeJS.Timeout;

        const loadStationInfo = async () => {
            try {
                // Check for Identity (Physical Station ID)
                const id = await window.electron.invoke('get-identity');
                if (id) {
                    setStationNumber(parseInt(id.station_number));
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

        const removeWeightListener = window.electron.on('scale-weight', (_data: any) => {
            // scaleStatus removed from sidebar
        });

        const removeStatusListener = window.electron.on('server-status-updated', (data: any) => {
            if (data.status) {
                setServerStatus(data.status);
            }
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
            removeWeightListener();
            removeDiscoveryListener();
            removeStatusListener();
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
        return <div className="h-screen w-full bg-neutral-950 flex items-center justify-center text-white">Loading...</div>;
    }

    return (
        <div className="flex w-full h-screen bg-neutral-950 text-white font-sans overflow-hidden relative">
            <Sidebar
                activeTab={activeTab}
                setActiveTab={setActiveTab}
                serverStatus={serverStatus}
                stationNumber={stationNumber}
            />
            <main className="flex-1 overflow-auto p-6 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-emerald-900/20 via-neutral-900 to-neutral-950">
                <div style={{ display: activeTab === 'weighing' ? 'block' : 'none', height: '100%' }}>
                    <WeighingStation activeTab={activeTab} />
                </div>
                <div style={{ display: activeTab === 'products' ? 'block' : 'none', height: '100%' }}>
                    <Products />
                </div>
                <div style={{ display: activeTab === 'database' ? 'block' : 'none', height: '100%' }}>
                    <DatabaseViewer />
                </div>
                <div style={{ display: activeTab === 'settings' ? 'block' : 'none', height: '100%' }}>
                    <Settings />
                </div>
            </main>

            {/* Global Toast Notification */}
            {
                toast && (
                    <div className={`fixed bottom-8 right-8 px-6 py-4 rounded-2xl shadow-2xl backdrop-blur border flex items-center gap-3 animate-in slide-in-from-right duration-300 z-[200] ${toast.type === 'success' ? 'bg-emerald-900/80 border-emerald-500/30 text-emerald-100' :
                        toast.type === 'error' ? 'bg-red-900/80 border-red-500/30 text-red-100' :
                            'bg-neutral-900/80 border-white/10 text-white'
                        }`}>
                        {toast.type === 'success' && <div className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.5)]" />}
                        {toast.type === 'error' && <div className="w-2 h-2 rounded-full bg-red-400 shadow-[0_0_10px_rgba(248,113,113,0.5)]" />}
                        <span className="font-medium">{toast.msg}</span>
                    </div>
                )
            }
        </div>
    );
};

export default App;
