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

    // Global Sync Listener
    useEffect(() => {
        let serverTimeout: NodeJS.Timeout;

        const loadStationInfo = async () => {
            try {
                const config = await window.electron.invoke('get-scale-config');
                if (config?.stationNumber) {
                    setStationNumber(config.stationNumber);
                } else {
                    const info = await window.electron.invoke('get-station-info');
                    if (info?.id) setStationNumber(info.id);
                }
            } catch (err) {
                console.error('App: Failed to load station config', err);
            }
        };

        const removeSyncListener = window.electron.on('sync-complete', (data: any) => {
            console.log('App: Sync complete received', data);
            if (data.success) {
                setToast({
                    msg: t('app.syncComplete'),
                    type: 'success'
                });
            }
        });

        const removeWeightListener = window.electron.on('scale-weight', (_data: any) => {
            // scaleStatus removed from sidebar, no need to track here for global state
        });

        const removeDiscoveryListener = window.electron.on('discovery-event', (data: any) => {
            if (data.type === 'server-found') {
                setServerStatus('connected');
                clearTimeout(serverTimeout);
                serverTimeout = setTimeout(() => {
                    setServerStatus('disconnected');
                }, 10000); // 10 seconds timeout
            }
        });

        loadStationInfo();

        return () => {
            removeSyncListener();
            removeWeightListener();
            removeDiscoveryListener();
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

    return (
        <div className="flex w-full h-screen bg-neutral-950 text-white font-sans overflow-hidden relative">
            <Sidebar
                activeTab={activeTab}
                setActiveTab={setActiveTab}
                serverStatus={serverStatus}
                stationNumber={stationNumber}
            />
            <main className="flex-1 overflow-auto p-6 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-emerald-900/20 via-neutral-950 to-neutral-950">
                {activeTab === 'weighing' && <WeighingStation />}
                {activeTab === 'products' && <Products />}
                {activeTab === 'database' && <DatabaseViewer />}
                {activeTab === 'settings' && <Settings />}
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
