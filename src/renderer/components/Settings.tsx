import { useState, useEffect, useRef } from 'react';
import { Save, RefreshCw, Settings as SettingsIcon, Printer, Languages, Moon, Sun, Monitor, ShieldCheck, ShieldAlert } from 'lucide-react';
import PrinterSettings from './PrinterSettings';
import UpdateSettings from './UpdateSettings';
import { useTranslation, type Lang } from '../i18n';
import { useTheme } from './ThemeProvider';
import { useLicenseStatus } from '../hooks/useLicenseStatus';

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
    const { theme, setTheme } = useTheme();
    const { license } = useLicenseStatus();
    const [ports, setPorts] = useState<SerialPortInfo[]>([]);
    const [protocols, setProtocols] = useState<ProtocolInfo[]>([]);
    const [config, setConfig] = useState({
        type: 'serial',
        protocolId: 'simulator',
        path: '',
        baudRate: 9600,
        host: '192.168.1.50',
        port: 8000,
        pollingInterval: 250,
        stabilityCount: 4
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
        palletPrinter: {
            id: 'pallet_default',
            active: false,
            name: 'Pallet Printer',
            connection: 'windows_driver',
            protocol: 'image',
            port: 9100,
            baudRate: 9600,
            dpi: 203
        },
        autoPrintOnStable: true,
        serverIp: ''
    });
    const [isSyncing, setIsSyncing] = useState(false);

    const [toastMessage, setToastMessage] = useState<string | null>(null);
    const [showResetModal, setShowResetModal] = useState(false);
    const [isResetting, setIsResetting] = useState(false);
    const [resetConfirmText, setResetConfirmText] = useState('');
    // Station identity (null when the station is UNPROVISIONED). Drives the
    // "Демо режим" button's wipe-confirmation: a provisioned station gets an
    // extra warning before its real data is replaced by the demo dataset.
    const [identity, setIdentity] = useState<any>(null);
    // Snapshot of the last saved scale+printer config; drives the "unsaved changes" sticky bar.
    const savedSnapshotRef = useRef<string>('');

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

            try {
                setIdentity(await window.electron.invoke('get-identity'));
            } catch {
                setIdentity(null);
            }

            setPorts(portsList);
            setProtocols(protocolsList);

            // Merge over the state defaults so EVERY printer role always exists in state,
            // even if the backend response omits one (e.g. an older config without a
            // palletPrinter). Otherwise the pallet block would lose its editable config.
            let nextPrinter = printerConfig;
            if (savedPrinterConfig) {
                nextPrinter = {
                    ...printerConfig,
                    ...savedPrinterConfig,
                    packPrinter: savedPrinterConfig.packPrinter || printerConfig.packPrinter,
                    boxPrinter: savedPrinterConfig.boxPrinter || printerConfig.boxPrinter,
                    palletPrinter: savedPrinterConfig.palletPrinter || printerConfig.palletPrinter,
                };
                setPrinterConfig(nextPrinter);
            }
            if (printersList) setPrinters(printersList);

            let nextConfig = config;
            if (savedConfig) {
                nextConfig = savedConfig;
                setConfig(savedConfig);
            } else if (portsList.length > 0 && !config.path) {
                nextConfig = { ...config, path: portsList[0].path };
                setConfig(nextConfig);
            }
            // Baseline for unsaved-changes detection.
            savedSnapshotRef.current = JSON.stringify({ config: nextConfig, printerConfig: nextPrinter });
        } catch (err) {
            console.error("Failed to load settings data", err);
        }
    };

    const isValidIpStr = (ip: string) => /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split('.').every(o => Number(o) <= 255);

    // Block saving an obviously-broken config (bad printer IP / out-of-range port).
    const validateConfig = (): string | null => {
        for (const role of ['packPrinter', 'boxPrinter', 'palletPrinter'] as const) {
            const p = printerConfig[role];
            if (p && p.connection === 'tcp') {
                if (p.ip && !isValidIpStr(p.ip)) return t('settings.invalidConfig');
                if (p.port != null && (p.port < 1 || p.port > 65535)) return t('settings.invalidConfig');
            }
        }
        return null;
    };

    const handleSave = () => {
        const err = validateConfig();
        if (err) { showToast(err); return; }
        window.electron.send('save-scale-config', config);
        window.electron.send('save-printer-config', printerConfig);
        savedSnapshotRef.current = JSON.stringify({ config, printerConfig });
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
            showToast(`${t('settings.connectionFailed')}: ${error instanceof Error ? error.message : String(error)}`);
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
                // Keep the modal open on failure so the admin sees the reason and can retry.
                showToast(res.message || t('settings.resetFailed'));
                setIsResetting(false);
            }
        } catch (error) {
            console.error('Reset failed:', error);
            showToast(`${t('settings.resetFailed')}: ${error instanceof Error ? error.message : String(error)}`);
            setIsResetting(false);
        }
    };

    const isDirty = savedSnapshotRef.current !== '' && JSON.stringify({ config, printerConfig }) !== savedSnapshotRef.current;

    return (
        <div className="bg-transparent min-h-screen text-neutral-900 dark:text-white p-8 relative pb-28">
            {/* Toast Notification */}
            {toastMessage && (
                <div className="fixed bottom-8 right-8 bg-emerald-600 text-white px-6 py-3 rounded-xl shadow-2xl flex items-center gap-3 animate-bounce z-50">
                    <div className="w-2 h-2 bg-white rounded-full"></div>
                    {toastMessage}
                </div>
            )}

            <h1 className="text-3xl font-bold mb-8 flex items-center gap-3 text-neutral-900 dark:text-white">
                <SettingsIcon className="w-8 h-8 text-emerald-500" />
                {t('settings.title')}
            </h1>

            {/* Sticky unsaved-changes save bar (printer + scale configs) */}
            {isDirty && (
                <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-4 px-6 py-3 rounded-2xl bg-neutral-900 dark:bg-neutral-800 text-white shadow-2xl border border-white/10 animate-in fade-in slide-in-from-bottom-2 duration-200">
                    <span className="flex items-center gap-2 text-sm font-medium">
                        <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></span>
                        {t('settings.unsavedChanges')}
                    </span>
                    <button
                        onClick={handleSave}
                        className="flex items-center gap-2 px-5 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-xl font-semibold text-white transition-all active:scale-95"
                    >
                        <Save size={16} />
                        {t('settings.saveAll')}
                    </button>
                </div>
            )}

            <div className="space-y-8 max-w-7xl">
                {/* ── Theme Configuration ── */}
                <div className="p-6 bg-white dark:bg-white/5 border border-neutral-200 dark:border-white/20 rounded-2xl shadow-sm dark:shadow-none">
                    <h2 className="text-xl font-semibold mb-6 flex items-center gap-3 text-neutral-800 dark:text-emerald-400">
                        <Moon className="w-6 h-6" />
                        {t('settings.theme') || 'Appearance'}
                    </h2>
                    <div className="flex gap-4">
                        <button
                            onClick={() => setTheme('light')}
                            className={`px-6 py-3 rounded-xl border transition-all font-medium flex items-center gap-2 ${theme === 'light'
                                ? 'bg-emerald-600 border-emerald-600 text-white shadow-lg shadow-emerald-500/20'
                                : 'bg-neutral-50 dark:bg-black/20 border-neutral-200 dark:border-white/20 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-white/5'
                                }`}
                        >
                            <Sun size={18} /> Light
                        </button>
                        <button
                            onClick={() => setTheme('dark')}
                            className={`px-6 py-3 rounded-xl border transition-all font-medium flex items-center gap-2 ${theme === 'dark'
                                ? 'bg-emerald-600 border-emerald-600 text-white shadow-lg shadow-emerald-500/20'
                                : 'bg-neutral-50 dark:bg-black/20 border-neutral-200 dark:border-white/20 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-white/5'
                                }`}
                        >
                            <Moon size={18} /> Dark
                        </button>
                        <button
                            onClick={() => setTheme('system')}
                            className={`px-6 py-3 rounded-xl border transition-all font-medium flex items-center gap-2 ${theme === 'system'
                                ? 'bg-emerald-600 border-emerald-600 text-white shadow-lg shadow-emerald-500/20'
                                : 'bg-neutral-50 dark:bg-black/20 border-neutral-200 dark:border-white/20 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-white/5'
                                }`}
                        >
                            <Monitor size={18} /> System
                        </button>
                    </div>
                </div>

                {/* ── Language Configuration ── */}
                <div className="p-6 bg-white dark:bg-white/5 border border-neutral-200 dark:border-white/20 rounded-2xl shadow-sm dark:shadow-none">
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
                                    ? 'bg-emerald-600 border-emerald-600 text-white shadow-lg shadow-emerald-500/20'
                                    : 'bg-neutral-50 dark:bg-black/20 border-neutral-200 dark:border-white/20 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-white/5'
                                    }`}
                            >
                                {({ ru: '🇷🇺 Русский', en: '🇬🇧 English', de: '🇩🇪 Deutsch' } as Record<string, string>)[l] || l.toUpperCase()}
                            </button>
                        ))}
                    </div>
                </div>

                {/* ── Server Configuration ── */}
                <div className="p-6 bg-white dark:bg-white/5 border border-neutral-200 dark:border-white/20 rounded-2xl shadow-sm dark:shadow-none">
                    <h2 className="text-xl font-semibold mb-6 flex items-center gap-3 text-blue-600 dark:text-blue-400">
                        <SettingsIcon className="w-6 h-6" />
                        {t('sidebar.serverStatus')}
                    </h2>
                    <div>
                        <label className="block text-sm text-neutral-600 dark:text-neutral-400 mb-2">{t('settings.serverIp')}</label>
                        <div className="flex gap-3">
                            <input
                                type="text"
                                value={printerConfig.serverIp || ''}
                                onChange={(e) => setPrinterConfig({ ...printerConfig, serverIp: e.target.value })}
                                placeholder={t('settings.serverIpPlaceholder')}
                                className="w-full bg-white dark:bg-black/30 border border-neutral-200 dark:border-white/20 rounded-xl px-4 py-3 text-neutral-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all hover:bg-neutral-50 dark:hover:bg-black/40 font-mono"
                            />
                            <button
                                onClick={handleSync}
                                disabled={isSyncing || !printerConfig.serverIp}
                                className={`px-6 rounded-xl font-medium transition-all flex items-center gap-2 ${isSyncing || !printerConfig.serverIp
                                    ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-400 dark:text-neutral-500 cursor-not-allowed'
                                    : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg hover:shadow-blue-500/20'
                                    }`}
                            >
                                <RefreshCw className={`w-5 h-5 ${isSyncing ? 'animate-spin' : ''}`} />
                                {isSyncing ? t('settings.testing') : t('settings.testConnection')}
                            </button>
                        </div>

                        <p className="mt-2 text-xs text-neutral-500 dark:text-white/30">
                            {t('settings.serverIpPlaceholder')}
                        </p>
                    </div>

                    {/* License / Demo status of the connected server */}
                    <div className="mt-6 pt-6 border-t border-neutral-200 dark:border-white/5">
                        {license ? (
                            license.mode === 'demo' ? (
                                <div className="p-4 rounded-xl border bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/20">
                                    <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300 font-semibold">
                                        <ShieldAlert className="w-5 h-5 shrink-0" />
                                        <span>{t('license.demo')}</span>
                                    </div>
                                    <p className="mt-2 text-sm text-amber-700/80 dark:text-amber-300/80">
                                        {t('license.demoHint')}
                                    </p>
                                    <div className="mt-3 text-sm text-amber-800 dark:text-amber-200">
                                        {t('license.maxStations')}: <span className="font-mono font-semibold">{license.stations_used} / {license.max_stations}</span>
                                    </div>
                                </div>
                            ) : (
                                <div className="p-4 rounded-xl border bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/20">
                                    <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300 font-semibold">
                                        <ShieldCheck className="w-5 h-5 shrink-0" />
                                        <span>{t('license.licensed')}: {license.edition}</span>
                                    </div>
                                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-sm text-neutral-700 dark:text-neutral-300">
                                        {license.customer && (
                                            <div className="flex justify-between gap-2">
                                                <span className="text-neutral-500 dark:text-neutral-400">{t('license.customer')}</span>
                                                <span className="font-medium truncate">{license.customer}</span>
                                            </div>
                                        )}
                                        {license.expires && (
                                            <div className="flex justify-between gap-2">
                                                <span className="text-neutral-500 dark:text-neutral-400">{t('license.expires')}</span>
                                                <span className={`font-mono ${license.expired ? 'text-amber-600 dark:text-amber-400' : ''}`}>
                                                    {license.expires}{license.expired ? ` (${t('license.expired')})` : ''}
                                                </span>
                                            </div>
                                        )}
                                        <div className="flex justify-between gap-2">
                                            <span className="text-neutral-500 dark:text-neutral-400">{t('license.stations')}</span>
                                            <span className="font-mono">{license.stations_used} / {license.max_stations}</span>
                                        </div>
                                    </div>
                                </div>
                            )
                        ) : (
                            <p className="text-sm text-neutral-500 dark:text-neutral-400 flex items-center gap-2">
                                <ShieldCheck className="w-4 h-4 opacity-50" />
                                {t('license.unknown')}
                            </p>
                        )}
                    </div>

                    {/* Offline Sync Controls */}
                    <div className="mt-6 pt-6 border-t border-neutral-200 dark:border-white/5">
                        <label className="block text-sm text-neutral-600 dark:text-neutral-400 mb-3">{t('settings.offlineSync') || 'Offline Synchronization'}</label>
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
                                    // Station is "provisioned" once it has an identity with a
                                    // station number. Seeding the demo routes through
                                    // importFullDump (DELETE + INSERT), so warn extra hard
                                    // before wiping a real provisioned station's data.
                                    const provisioned = !!(identity && identity.station_number != null);
                                    const warning = provisioned
                                        ? `${t('demo.seedWipeProvisioned')}\n\n${t('demo.seedHint')}`
                                        : `${t('demo.seedWipe')}\n\n${t('demo.seedHint')}`;
                                    if (!window.confirm(warning)) return;
                                    const res = await window.electron.invoke('seed-demo-data');
                                    if (res.success) {
                                        // Mirror handleReset: reload so the UI reflects the
                                        // freshly seeded local data.
                                        window.location.reload();
                                    } else {
                                        showToast(res.message || t('demo.seedFailed'));
                                    }
                                }}
                                className="px-5 py-3 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-medium shadow-lg hover:shadow-amber-500/20 flex items-center gap-2 transition-all"
                            >
                                <ShieldAlert className="w-5 h-5" />
                                {t('demo.seedButton') || 'Демо режим'}
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
                <div className="p-6 bg-white dark:bg-white/5 border border-neutral-200 dark:border-white/20 rounded-2xl shadow-sm dark:shadow-none">
                    <h2 className="text-xl font-semibold mb-6 flex items-center gap-3 text-amber-600 dark:text-amber-400">
                        <Printer className="w-6 h-6" />
                        {t('settings.printer')}
                    </h2>

                    <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
                        {/* Pack Label Printer */}
                        <PrinterSettings
                            title={t('settings.packPrinter')}
                            description={t('settings.packPrinterDesc')}
                            accentClass="border-l-emerald-500"
                            config={printerConfig.packPrinter as any}
                            onChange={(newConfig) => setPrinterConfig({ ...printerConfig, packPrinter: newConfig as any })}
                            systemPrinters={printers}
                            serialPorts={ports}
                            onToast={showToast}
                        />

                        {/* Box Label Printer */}
                        <PrinterSettings
                            title={t('settings.boxPrinter')}
                            description={t('settings.boxPrinterDesc')}
                            accentClass="border-l-blue-500"
                            config={printerConfig.boxPrinter as any}
                            onChange={(newConfig) => setPrinterConfig({ ...printerConfig, boxPrinter: newConfig as any })}
                            systemPrinters={printers}
                            serialPorts={ports}
                            onToast={showToast}
                        />

                        {/* Pallet Sheet Printer */}
                        <PrinterSettings
                            title={t('settings.palletPrinter')}
                            description={t('settings.palletPrinterDesc')}
                            accentClass="border-l-amber-500"
                            config={printerConfig.palletPrinter as any}
                            onChange={(newConfig) => setPrinterConfig({ ...printerConfig, palletPrinter: newConfig as any })}
                            systemPrinters={printers}
                            serialPorts={ports}
                            onToast={showToast}
                        />
                    </div>

                    <div className="flex items-center gap-3 mt-6">
                        <button onClick={loadData} className="text-xs text-amber-400 hover:text-amber-300 flex items-center gap-1">
                            <RefreshCw size={12} /> {t('settings.refreshPrinters')}
                        </button>
                    </div>

                    {/* Auto-Print Toggle */}
                    <div className="mt-6 p-4 bg-neutral-50 dark:bg-black/20 rounded-xl border border-neutral-200 dark:border-white/5">
                        <div className="flex justify-between items-center">
                            <div>
                                <div className="font-medium text-neutral-900 dark:text-white">{t('settings.autoPrint')}</div>
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
                <div className="p-6 bg-white dark:bg-white/5 border border-neutral-200 dark:border-white/20 rounded-2xl shadow-sm dark:shadow-none">
                    <h2 className="text-xl font-semibold mb-1 text-neutral-900 dark:text-white">{t('settings.scales')}</h2>
                    <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-6">{t('settings.scalesDesc')}</p>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                        {/* Left Column: Connection */}
                        <div className="space-y-6">
                            <h3 className="text-lg font-medium text-neutral-800 dark:text-white/80 border-b border-neutral-200 dark:border-white/5 pb-2">{t('settings.connectionInterface')}</h3>

                            <div className="flex bg-neutral-100 dark:bg-black/20 p-1.5 rounded-xl border border-neutral-200 dark:border-white/20 w-full mb-2">
                                <button
                                    onClick={() => {
                                        setConfig({ ...config, type: 'serial' });
                                    }}
                                    className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 z-10 ${config.type === 'serial'
                                        ? 'bg-emerald-600 dark:bg-emerald-600 border border-emerald-500 dark:border-emerald-400 text-white shadow-[0_0_15px_rgba(16,185,129,0.4)] scale-105 z-20'
                                        : 'text-neutral-600 dark:text-neutral-400 border border-transparent hover:text-neutral-900 dark:hover:text-white hover:bg-white/50 dark:hover:bg-white/5'
                                        }`}
                                >
                                    {t('settings.serial')}
                                </button>
                                <button
                                    onClick={() => {
                                        setConfig({ ...config, type: 'tcp' });
                                    }}
                                    className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 z-10 ${config.type === 'tcp'
                                        ? 'bg-emerald-600 dark:bg-emerald-600 border border-emerald-500 dark:border-emerald-400 text-white shadow-[0_0_15px_rgba(16,185,129,0.4)] scale-105 z-20'
                                        : 'text-neutral-600 dark:text-neutral-400 border border-transparent hover:text-neutral-900 dark:hover:text-white hover:bg-white/50 dark:hover:bg-white/5'
                                        }`}
                                >
                                    {t('settings.tcp')}
                                </button>
                                <button
                                    onClick={() => {
                                        setConfig({ ...config, type: 'simulator', protocolId: 'simulator' });
                                    }}
                                    className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 z-10 ${config.type === 'simulator'
                                        ? 'bg-emerald-600 dark:bg-emerald-600 border border-emerald-500 dark:border-emerald-400 text-white shadow-[0_0_15px_rgba(16,185,129,0.4)] scale-105 z-20'
                                        : 'text-neutral-600 dark:text-neutral-400 border border-transparent hover:text-neutral-900 dark:hover:text-white hover:bg-white/50 dark:hover:bg-white/5'
                                        }`}
                                >
                                    {t('settings.simulator')}
                                </button>
                            </div>

                            {config.type === 'serial' && (
                                <div className="space-y-4">
                                    <div>
                                        <div className="flex justify-between mb-2">
                                            <label className="text-sm text-neutral-600 dark:text-neutral-400">{t('settings.port')}</label>
                                            <button onClick={loadData} className="text-xs text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 flex items-center gap-1">
                                                <RefreshCw size={12} /> {t('settings.refresh')}
                                            </button>
                                        </div>
                                        <select
                                            value={config.path}
                                            onChange={(e) => setConfig({ ...config, path: e.target.value })}
                                            className="w-full bg-neutral-50 dark:bg-black/20 border border-neutral-200 dark:border-white/20 rounded-xl px-4 py-3 text-neutral-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                                        >
                                            {ports.map(p => (
                                                <option key={p.path} value={p.path}>{p.path} {p.manufacturer ? `(${p.manufacturer})` : ''}</option>
                                            ))}
                                            {ports.length === 0 && <option value="" disabled>{t('settings.portsNotFound')}</option>}
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block text-sm text-neutral-600 dark:text-neutral-400 mb-2">{t('settings.baudRate')}</label>
                                        <select
                                            value={config.baudRate}
                                            onChange={(e) => setConfig({ ...config, baudRate: Number(e.target.value) })}
                                            className="w-full bg-neutral-50 dark:bg-black/20 border border-neutral-200 dark:border-white/20 rounded-xl px-4 py-3 text-neutral-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
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
                                        <label className="block text-sm text-neutral-600 dark:text-neutral-400 mb-2">{t('settings.ipAddress')}</label>
                                        <input
                                            type="text"
                                            value={config.host}
                                            onChange={(e) => setConfig({ ...config, host: e.target.value })}
                                            className="w-full bg-neutral-50 dark:bg-black/20 border border-neutral-200 dark:border-white/20 rounded-xl px-4 py-3 text-neutral-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-sm text-neutral-600 dark:text-neutral-400 mb-2">{t('settings.port')}</label>
                                        <input
                                            type="number"
                                            value={config.port}
                                            onChange={(e) => setConfig({ ...config, port: Number(e.target.value) })}
                                            className="w-full bg-neutral-50 dark:bg-black/20 border border-neutral-200 dark:border-white/20 rounded-xl px-4 py-3 text-neutral-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                                        />
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Right Column: Protocol & Advanced */}
                        <div className="space-y-6">
                            <h3 className="text-lg font-medium text-neutral-800 dark:text-white/80 border-b border-neutral-200 dark:border-white/5 pb-2">{t('settings.protocolSettings')}</h3>

                            <div>
                                <label className="block text-sm text-neutral-600 dark:text-neutral-400 mb-2">{t('settings.protocol')}</label>
                                <select
                                    value={config.protocolId}
                                    onChange={(e) => setConfig({ ...config, protocolId: e.target.value })}
                                    className="w-full bg-neutral-50 dark:bg-black/20 border border-neutral-200 dark:border-white/20 rounded-xl px-4 py-3 text-neutral-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                                    disabled={config.type === 'simulator'}
                                >
                                    {protocols.map(p => (
                                        <option key={p.id} value={p.id}>{p.name}</option>
                                    ))}
                                </select>
                                <p className="mt-2 text-xs text-neutral-500 dark:text-white/60">
                                    {protocols.find(p => p.id === config.protocolId)?.description}
                                </p>
                            </div>

                            <div>
                                <label className="block text-sm text-neutral-600 dark:text-neutral-400 mb-2">{t('settings.stabilityPreset')}</label>
                                <div className="grid grid-cols-3 gap-2">
                                    {([
                                        { id: 'fast',     label: t('settings.presetFast'),     poll: 150, count: 3, hint: '~450ms' },
                                        { id: 'balanced', label: t('settings.presetBalanced'), poll: 250, count: 4, hint: '~1s' },
                                        { id: 'accurate', label: t('settings.presetAccurate'), poll: 500, count: 5, hint: '~2.5s' },
                                    ] as const).map(p => {
                                        const active = config.pollingInterval === p.poll && config.stabilityCount === p.count;
                                        return (
                                            <button
                                                key={p.id}
                                                type="button"
                                                onClick={() => setConfig({ ...config, pollingInterval: p.poll, stabilityCount: p.count })}
                                                className={`px-3 py-3 rounded-xl border text-sm transition-all ${
                                                    active
                                                        ? 'border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                                                        : 'border-neutral-200 dark:border-white/20 bg-neutral-50 dark:bg-black/20 text-neutral-700 dark:text-neutral-300 hover:border-emerald-400/50'
                                                }`}
                                            >
                                                <div className="font-semibold">{p.label}</div>
                                                <div className="text-xs opacity-60 mt-0.5">{p.hint}</div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm text-neutral-600 dark:text-neutral-400 mb-2">{t('settings.pollingMs')}</label>
                                    <input
                                        type="number"
                                        value={config.pollingInterval}
                                        onChange={(e) => setConfig({ ...config, pollingInterval: Number(e.target.value) })}
                                        className="w-full bg-neutral-50 dark:bg-black/20 border border-neutral-200 dark:border-white/20 rounded-xl px-4 py-3 text-neutral-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm text-neutral-600 dark:text-neutral-400 mb-2">{t('settings.stabilityCount')}</label>
                                    <input
                                        type="number"
                                        value={config.stabilityCount}
                                        onChange={(e) => setConfig({ ...config, stabilityCount: Number(e.target.value) })}
                                        className="w-full bg-neutral-50 dark:bg-black/20 border border-neutral-200 dark:border-white/20 rounded-xl px-4 py-3 text-neutral-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>

                </div>

                {/* ── Updates ── */}
                <UpdateSettings />

                {/* ── Danger Zone ── */}
                <div className="p-6 bg-red-50 dark:bg-red-500/5 border border-red-200 dark:border-red-500/10 rounded-2xl">
                    <h2 className="text-xl font-semibold mb-6 flex items-center gap-3 text-red-600 dark:text-red-400">
                        <div className="p-2 bg-red-100 dark:bg-red-500/10 rounded-lg">
                            <RefreshCw className="w-5 h-5" />
                        </div>
                        {t('settings.dangerZone') || 'Danger Zone'}
                    </h2>
                    <div className="flex flex-col gap-4">
                        <p className="text-sm text-neutral-600 dark:text-neutral-400">
                            {t('settings.resetWarning') || 'Resetting the database will permanently delete all local data, including labels, products, and logs. This action cannot be undone.'}
                        </p>
                        <button
                            onClick={() => window.electron.send('open-logs-folder', {})}
                            className="w-fit px-6 py-3 bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 border border-neutral-300 dark:border-white/5 hover:border-neutral-400 dark:hover:border-white/10 text-neutral-900 dark:text-white font-medium rounded-xl transition-all flex items-center gap-2"
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
                        className="absolute inset-0 bg-neutral-900/40 dark:bg-black/80 backdrop-blur-sm"
                        onClick={() => { if (!isResetting) { setShowResetModal(false); setResetConfirmText(''); } }}
                    />
                    <div className="relative bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-white/20 rounded-3xl p-8 max-w-md w-full shadow-2xl animate-in fade-in zoom-in duration-200">
                        <div className="w-16 h-16 bg-red-100 dark:bg-red-500/10 rounded-full flex items-center justify-center mb-6 mx-auto">
                            <RefreshCw className="w-8 h-8 text-red-600 dark:text-red-500" />
                        </div>

                        <h3 className="text-2xl font-bold text-center mb-2 text-neutral-900 dark:text-white">
                            {t('settings.resetConfirmTitle') || 'Are you absolutely sure?'}
                        </h3>
                        <p className="text-neutral-600 dark:text-neutral-400 text-center mb-4">
                            {t('settings.resetConfirmDesc') || 'This will wipe all local data and reset the station identity. You will need to re-import the identity file to use the application.'}
                        </p>

                        {/* Type-to-confirm guard — prevents accidental touchscreen reset */}
                        <input
                            type="text"
                            value={resetConfirmText}
                            onChange={(e) => setResetConfirmText(e.target.value)}
                            placeholder="RESET"
                            autoFocus
                            className="w-full text-center font-mono tracking-widest uppercase bg-neutral-50 dark:bg-black/30 border border-neutral-300 dark:border-white/20 rounded-xl px-4 py-3 text-neutral-900 dark:text-white mb-2 focus:outline-none focus:ring-2 focus:ring-red-500/50"
                        />
                        <p className="text-xs text-center text-neutral-500 dark:text-neutral-400 mb-6">{t('settings.resetTypeHint')}</p>

                        <div className="flex gap-4">
                            <button
                                disabled={isResetting}
                                onClick={() => { setShowResetModal(false); setResetConfirmText(''); }}
                                className="flex-1 px-6 py-3 bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-900 dark:text-white font-medium rounded-xl transition-all"
                            >
                                {t('common.cancel') || 'Cancel'}
                            </button>
                            <button
                                disabled={isResetting || resetConfirmText.trim().toUpperCase() !== 'RESET'}
                                onClick={handleReset}
                                className="flex-1 px-6 py-3 bg-red-600 hover:bg-red-500 text-white font-medium rounded-xl transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-red-600"
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
