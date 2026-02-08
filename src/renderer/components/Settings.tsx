import { useState, useEffect } from 'react';
import { Save, RefreshCw, Settings as SettingsIcon, Server, Monitor } from 'lucide-react';

interface SerialPortInfo {
    path: string;
    manufacturer?: string;
}

interface ProtocolInfo {
    id: string;
    name: string;
    description: string;
}

interface DiscoveredDevice {
    ip: string;
    type: 'LABELPILOT_SERVER' | 'LABELPILOT_STATION';
    lastSeen: number;
}

const Settings = () => {
    const [ports, setPorts] = useState<SerialPortInfo[]>([]);
    const [protocols, setProtocols] = useState<ProtocolInfo[]>([]);
    const [config, setConfig] = useState({
        type: 'serial',
        protocolId: 'simulator',
        path: '',
        baudRate: 9600,
        host: '192.168.1.50',
        port: 8000,
        pollingInterval: 500,
        stabilityCount: 5
    });

    const [appMode, setAppMode] = useState<'station' | 'server'>('station');
    const [discoveredDevices, setDiscoveredDevices] = useState<DiscoveredDevice[]>([]);
    const [manualIp, setManualIp] = useState('127.0.0.1');
    const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'success' | 'error'>('idle');
    const [toastMessage, setToastMessage] = useState<string | null>(null);

    useEffect(() => {
        loadData();

        // Listen for discovery events
        const removeDiscoveryListener = window.electron.on('discovery-event', (data: any) => {
            setDiscoveredDevices(prev => {
                const exists = prev.find(d => d.ip === data.ip);
                if (exists) return prev.map(d => d.ip === data.ip ? { ...d, lastSeen: Date.now() } : d);
                return [...prev, { ip: data.ip, type: data.type === 'server-found' ? 'LABELPILOT_SERVER' : 'LABELPILOT_STATION', lastSeen: Date.now() }];
            });

            // Auto-fill IP if station finds server
            if (appMode === 'station' && data.type === 'server-found') {
                setManualIp(data.ip);
            }
        });

        return () => {
            removeDiscoveryListener();
        };
    }, [appMode]); // Re-bind if mode changes might stay same listener but logic inside usage

    useEffect(() => {
        // Inform main process of mode change
        window.electron.send('set-app-mode', appMode);
        setDiscoveredDevices([]); // Clear list on mode switch
    }, [appMode]);

    const showToast = (msg: string) => {
        setToastMessage(msg);
        setTimeout(() => setToastMessage(null), 3000);
    };

    const handleSync = async () => {
        const targetIp = manualIp;
        if (!targetIp) {
            showToast("Enter Server IP");
            return;
        }

        try {
            setSyncStatus('syncing');
            await window.electron.invoke('sync-data', targetIp);
            setSyncStatus('success');
            showToast("Data Synced Successfully!");
        } catch (err) {
            console.error(err);
            setSyncStatus('error');
            showToast("Sync Failed. Check Server.");
        } finally {
            setTimeout(() => setSyncStatus('idle'), 2000);
        }
    };

    const loadData = async () => {
        try {
            const portsList = await window.electron.invoke('get-serial-ports');
            const protocolsList = await window.electron.invoke('get-protocols');
            const savedConfig = await window.electron.invoke('get-scale-config');

            setPorts(portsList);
            setProtocols(protocolsList);

            if (savedConfig) {
                setConfig(savedConfig);
            } else if (portsList.length > 0 && !config.path) {
                setConfig(prev => ({ ...prev, path: portsList[0].path }));
            }
        } catch (err) {
            console.error("Failed to load settings data", err);
        }
    };

    const handleSave = () => {
        console.log('Saving config:', config);
        window.electron.send('save-scale-config', config);
        showToast("Configuration Saved");
    };

    return (
        <div className="bg-neutral-900 min-h-screen text-white p-8 relative">
            {/* Toast Notification */}
            {toastMessage && (
                <div className="fixed bottom-8 right-8 bg-emerald-600 text-white px-6 py-3 rounded-xl shadow-2xl flex items-center gap-3 animate-bounce z-50">
                    <div className="w-2 h-2 bg-white rounded-full"></div>
                    {toastMessage}
                </div>
            )}

            <h1 className="text-3xl font-bold mb-8 flex items-center gap-3">
                <SettingsIcon className="w-8 h-8 text-emerald-500" />
                Settings
            </h1>

            <div className="space-y-8 max-w-4xl">
                {/* App Mode Selection */}
                <div className="p-6 bg-white/5 border border-white/10 rounded-2xl">
                    <h2 className="text-xl font-semibold mb-4 text-purple-400">Application Mode</h2>
                    <div className="flex gap-4">
                        <button
                            onClick={() => setAppMode('station')}
                            className={`flex-1 p-4 rounded-xl border flex items-center justify-center gap-3 transition-all
                                ${appMode === 'station' ? 'bg-purple-500/20 border-purple-500 text-purple-300' : 'bg-black/20 border-white/10 hover:bg-white/5'}
                            `}
                        >
                            <Monitor size={24} />
                            <div className="text-left">
                                <div className="font-bold">Station Mode</div>
                                <div className="text-xs opacity-70">Connects to a central server</div>
                            </div>
                        </button>
                        <button
                            onClick={() => setAppMode('server')}
                            className={`flex-1 p-4 rounded-xl border flex items-center justify-center gap-3 transition-all
                                ${appMode === 'server' ? 'bg-purple-500/20 border-purple-500 text-purple-300' : 'bg-black/20 border-white/10 hover:bg-white/5'}
                            `}
                        >
                            <Server size={24} />
                            <div className="text-left">
                                <div className="font-bold">Server Mode</div>
                                <div className="text-xs opacity-70">Manages data for stations</div>
                            </div>
                        </button>
                    </div>

                    {/* Discovery List */}
                    <div className="mt-6">
                        <h3 className="text-sm font-medium text-neutral-400 mb-2">
                            {appMode === 'station' ? 'Discovered Servers' : 'Connected Stations'}
                        </h3>
                        <div className="bg-black/30 rounded-xl p-2 min-h-[60px]">
                            {discoveredDevices.length === 0 && (
                                <div className="text-neutral-600 text-sm p-2 italic flex items-center gap-2">
                                    <span className="w-2 h-2 bg-neutral-600 rounded-full animate-pulse"></span>
                                    Searching for devices...
                                </div>
                            )}
                            {discoveredDevices.map(device => (
                                <div key={device.ip} className="flex justify-between items-center p-3 hover:bg-white/5 rounded-lg">
                                    <div className="flex items-center gap-3">
                                        {appMode === 'station' ? <Server size={16} className="text-emerald-400" /> : <Monitor size={16} className="text-blue-400" />}
                                        <span className="font-mono">{device.ip}</span>
                                    </div>
                                    {appMode === 'station' && (
                                        <button
                                            onClick={() => setManualIp(device.ip)}
                                            className="text-xs bg-white/10 hover:bg-white/20 px-3 py-1 rounded"
                                        >
                                            Use this IP
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Data Synchronization Section (Only for Station) */}
                {appMode === 'station' && (
                    <div className="p-6 bg-white/5 border border-white/10 rounded-2xl">
                        <h2 className="text-xl font-semibold mb-4 text-emerald-400">Data Synchronization</h2>
                        <div className="flex justify-between items-end bg-black/30 p-4 rounded-xl mb-4 gap-4">
                            <div className="flex-1">
                                <label className="text-sm text-neutral-400 mb-2 block">Server IP Address</label>
                                <div className="relative">
                                    <input
                                        type="text"
                                        value={manualIp}
                                        onChange={(e) => setManualIp(e.target.value)}
                                        placeholder="e.g. 192.168.1.100"
                                        className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-white font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                                    />
                                </div>
                            </div>
                            <button
                                onClick={handleSync}
                                disabled={!manualIp || syncStatus === 'syncing'}
                                className={`px-6 py-3 rounded-xl font-bold transition-all flex items-center gap-2 h-[50px]
                                    ${syncStatus === 'syncing' ? 'bg-neutral-700 cursor-wait' :
                                        !manualIp ? 'bg-neutral-800 text-neutral-500 cursor-not-allowed' :
                                            'bg-emerald-600 hover:bg-emerald-500 shadow-lg hover:shadow-emerald-500/20'}
                                `}
                            >
                                <RefreshCw className={`w-5 h-5 ${syncStatus === 'syncing' ? 'animate-spin' : ''}`} />
                                {syncStatus === 'syncing' ? 'Syncing...' : 'Sync Data'}
                            </button>
                        </div>
                    </div>
                )}

                {/* Scale Configuration Section */}
                <div className="p-6 bg-white/5 border border-white/10 rounded-2xl">
                    <h2 className="text-xl font-semibold mb-6 text-white">Weighing Configuration</h2>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                        {/* Left Column: Connection */}
                        <div className="space-y-6">
                            <h3 className="text-lg font-medium text-white/80 border-b border-white/5 pb-2">Connection Interface</h3>

                            <div>
                                <label className="block text-sm text-neutral-400 mb-2">Interface Type</label>
                                <select
                                    value={config.type}
                                    onChange={(e) => setConfig({ ...config, type: e.target.value })}
                                    className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all hover:bg-black/30"
                                >
                                    <option value="serial">Serial Port (USB/COM)</option>
                                    <option value="tcp">Ethernet (TCP/IP)</option>
                                    <option value="simulator">Simulator (Virtual)</option>
                                </select>
                            </div>

                            {config.type === 'serial' && (
                                <div className="space-y-4">
                                    <div>
                                        <div className="flex justify-between mb-2">
                                            <label className="text-sm text-neutral-400">Port</label>
                                            <button onClick={loadData} className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1">
                                                <RefreshCw size={12} /> Refresh
                                            </button>
                                        </div>
                                        <select
                                            value={config.path}
                                            onChange={(e) => setConfig({ ...config, path: e.target.value })}
                                            className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                                        >
                                            {ports.map(p => (
                                                <option key={p.path} value={p.path}>{p.path} {p.manufacturer ? `(${p.manufacturer})` : ''}</option>
                                            ))}
                                            {ports.length === 0 && <option value="" disabled>No ports found</option>}
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block text-sm text-neutral-400 mb-2">Baud Rate</label>
                                        <select
                                            value={config.baudRate}
                                            onChange={(e) => setConfig({ ...config, baudRate: Number(e.target.value) })}
                                            className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                                        >
                                            {[1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].map(rate => (
                                                <option key={rate} value={rate}>{rate}</option>
                                            ))}
                                        </select>
                                    </div>
                                </div>
                            )}

                            {config.type === 'tcp' && (
                                <div className="grid grid-cols-3 gap-4">
                                    <div className="col-span-2">
                                        <label className="block text-sm text-neutral-400 mb-2">IP Address</label>
                                        <input
                                            type="text"
                                            value={config.host}
                                            onChange={(e) => setConfig({ ...config, host: e.target.value })}
                                            className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-sm text-neutral-400 mb-2">Port</label>
                                        <input
                                            type="number"
                                            value={config.port}
                                            onChange={(e) => setConfig({ ...config, port: Number(e.target.value) })}
                                            className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                                        />
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Right Column: Protocol & Advanced */}
                        <div className="space-y-6">
                            <h3 className="text-lg font-medium text-white/80 border-b border-white/5 pb-2">Protocol & Tuning</h3>

                            <div>
                                <label className="block text-sm text-neutral-400 mb-2">Scale Protocol</label>
                                <select
                                    value={config.protocolId}
                                    onChange={(e) => setConfig({ ...config, protocolId: e.target.value })}
                                    className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                                    disabled={config.type === 'simulator'}
                                >
                                    {protocols.map(p => (
                                        <option key={p.id} value={p.id}>{p.name}</option>
                                    ))}
                                </select>
                                <p className="mt-2 text-xs text-white/40">
                                    {protocols.find(p => p.id === config.protocolId)?.description}
                                </p>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm text-neutral-400 mb-2">Polling (ms)</label>
                                    <input
                                        type="number"
                                        value={config.pollingInterval}
                                        onChange={(e) => setConfig({ ...config, pollingInterval: Number(e.target.value) })}
                                        className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm text-neutral-400 mb-2">Stability (Readings)</label>
                                    <input
                                        type="number"
                                        value={config.stabilityCount}
                                        onChange={(e) => setConfig({ ...config, stabilityCount: Number(e.target.value) })}
                                        className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="mt-8 flex justify-end pt-6 border-t border-white/5">
                        <button
                            onClick={handleSave}
                            className="flex items-center gap-2 px-8 py-3 bg-emerald-600 hover:bg-emerald-500 hover:shadow-lg hover:shadow-emerald-500/20 rounded-xl font-semibold text-white transition-all transform active:scale-95"
                        >
                            <Save size={18} />
                            Save Configuration
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default Settings;
