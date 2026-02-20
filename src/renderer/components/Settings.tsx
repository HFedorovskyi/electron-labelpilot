import { useState, useEffect } from 'react';
import { Save, RefreshCw, Settings as SettingsIcon, Printer, Languages } from 'lucide-react';
import PrinterSettings from './PrinterSettings';
import UpdateSettings from './UpdateSettings';
import { useTranslation, type Lang } from '../i18n';

interface SerialPortInfo {
    path: string;
    manufacturer?: string;
}

interface ProtocolInfo {
    id: string;
    name: string;
    description: string;
}

interface PrinterInfo {
    name: string;
    displayName: string;
    isDefault: boolean;
    status: number;
}

const Settings = () => {
    const { t, lang, setLang } = useTranslation();
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

    const [printers, setPrinters] = useState<PrinterInfo[]>([]);
    const [printerConfig, setPrinterConfig] = useState<any>({
        packPrinter: {
            id: 'pack_default',
            active: false,
            name: 'Pack Printer',
            connection: 'windows_driver',
            protocol: 'image',
            port: 9100,
            baudRate: 9600,
            dpi: 203
        },
        boxPrinter: {
            id: 'box_default',
            active: false,
            name: 'Box Printer',
            connection: 'windows_driver',
            protocol: 'image',
            port: 9100,
            baudRate: 9600,
            dpi: 203
        },
        autoPrintOnStable: false,
        serverIp: ''
    });
    const [isSyncing, setIsSyncing] = useState(false);

    const [toastMessage, setToastMessage] = useState<string | null>(null);
    const [showResetModal, setShowResetModal] = useState(false);
    const [isResetting, setIsResetting] = useState(false);

    useEffect(() => {
        loadData();
    }, []);

    const showToast = (msg: string) => {
        setToastMessage(msg);
        setTimeout(() => setToastMessage(null), 3000);
    };

    const loadData = async () => {
        try {
            const portsList = await window.electron.invoke('get-serial-ports');
            const protocolsList = await window.electron.invoke('get-protocols');
            const savedConfig = await window.electron.invoke('get-scale-config');

            const printersList = await window.electron.invoke('get-printers');
            const savedPrinterConfig = await window.electron.invoke('get-printer-config');

            setPorts(portsList);
            setProtocols(protocolsList);

            if (savedPrinterConfig) setPrinterConfig(savedPrinterConfig);
            if (printersList) setPrinters(printersList);

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
        window.electron.send('save-scale-config', config);
        window.electron.send('save-printer-config', printerConfig);
        showToast(t('settings.saved'));
    };

    const handleSync = async () => {
        if (!printerConfig.serverIp) {
            showToast(t('settings.serverIpRequired'));
            return;
        }

        setIsSyncing(true);
        try {
            await window.electron.invoke('sync-data', printerConfig.serverIp);
            showToast(t('settings.connectionSuccess'));
        } catch (error) {
            console.error('Connection test failed:', error);
            showToast(t('settings.connectionFailed'));
        } finally {
            setIsSyncing(false);
        }
    };

    const handleReset = async () => {
        setIsResetting(true);
        try {
            const res = await window.electron.invoke('reset-database');
            if (res.success) {
                showToast(t('settings.resetSuccess') || 'Database Reset Successfully');
                // Reload data to reflect empty state
                window.location.reload();
            } else {
                showToast(res.message);
            }
        } catch (error) {
            console.error('Reset failed:', error);
            showToast('Reset failed');
        } finally {
            setIsResetting(false);
            setShowResetModal(false);
        }
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
                {t('settings.title')}
            </h1>

            <div className="space-y-8 max-w-4xl">
                {/* ── Language Configuration ── */}
                <div className="p-6 bg-white/5 border border-white/10 rounded-2xl">
                    <h2 className="text-xl font-semibold mb-6 flex items-center gap-3 text-emerald-400">
                        <Languages className="w-6 h-6" />
                        {t('settings.language')}
                    </h2>
                    <div className="flex gap-4">
                        {(['ru', 'en', 'de'] as Lang[]).map((l) => (
                            <button
                                key={l}
                                onClick={() => setLang(l)}
                                className={`px-6 py-3 rounded-xl border transition-all font-medium ${lang === l
                                    ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400 shadow-[0_0_20px_rgba(16,185,129,0.1)]'
                                    : 'bg-black/20 border-white/10 text-neutral-400 hover:text-white hover:bg-white/5'
                                    }`}
                            >
                                {l.toUpperCase()}
                            </button>
                        ))}
                    </div>
                </div>

                {/* ── Server Configuration ── */}
                <div className="p-6 bg-white/5 border border-white/10 rounded-2xl">
                    <h2 className="text-xl font-semibold mb-6 flex items-center gap-3 text-blue-400">
                        <SettingsIcon className="w-6 h-6" />
                        {t('sidebar.serverStatus')}
                    </h2>
                    <div>
                        <label className="block text-sm text-neutral-400 mb-2">{t('settings.serverIp')}</label>
                        <div className="flex gap-3">
                            <input
                                type="text"
                                value={printerConfig.serverIp || ''}
                                onChange={(e) => setPrinterConfig({ ...printerConfig, serverIp: e.target.value })}
                                placeholder={t('settings.serverIpPlaceholder')}
                                className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all hover:bg-black/40 font-mono"
                            />
                            <button
                                onClick={handleSync}
                                disabled={isSyncing || !printerConfig.serverIp}
                                className={`px-6 rounded-xl font-medium transition-all flex items-center gap-2 ${isSyncing || !printerConfig.serverIp
                                    ? 'bg-neutral-800 text-neutral-500 cursor-not-allowed'
                                    : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg hover:shadow-blue-500/20'
                                    }`}
                            >
                                <RefreshCw className={`w-5 h-5 ${isSyncing ? 'animate-spin' : ''}`} />
                                {isSyncing ? t('settings.testing') : t('settings.testConnection')}
                            </button>
                        </div>

                        <p className="mt-2 text-xs text-white/30">
                            {t('settings.serverIpPlaceholder')}
                        </p>
                    </div>

                    {/* Offline Sync Controls */}
                    <div className="mt-6 pt-6 border-t border-white/5">
                        <label className="block text-sm text-neutral-400 mb-3">{t('settings.offlineSync') || 'Offline Synchronization'}</label>
                        <div className="flex gap-3 flex-wrap">
                            <button
                                onClick={async () => {
                                    const res = await window.electron.invoke('import-identity-file');
                                    if (res.success) {
                                        showToast(t('settings.identityImported') || 'Identity Imported');
                                    } else {
                                        showToast(res.message);
                                    }
                                }}
                                className="px-5 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-medium shadow-lg hover:shadow-emerald-500/20 flex items-center gap-2 transition-all"
                            >
                                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V8a2 2 0 00-2-2h-5m-4 0V5a2 2 0 114 0v1m-4 0a2 2 0 104 0m-5 8a2 2 0 100-4 2 2 0 000 4zm0 0c1.306 0 2.417.835 2.83 2M9 14a3.001 3.001 0 00-2.83 2M15 11h3m-3 4h2" />
                                </svg>
                                {t('settings.importIdentity') || 'Import Identity (.lpi)'}
                            </button>
                            <button
                                onClick={async () => {
                                    const res = await window.electron.invoke('offline-import');
                                    showToast(res.message);
                                }}
                                className="px-5 py-3 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-medium shadow-lg hover:shadow-purple-500/20 flex items-center gap-2 transition-all"
                            >
                                <RefreshCw className="w-5 h-5" />
                                {t('settings.importUpdate') || 'Import Update (.lps)'}
                            </button>
                            <button
                                onClick={async () => {
                                    const res = await window.electron.invoke('offline-export');
                                    showToast(res.message);
                                }}
                                className="px-5 py-3 rounded-xl bg-orange-600 hover:bg-orange-500 text-white font-medium shadow-lg hover:shadow-orange-500/20 flex items-center gap-2 transition-all"
                            >
                                <Save className="w-5 h-5" />
                                {t('settings.exportData') || 'Export Data (.lpr)'}
                            </button>
                        </div>
                    </div>
                </div>

                {/* ── Printer Configuration ── */}
                <div className="p-6 bg-white/5 border border-white/10 rounded-2xl">
                    <h2 className="text-xl font-semibold mb-6 flex items-center gap-3 text-amber-400">
                        <Printer className="w-6 h-6" />
                        {t('settings.printer')}
                    </h2>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        {/* Pack Label Printer */}
                        <PrinterSettings
                            title={t('settings.packPrinter')}
                            config={printerConfig.packPrinter as any}
                            onChange={(newConfig) => setPrinterConfig({ ...printerConfig, packPrinter: newConfig as any })}
                            systemPrinters={printers}
                            serialPorts={ports}
                        />

                        {/* Box Label Printer */}
                        <PrinterSettings
                            title={t('settings.boxPrinter')}
                            config={printerConfig.boxPrinter as any}
                            onChange={(newConfig) => setPrinterConfig({ ...printerConfig, boxPrinter: newConfig as any })}
                            systemPrinters={printers}
                            serialPorts={ports}
                        />
                    </div>

                    <div className="flex items-center gap-3 mt-6">
                        <button onClick={loadData} className="text-xs text-amber-400 hover:text-amber-300 flex items-center gap-1">
                            <RefreshCw size={12} /> {t('settings.refreshPrinters')}
                        </button>
                    </div>

                    {/* Auto-Print Toggle */}
                    <div className="mt-6 p-4 bg-black/20 rounded-xl border border-white/5">
                        <div className="flex justify-between items-center">
                            <div>
                                <div className="font-medium text-white">{t('settings.autoPrint')}</div>
                                <div className="text-xs text-neutral-500 mt-1">
                                    {t('settings.autoPrintDesc')}
                                </div>
                            </div>
                            <label className="relative inline-flex items-center cursor-pointer">
                                <input
                                    type="checkbox"
                                    className="sr-only peer"
                                    checked={printerConfig.autoPrintOnStable}
                                    onChange={(e) => setPrinterConfig({ ...printerConfig, autoPrintOnStable: e.target.checked })}
                                />
                                <div className="w-11 h-6 bg-neutral-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-amber-600"></div>
                            </label>
                        </div>
                    </div>
                </div>

                {/* ── Scale Configuration ── */}
                <div className="p-6 bg-white/5 border border-white/10 rounded-2xl">
                    <h2 className="text-xl font-semibold mb-6 text-white">{t('settings.scales')}</h2>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                        {/* Left Column: Connection */}
                        <div className="space-y-6">
                            <h3 className="text-lg font-medium text-white/80 border-b border-white/5 pb-2">{t('settings.connectionInterface')}</h3>

                            <div>
                                <label className="block text-sm text-neutral-400 mb-2">{t('settings.connectionType')}</label>
                                <select
                                    value={config.type}
                                    onChange={(e) => {
                                        const newType = e.target.value;
                                        const update: any = { type: newType };
                                        if (newType === 'simulator') {
                                            update.protocolId = 'simulator';
                                        }
                                        setConfig({ ...config, ...update });
                                    }}
                                    className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all hover:bg-black/30"
                                >
                                    <option value="serial">{t('settings.serial')}</option>
                                    <option value="tcp">{t('settings.tcp')}</option>
                                    <option value="simulator">{t('settings.simulator')}</option>
                                </select>
                            </div>

                            {config.type === 'serial' && (
                                <div className="space-y-4">
                                    <div>
                                        <div className="flex justify-between mb-2">
                                            <label className="text-sm text-neutral-400">{t('settings.port')}</label>
                                            <button onClick={loadData} className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1">
                                                <RefreshCw size={12} /> {t('settings.refresh')}
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
                                            {ports.length === 0 && <option value="" disabled>{t('settings.portsNotFound')}</option>}
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block text-sm text-neutral-400 mb-2">{t('settings.baudRate')}</label>
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
                                        <label className="block text-sm text-neutral-400 mb-2">{t('settings.ipAddress')}</label>
                                        <input
                                            type="text"
                                            value={config.host}
                                            onChange={(e) => setConfig({ ...config, host: e.target.value })}
                                            className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-sm text-neutral-400 mb-2">{t('settings.port')}</label>
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
                            <h3 className="text-lg font-medium text-white/80 border-b border-white/5 pb-2">{t('settings.protocolSettings')}</h3>

                            <div>
                                <label className="block text-sm text-neutral-400 mb-2">{t('settings.protocol')}</label>
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
                                    <label className="block text-sm text-neutral-400 mb-2">{t('settings.pollingMs')}</label>
                                    <input
                                        type="number"
                                        value={config.pollingInterval}
                                        onChange={(e) => setConfig({ ...config, pollingInterval: Number(e.target.value) })}
                                        className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm text-neutral-400 mb-2">{t('settings.stabilityCount')}</label>
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
                            {t('settings.save')}
                        </button>
                    </div>
                </div>

                {/* ── Updates ── */}
                <UpdateSettings />

                {/* ── Danger Zone ── */}
                <div className="p-6 bg-red-500/5 border border-red-500/10 rounded-2xl">
                    <h2 className="text-xl font-semibold mb-6 flex items-center gap-3 text-red-400">
                        <div className="p-2 bg-red-500/10 rounded-lg">
                            <RefreshCw className="w-5 h-5" />
                        </div>
                        {t('settings.dangerZone') || 'Danger Zone'}
                    </h2>
                    <div className="flex flex-col gap-4">
                        <p className="text-sm text-neutral-400">
                            {t('settings.resetWarning') || 'Resetting the database will permanently delete all local data, including labels, products, and logs. This action cannot be undone.'}
                        </p>
                        <button
                            onClick={() => window.electron.send('open-logs-folder', {})}
                            className="w-fit px-6 py-3 bg-neutral-800 hover:bg-neutral-700 border border-white/5 hover:border-white/10 text-white font-medium rounded-xl transition-all flex items-center gap-2"
                        >
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                            {t('settings.showLogs') || 'Show Logs'}
                        </button>
                        <button
                            onClick={() => setShowResetModal(true)}
                            className="w-fit px-6 py-3 bg-red-600/10 hover:bg-red-600 border border-red-600/20 hover:border-red-600 text-red-500 hover:text-white font-medium rounded-xl transition-all flex items-center gap-2"
                        >
                            <RefreshCw className="w-5 h-5" />
                            {t('settings.resetDatabase') || 'Reset Database'}
                        </button>
                    </div>
                </div>
            </div>

            {/* ── Confirmation Modal ── */}
            {showResetModal && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                    <div
                        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
                        onClick={() => !isResetting && setShowResetModal(false)}
                    />
                    <div className="relative bg-neutral-900 border border-white/10 rounded-3xl p-8 max-w-md w-full shadow-2xl animate-in fade-in zoom-in duration-200">
                        <div className="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center mb-6 mx-auto">
                            <RefreshCw className="w-8 h-8 text-red-500" />
                        </div>

                        <h3 className="text-2xl font-bold text-center mb-2">
                            {t('settings.resetConfirmTitle') || 'Are you absolutely sure?'}
                        </h3>
                        <p className="text-neutral-400 text-center mb-8">
                            {t('settings.resetConfirmDesc') || 'This will wipe all local data and reset the station identity. You will need to re-import the identity file to use the application.'}
                        </p>

                        <div className="flex gap-4">
                            <button
                                disabled={isResetting}
                                onClick={() => setShowResetModal(false)}
                                className="flex-1 px-6 py-3 bg-neutral-800 hover:bg-neutral-700 text-white font-medium rounded-xl transition-all"
                            >
                                {t('common.cancel') || 'Cancel'}
                            </button>
                            <button
                                disabled={isResetting}
                                onClick={handleReset}
                                className={`flex-1 px-6 py-3 bg-red-600 hover:bg-red-500 text-white font-medium rounded-xl transition-all flex items-center justify-center gap-2 ${isResetting ? 'opacity-50 cursor-not-allowed' : ''}`}
                            >
                                {isResetting ? (
                                    <RefreshCw className="w-5 h-5 animate-spin" />
                                ) : (
                                    t('settings.resetConfirmAction') || 'Reset Everything'
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default Settings;
