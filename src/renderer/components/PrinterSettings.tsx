import { useState } from 'react';
import { useTranslation } from '../i18n';
import { Printer, Network, Usb, Monitor, RefreshCw, Activity, Search, ChevronDown } from 'lucide-react';
import {
    resolvePrinterProfile,
    type PrinterCompatibilityMode,
    type PrinterProfileId,
} from '../../shared/printerProfiles';

// Replicating types from main/config.ts since we can't import directly from main in renderer easily without shared types
export type ConnectionType = 'tcp' | 'serial' | 'windows_driver';
export type PrinterProtocol = 'zpl' | 'tspl' | 'epl' | 'cpcl' | 'dpl' | 'sbpl' | 'image' | 'browser';

type DeviceOperationalStatus = 'ready' | 'printing' | 'paused' | 'head_open' | 'paper_out' | 'ribbon_out' | 'paper_jam' | 'error' | 'unknown';

interface PrinterCapabilityReport {
    detected: boolean;
    cached: boolean;
    source: 'probe' | 'unavailable';
    confidence: 'high' | 'medium' | 'low' | 'none';
    protocol?: 'zpl' | 'tspl' | 'epl' | 'cpcl' | 'dpl' | 'sbpl';
    manufacturer?: string;
    model?: string;
    firmware?: string;
    dpi?: 203 | 300 | 600;
    dotsPerMm?: number;
    status: DeviceOperationalStatus;
    statusDetails: string[];
    supportsBidirectionalStatus: boolean;
    recommendedProfileId?: PrinterProfileId;
    endpointKey?: string;
    evidence: string[];
    detectedAt: number;
    expiresAt: number;
}

export interface PrinterDeviceConfig {
    id: string;
    active: boolean;
    name: string;
    connection: ConnectionType;
    protocol: PrinterProtocol;
    compatibilityMode?: PrinterCompatibilityMode;
    detectedProfileId?: PrinterProfileId;
    detectedEndpointKey?: string;
    detectedProfileAt?: number;
    ip?: string;
    port?: number;
    serialPort?: string;
    baudRate?: number;
    driverName?: string;

    // UI only
    darkness?: number; // 0-30
    printSpeed?: number; // 2-12
    gapMm?: number; // TSPL die-cut label gap; 0 = continuous stock
    dpi?: number; // 203 | 300 | 600
    ramCache?: 'auto' | 'on' | 'off'; // image protocol: printer RAM-drive background caching
    z64?: boolean;                    // image protocol: Z64 (zlib) graphic encoding vs hex RLE
    persistentConnection?: boolean;   // tcp: keep the socket open between labels
}

interface PrinterSettingsProps {
    title: string;
    config: PrinterDeviceConfig;
    onChange: (config: PrinterDeviceConfig) => void;
    systemPrinters: Array<{ name: string; displayName: string }>;
    serialPorts: Array<{ path: string; manufacturer?: string }>;
    onToast?: (msg: string) => void;
    accentClass?: string;   // Tailwind left-border color, e.g. 'border-l-emerald-500'
    description?: string;    // one-line role hint shown under the title
    expanded: boolean;
    onToggle: () => void;
}

const isValidIp = (ip: string) => /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split('.').every(o => Number(o) <= 255);

const PrinterSettings = ({
    title,
    config,
    onChange,
    systemPrinters,
    serialPorts,
    onToast,
    accentClass,
    description,
    expanded,
    onToggle,
}: PrinterSettingsProps) => {
    const { t } = useTranslation();
    const [isTesting, setIsTesting] = useState(false);
    const [isDetecting, setIsDetecting] = useState(false);
    const [capabilities, setCapabilities] = useState<PrinterCapabilityReport | null>(null);

    const update = (field: keyof PrinterDeviceConfig, value: PrinterDeviceConfig[keyof PrinterDeviceConfig]) => {
        console.log(`[PrinterSettings] Updating ${field}:`, value);
        if (window.desktopBridge) {
            window.desktopBridge.send('log-to-main', { message: `[PrinterSettings] Updating ${field}`, data: value });
        }
        const next = { ...config, [field]: value } as PrinterDeviceConfig;
        if (['connection', 'protocol', 'ip', 'port', 'serialPort', 'baudRate', 'driverName'].includes(field)) {
            setCapabilities(null);
            delete next.detectedProfileId;
            delete next.detectedEndpointKey;
            delete next.detectedProfileAt;
        }
        onChange(next);
    };

    const effectiveProfile = resolvePrinterProfile(config);
    const connectionLabel = config.connection === 'tcp'
        ? 'Ethernet'
        : config.connection === 'serial'
            ? 'Serial'
            : 'Windows';
    const endpointLabel = config.connection === 'tcp'
        ? `${config.ip || '?'}:${config.port || 9100}`
        : config.connection === 'serial'
            ? `${config.serialPort || '?'} ? ${config.baudRate || 9600}`
            : (config.driverName || t('settings.systemDefault'));
    const protocolLabel = config.protocol === 'image'
        ? 'ZPL bitmap'
        : config.protocol.toUpperCase();

    const capabilityStatusText = (status: DeviceOperationalStatus): string => {
        const key: Record<DeviceOperationalStatus, string> = {
            ready: 'settings.capabilityStatusReady',
            printing: 'settings.capabilityStatusPrinting',
            paused: 'settings.capabilityStatusPaused',
            head_open: 'settings.capabilityStatusHeadOpen',
            paper_out: 'settings.capabilityStatusPaperOut',
            ribbon_out: 'settings.capabilityStatusRibbonOut',
            paper_jam: 'settings.capabilityStatusPaperJam',
            error: 'settings.capabilityStatusError',
            unknown: 'settings.capabilityStatusUnknown',
        };
        return t(key[status]);
    };

    const handleDetectCapabilities = async () => {
        setIsDetecting(true);
        try {
            const report = await window.desktopBridge.invoke('detect-printer-capabilities', config) as PrinterCapabilityReport;
            setCapabilities(report);
            if (!report.detected || !report.protocol) {
                onToast?.(t('settings.capabilityFailed'));
                return;
            }

            // A bitmap-ZPL selection is already a valid ZPL choice; keep it so detection
            // does not silently trade layout fidelity for printer-native text. TSPL needs
            // its dedicated generator. All controls stay editable as a manual override.
            const detectedProtocol: PrinterProtocol = report.protocol === 'zpl'
                ? (config.protocol === 'image' ? 'image' : 'zpl')
                : report.protocol;
            onChange({
                ...config,
                protocol: detectedProtocol,
                ...(report.dpi ? { dpi: report.dpi } : {}),
                ...(report.recommendedProfileId && report.endpointKey ? {
                    detectedProfileId: report.recommendedProfileId,
                    detectedEndpointKey: report.endpointKey,
                    detectedProfileAt: report.detectedAt,
                } : {}),
            });

            const parts = [
                report.protocol.toUpperCase(),
                report.model,
                report.dpi ? `${report.dpi} DPI` : undefined,
                capabilityStatusText(report.status),
            ].filter(Boolean);
            onToast?.(`${t('settings.capabilityDetected')}: ${parts.join(' ? ')}`);
        } catch (error) {
            console.error('[PrinterSettings] Capability detection failed', error);
            onToast?.(`${t('settings.capabilityFailed')}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setIsDetecting(false);
        }
    };

    const handleTestPrint = async () => {
        console.log('[PrinterSettings] Starting Test Print', config);
        if (window.desktopBridge) {
            window.desktopBridge.send('log-to-main', { message: '[PrinterSettings] Starting Test Print', data: config });
        }
        setIsTesting(true);
        try {
            const res = await window.desktopBridge.invoke('test-print', config);
            if (res && res.success) {
                console.log('[PrinterSettings] Test print success');
                if (window.desktopBridge) window.desktopBridge.send('log-to-main', { message: '[PrinterSettings] Test print success' });
                onToast?.(t('settings.testPrintSuccess'));
            } else {
                console.error('[PrinterSettings] Test print failed', res);
                if (window.desktopBridge) window.desktopBridge.send('log-to-main', { message: '[PrinterSettings] Test print failed', data: res });
                onToast?.(t('settings.testPrintFailed') + (res?.message ? ': ' + res.message : ''));
            }
        } catch (e) {
            console.error('[PrinterSettings] Test print error', e);
            if (window.desktopBridge) window.desktopBridge.send('log-to-main', { message: '[PrinterSettings] Test print error', data: e });
            onToast?.(t('settings.testPrintFailed') + ': ' + (e instanceof Error ? e.message : String(e)));
        } finally {
            setIsTesting(false);
        }
    };

    return (
        <section className={`overflow-hidden bg-neutral-50 dark:bg-black/20 rounded-xl border border-l-4 border-neutral-200 dark:border-neutral-600 ${accentClass || 'border-l-amber-500'}`}>
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={expanded}
                aria-controls={`printer-settings-${config.id}`}
                className="w-full min-h-[76px] px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3 text-left hover:bg-neutral-100/80 dark:hover:bg-white/5 active:bg-neutral-200/70 dark:active:bg-white/10 transition-colors touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500"
            >
                <span className="flex min-w-0 items-center gap-3 sm:w-[240px] lg:w-[280px] shrink-0">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white dark:bg-white/5 border border-neutral-200 dark:border-neutral-600">
                        <Printer size={21} className="text-amber-600 dark:text-amber-400" />
                    </span>
                    <span className="min-w-0">
                        <span className="block text-base sm:text-lg font-semibold text-neutral-800 dark:text-white truncate">{title}</span>
                        {description && <span className="block text-xs text-neutral-500 dark:text-neutral-400 truncate">{description}</span>}
                    </span>
                </span>

                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-xs">
                    <span className="min-h-8 inline-flex max-w-full items-center rounded-lg bg-white dark:bg-white/5 border border-neutral-200 dark:border-neutral-600 px-3 font-medium text-neutral-700 dark:text-neutral-200">
                        {connectionLabel} · <span className="ml-1 truncate font-mono text-[11px]">{endpointLabel}</span>
                    </span>
                    <span className="min-h-8 inline-flex items-center rounded-lg bg-sky-50 dark:bg-sky-500/10 border border-sky-200 dark:border-sky-500/20 px-3 font-semibold text-sky-700 dark:text-sky-300">
                        {protocolLabel}
                    </span>
                    <span className="min-h-8 inline-flex items-center rounded-lg bg-white dark:bg-white/5 border border-neutral-200 dark:border-neutral-600 px-3 font-medium text-neutral-600 dark:text-neutral-300">
                        {config.dpi || 203} DPI
                    </span>
                    {config.protocol !== 'browser' && (
                        <span className="min-h-8 inline-flex items-center rounded-lg bg-white dark:bg-white/5 border border-neutral-200 dark:border-neutral-600 px-3 font-mono text-[11px] text-neutral-600 dark:text-neutral-300">
                            {effectiveProfile.id}
                        </span>
                    )}
                </span>

                <span className="min-h-11 min-w-[126px] shrink-0 self-stretch sm:self-auto inline-flex items-center justify-center gap-2 rounded-xl bg-neutral-900 dark:bg-white/10 px-4 text-sm font-semibold text-white">
                    {expanded ? t('settings.hidePrinterSettings') : t('settings.showPrinterSettings')}
                    <ChevronDown size={20} className={`transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />
                </span>
            </button>

            {expanded && (
                <div id={`printer-settings-${config.id}`} className="border-t border-neutral-200 dark:border-neutral-600 p-4 sm:p-5 animate-in fade-in duration-150">
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                        <section
                            data-printer-section="connection"
                            className="rounded-xl border border-neutral-200 dark:border-neutral-600 bg-white/80 dark:bg-white/[0.03] p-4"
                        >
                            <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-neutral-800 dark:text-neutral-100">
                                <Network size={18} className="text-emerald-600 dark:text-emerald-400" />
                                {t('settings.printerSectionConnection')}
                            </h3>

                            <div>
                                <label className="block text-sm text-neutral-600 dark:text-neutral-400 mb-2">{t('settings.printerType')}</label>
                                <div className="grid grid-cols-3 gap-2">
                                    {[
                                        { id: 'windows_driver', icon: Monitor, label: 'Driver' },
                                        { id: 'tcp', icon: Network, label: 'Ethernet' },
                                        { id: 'serial', icon: Usb, label: 'Serial' }
                                    ].map((type) => (
                                        <button
                                            type="button"
                                            key={type.id}
                                            onClick={() => update('connection', type.id)}
                                            className={`min-h-14 flex flex-col items-center justify-center p-3 rounded-xl border transition-colors duration-150 ${config.connection === type.id
                                                ? 'bg-emerald-50 dark:bg-emerald-500/15 border-emerald-400 dark:border-emerald-500/50 text-emerald-800 dark:text-emerald-200 ring-1 ring-emerald-200/70 dark:ring-emerald-500/20'
                                                : 'bg-neutral-50 dark:bg-neutral-700/70 border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700'
                                                }`}
                                        >
                                            <type.icon size={20} className="mb-1" />
                                            <span className="text-xs font-medium">{type.label}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="mt-4 border-t border-neutral-200 dark:border-neutral-700 pt-4">
                                {config.connection === 'windows_driver' && (
                                    <div>
                                        <label className="block text-sm text-neutral-600 dark:text-neutral-400 mb-2">{t('settings.driverName')}</label>
                                        <select
                                            value={config.driverName || ''}
                                            onChange={(e) => update('driverName', e.target.value)}
                                            className="min-h-12 w-full bg-white dark:bg-black/30 border border-neutral-200 dark:border-neutral-600 rounded-xl px-4 py-3 text-neutral-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                                        >
                                            <option value="">{t('settings.systemDefault')}</option>
                                            {systemPrinters.map(p => (
                                                <option key={p.name} value={p.name}>{p.displayName || p.name}</option>
                                            ))}
                                        </select>
                                    </div>
                                )}

                                {config.connection === 'tcp' && (
                                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                        <div className="sm:col-span-2">
                                            <label className="block text-sm text-neutral-600 dark:text-neutral-400 mb-2">{t('settings.ipAddress')}</label>
                                            <input
                                                type="text"
                                                value={config.ip || '192.168.1.100'}
                                                onChange={(e) => update('ip', e.target.value)}
                                                className={`min-h-12 w-full bg-white dark:bg-black/30 border rounded-xl px-4 py-3 text-neutral-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50 ${config.ip && !isValidIp(config.ip) ? 'border-red-400 dark:border-red-500/60' : 'border-neutral-200 dark:border-neutral-600'}`}
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-sm text-neutral-600 dark:text-neutral-400 mb-2">{t('settings.port')}</label>
                                            <input
                                                type="number"
                                                min={1}
                                                max={65535}
                                                value={config.port || 9100}
                                                onChange={(e) => update('port', Number(e.target.value))}
                                                className="min-h-12 w-full bg-white dark:bg-black/30 border border-neutral-200 dark:border-neutral-600 rounded-xl px-4 py-3 text-neutral-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                                            />
                                        </div>
                                        <div className="sm:col-span-3">
                                            <label className="block text-sm text-neutral-600 dark:text-neutral-400 mb-2">{t('settings.tcpConnModeLabel')}</label>
                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                                {([
                                                    { id: false, label: t('settings.tcpConnModeClose') },
                                                    { id: true, label: t('settings.tcpConnModeKeep') },
                                                ] as const).map((mode) => (
                                                    <button
                                                        type="button"
                                                        key={String(mode.id)}
                                                        onClick={() => update('persistentConnection', mode.id)}
                                                        className={`min-h-12 p-3 rounded-xl border transition-colors duration-150 ${!!config.persistentConnection === mode.id
                                                            ? 'bg-emerald-50 dark:bg-emerald-500/15 border-emerald-400 dark:border-emerald-500/50 text-emerald-800 dark:text-emerald-200 ring-1 ring-emerald-200/70 dark:ring-emerald-500/20'
                                                            : 'bg-neutral-50 dark:bg-neutral-700/70 border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700'
                                                            }`}
                                                    >
                                                        <span className="text-xs font-semibold text-center">{mode.label}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {config.connection === 'serial' && (
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                        <div>
                                            <label className="block text-sm text-neutral-600 dark:text-neutral-400 mb-2">{t('settings.port')}</label>
                                            <select
                                                value={config.serialPort || ''}
                                                onChange={(e) => update('serialPort', e.target.value)}
                                                className="min-h-12 w-full bg-white dark:bg-black/30 border border-neutral-200 dark:border-neutral-600 rounded-xl px-4 py-3 text-neutral-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                                            >
                                                <option value="">{t('settings.selectPort')}</option>
                                                {serialPorts.map(p => (
                                                    <option key={p.path} value={p.path}>{p.path}</option>
                                                ))}
                                            </select>
                                        </div>
                                        <div>
                                            <label className="block text-sm text-neutral-600 dark:text-neutral-400 mb-2">{t('settings.baudRate')}</label>
                                            <select
                                                value={config.baudRate || 9600}
                                                onChange={(e) => update('baudRate', Number(e.target.value))}
                                                className="min-h-12 w-full bg-white dark:bg-black/30 border border-neutral-200 dark:border-neutral-600 rounded-xl px-4 py-3 text-neutral-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                                            >
                                                {[9600, 19200, 38400, 57600, 115200].map(rate => (
                                                    <option key={rate} value={rate}>{rate}</option>
                                                ))}
                                            </select>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </section>

                        <section
                            data-printer-section="language"
                            className="rounded-xl border border-neutral-200 dark:border-neutral-600 bg-white/80 dark:bg-white/[0.03] p-4"
                        >
                            <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-neutral-800 dark:text-neutral-100">
                                <Activity size={18} className="text-sky-600 dark:text-sky-400" />
                                {t('settings.printerSectionLanguage')}
                            </h3>

                            <div>
                                <label className="block text-sm text-neutral-600 dark:text-neutral-400 mb-2">{t('settings.protocolLabel')}</label>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                    {[
                                        { id: 'zpl', icon: Activity, label: t('settings.protocolZplClassic'), desc: t('settings.protocolZplClassicDesc') },
                                        { id: 'tspl', icon: Activity, label: t('settings.protocolTspl'), desc: t('settings.protocolTsplDesc') },
                                        { id: 'epl', icon: Activity, label: 'EPL', desc: 'Eltron/Zebra и совместимые' },
                                        { id: 'cpcl', icon: Activity, label: 'CPCL', desc: 'Мобильные и компактные принтеры' },
                                        { id: 'dpl', icon: Activity, label: 'DPL', desc: 'Datamax/Honeywell и совместимые' },
                                        { id: 'sbpl', icon: Activity, label: 'SBPL', desc: 'SATO и совместимые' },
                                        { id: 'image', icon: Activity, label: t('settings.protocolZplAccurate'), desc: t('settings.protocolZplAccurateDesc') },
                                        { id: 'browser', icon: Monitor, label: t('settings.protocolWindows'), desc: t('settings.protocolWindowsDesc') }
                                    ].map((protocol) => (
                                        <button
                                            type="button"
                                            key={protocol.id}
                                            onClick={() => update('protocol', protocol.id)}
                                            className={`min-h-14 flex items-center gap-2.5 px-3 py-2.5 rounded-xl border transition-colors duration-150 text-left ${config.protocol === protocol.id
                                                ? 'bg-emerald-50 dark:bg-emerald-500/15 border-emerald-400 dark:border-emerald-500/50 text-emerald-800 dark:text-emerald-200 ring-1 ring-emerald-200/70 dark:ring-emerald-500/20'
                                                : 'bg-neutral-50 dark:bg-neutral-700/70 border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700'
                                                }`}
                                        >
                                            <protocol.icon size={18} className="shrink-0" />
                                            <span className="min-w-0 flex-1">
                                                <span className="block font-semibold text-xs leading-tight">{protocol.label}</span>
                                                <span className="block text-[10px] opacity-60 leading-tight mt-0.5">{protocol.desc}</span>
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {config.protocol !== 'browser' && (
                                <div className="mt-4 border-t border-neutral-200 dark:border-neutral-700 pt-4">
                                    <label className="block text-sm text-neutral-600 dark:text-neutral-400 mb-2">{t('settings.compatibilityModeLabel')}</label>
                                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                        {([
                                            { id: 'auto', label: t('settings.compatibilityAuto') },
                                            { id: 'compatible', label: t('settings.compatibilityCompatible') },
                                            { id: 'advanced', label: t('settings.compatibilityAdvanced') },
                                        ] as const).map((mode) => (
                                            <button
                                                type="button"
                                                key={mode.id}
                                                onClick={() => update('compatibilityMode', mode.id)}
                                                className={`min-h-12 p-3 rounded-xl border transition-colors duration-150 ${(config.compatibilityMode || 'auto') === mode.id
                                                    ? 'bg-emerald-50 dark:bg-emerald-500/15 border-emerald-400 dark:border-emerald-500/50 text-emerald-800 dark:text-emerald-200 ring-1 ring-emerald-200/70 dark:ring-emerald-500/20'
                                                    : 'bg-neutral-50 dark:bg-neutral-700/70 border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700'
                                                    }`}
                                            >
                                                <span className="text-xs font-semibold text-center">{mode.label}</span>
                                            </button>
                                        ))}
                                    </div>
                                    <div className="mt-2 text-[11px] text-neutral-500 dark:text-neutral-400">
                                        {t('settings.compatibilityEffective')}: <span className="font-mono">{effectiveProfile.id}</span>
                                    </div>
                                </div>
                            )}
                        </section>
                    </div>

                    <section
                        data-printer-section="parameters"
                        className="mt-4 rounded-xl border border-neutral-200 dark:border-neutral-600 bg-white/80 dark:bg-white/[0.03] p-4"
                    >
                        <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-neutral-800 dark:text-neutral-100">
                            <Printer size={18} className="text-amber-600 dark:text-amber-400" />
                            {t('settings.printerSectionParameters')}
                        </h3>

                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                            <div>
                                <label className="block text-sm text-neutral-600 dark:text-neutral-400 mb-2">{t('settings.dpiLabel')}</label>
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                    {[
                                        { id: 203, label: t('settings.dpi203') },
                                        { id: 300, label: t('settings.dpi300') },
                                        { id: 600, label: t('settings.dpi600') }
                                    ].map((dpi) => (
                                        <button
                                            type="button"
                                            key={dpi.id}
                                            onClick={() => update('dpi', dpi.id)}
                                            className={`min-h-12 p-3 rounded-xl border transition-colors duration-150 ${(config.dpi === dpi.id) || (!config.dpi && dpi.id === 203)
                                                ? 'bg-emerald-50 dark:bg-emerald-500/15 border-emerald-400 dark:border-emerald-500/50 text-emerald-800 dark:text-emerald-200 ring-1 ring-emerald-200/70 dark:ring-emerald-500/20'
                                                : 'bg-neutral-50 dark:bg-neutral-700/70 border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700'
                                                }`}
                                        >
                                            <span className="text-xs font-semibold text-center">{dpi.label}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {config.protocol === 'tspl' && (
                                <div>
                                    <label className="block text-sm text-neutral-600 dark:text-neutral-400 mb-2">{t('settings.mediaGap')}</label>
                                    <input
                                        type="number"
                                        min={0}
                                        max={20}
                                        step={0.1}
                                        value={config.gapMm ?? 2}
                                        onChange={(e) => update('gapMm', Number(e.target.value))}
                                        className="min-h-12 w-full bg-white dark:bg-black/30 border border-neutral-200 dark:border-neutral-600 rounded-xl px-4 py-3 text-neutral-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                                    />
                                </div>
                            )}
                        </div>

                        {config.protocol === 'image' && (
                            <div className="mt-4 border-t border-neutral-200 dark:border-neutral-700 pt-4">
                                <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                                    {t('settings.printerSectionGraphics')}
                                </h4>
                                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-sm text-neutral-600 dark:text-neutral-400 mb-2">{t('settings.ramCacheLabel')}</label>
                                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                            {([
                                                { id: 'auto', label: t('settings.ramCacheAuto') },
                                                { id: 'on', label: t('settings.ramCacheOn') },
                                                { id: 'off', label: t('settings.ramCacheOff') },
                                            ] as const).map((mode) => (
                                                <button
                                                    type="button"
                                                    key={mode.id}
                                                    onClick={() => update('ramCache', mode.id)}
                                                    className={`min-h-12 p-3 rounded-xl border transition-colors duration-150 ${(config.ramCache === mode.id) || (!config.ramCache && mode.id === 'auto')
                                                        ? 'bg-emerald-50 dark:bg-emerald-500/15 border-emerald-400 dark:border-emerald-500/50 text-emerald-800 dark:text-emerald-200 ring-1 ring-emerald-200/70 dark:ring-emerald-500/20'
                                                        : 'bg-neutral-50 dark:bg-neutral-700/70 border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700'
                                                        }`}
                                                >
                                                    <span className="text-xs font-semibold text-center">{mode.label}</span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    <div>
                                        <label className="block text-sm text-neutral-600 dark:text-neutral-400 mb-2">{t('settings.gfEncodingLabel')}</label>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                            {([
                                                { id: false, label: t('settings.gfEncodingRle') },
                                                { id: true, label: t('settings.gfEncodingZ64') },
                                            ] as const).map((encoding) => (
                                                <button
                                                    type="button"
                                                    key={String(encoding.id)}
                                                    onClick={() => update('z64', encoding.id)}
                                                    className={`min-h-12 p-3 rounded-xl border transition-colors duration-150 ${!!config.z64 === encoding.id
                                                        ? 'bg-emerald-50 dark:bg-emerald-500/15 border-emerald-400 dark:border-emerald-500/50 text-emerald-800 dark:text-emerald-200 ring-1 ring-emerald-200/70 dark:ring-emerald-500/20'
                                                        : 'bg-neutral-50 dark:bg-neutral-700/70 border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700'
                                                        }`}
                                                >
                                                    <span className="text-xs font-semibold text-center">{encoding.label}</span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}
                    </section>

                    {capabilities && (
                        <div className={`mt-4 rounded-xl border px-3 py-2.5 text-xs ${capabilities.detected
                            ? 'border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-800 dark:text-emerald-300'
                            : 'border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-300'}`}>
                            {capabilities.detected ? (
                                <>
                                    <div className="font-semibold flex flex-wrap items-center gap-x-2 gap-y-1">
                                        <span>{capabilities.protocol?.toUpperCase()}</span>
                                        {capabilities.model && <span>· {capabilities.model}</span>}
                                        {capabilities.dpi && <span>· {capabilities.dpi} DPI</span>}
                                        <span>· {capabilityStatusText(capabilities.status)}</span>
                                        <span className="ml-auto opacity-60">
                                            {capabilities.cached ? t('settings.capabilityCached') : t('settings.capabilityLive')}
                                        </span>
                                    </div>
                                    {capabilities.firmware && (
                                        <div className="mt-1 opacity-70">{t('settings.capabilityFirmware')}: {capabilities.firmware}</div>
                                    )}
                                </>
                            ) : (
                                <div>
                                    <div className="font-semibold">{capabilities.source === 'unavailable'
                                        ? t('settings.capabilityUnavailable')
                                        : t('settings.capabilityFailed')}</div>
                                    {capabilities.evidence[0] && <div className="mt-1 opacity-70">{capabilities.evidence[0]}</div>}
                                </div>
                            )}
                        </div>
                    )}

                    <div className="mt-4 border-t border-neutral-200 dark:border-neutral-700 pt-4 flex flex-wrap justify-end gap-2">
                        <button
                            type="button"
                            onClick={handleDetectCapabilities}
                            disabled={isDetecting || isTesting}
                            className="min-h-11 text-sm px-4 py-2.5 bg-sky-50 dark:bg-sky-500/10 hover:bg-sky-100 dark:hover:bg-sky-500/20 text-sky-700 dark:text-sky-300 rounded-lg border border-sky-200 dark:border-sky-500/20 transition-all flex items-center gap-2 disabled:opacity-50"
                        >
                            {isDetecting ? <RefreshCw size={14} className="animate-spin" /> : <Search size={14} />}
                            {isDetecting ? t('settings.detectingCapabilities') : t('settings.detectCapabilities')}
                        </button>
                        <button
                            type="button"
                            onClick={handleTestPrint}
                            disabled={isTesting || isDetecting}
                            className="min-h-11 text-sm px-4 py-2.5 bg-amber-50 dark:bg-amber-500/10 hover:bg-amber-100 dark:hover:bg-amber-500/20 text-amber-600 dark:text-amber-400 rounded-lg border border-amber-200 dark:border-amber-500/20 transition-all flex items-center gap-2 disabled:opacity-50"
                        >
                            {isTesting ? <RefreshCw size={14} className="animate-spin" /> : <Activity size={14} />}
                            {t('settings.testPrint')}
                        </button>
                    </div>
                </div>
            )}
        </section>
    );
};

export default PrinterSettings;
