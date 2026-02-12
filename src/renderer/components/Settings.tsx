import { useState, useEffect } from 'react';
import { Save, RefreshCw, Settings as SettingsIcon, Printer, Languages } from 'lucide-react';
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
    const [printerConfig, setPrinterConfig] = useState({
        packPrinter: '',
        boxPrinter: '',
        autoPrintOnStable: false,
        serverIp: ''
    });
    const [isSyncing, setIsSyncing] = useState(false);

    const [toastMessage, setToastMessage] = useState<string | null>(null);

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
                </div>

                {/* ── Printer Configuration ── */}
                <div className="p-6 bg-white/5 border border-white/10 rounded-2xl">
                    <h2 className="text-xl font-semibold mb-6 flex items-center gap-3 text-amber-400">
                        <Printer className="w-6 h-6" />
                        {t('settings.printer')}
                    </h2>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        {/* Pack Label Printer */}
                        <div className="bg-black/20 p-5 rounded-xl border border-white/5">
                            <label className="block text-sm text-neutral-400 mb-2">{t('settings.packPrinter')}</label>
                            <select
                                value={printerConfig.packPrinter}
                                onChange={(e) => setPrinterConfig({ ...printerConfig, packPrinter: e.target.value })}
                                className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50 transition-all hover:bg-black/40"
                            >
                                <option value="">{t('settings.systemDefault')}</option>
                                {printers.map(p => (
                                    <option key={p.name} value={p.name}>
                                        {p.displayName || p.name}{p.isDefault ? ` (${t('settings.defaultMark')})` : ''}
                                    </option>
                                ))}
                            </select>
                            <p className="mt-2 text-xs text-white/30">{t('settings.printerHint')}</p>
                        </div>

                        {/* Box Label Printer */}
                        <div className="bg-black/20 p-5 rounded-xl border border-white/5">
                            <label className="block text-sm text-neutral-400 mb-2">{t('settings.boxPrinter')}</label>
                            <select
                                value={printerConfig.boxPrinter}
                                onChange={(e) => setPrinterConfig({ ...printerConfig, boxPrinter: e.target.value })}
                                className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50 transition-all hover:bg-black/40"
                            >
                                <option value="">{t('settings.systemDefault')}</option>
                                {printers.map(p => (
                                    <option key={p.name} value={p.name}>
                                        {p.displayName || p.name}{p.isDefault ? ` (${t('settings.defaultMark')})` : ''}
                                    </option>
                                ))}
                            </select>
                            <p className="mt-2 text-xs text-white/30">{t('settings.printerHint')}</p>
                        </div>
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
                                    onChange={(e) => setConfig({ ...config, type: e.target.value })}
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
            </div>
        </div>
    );
};

export default Settings;
