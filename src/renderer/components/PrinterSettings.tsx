import { useState } from 'react';
import { useTranslation } from '../i18n';
import { Printer, Network, Usb, Monitor, RefreshCw, Activity } from 'lucide-react';

// Replicating types from main/config.ts since we can't import directly from main in renderer easily without shared types
export type ConnectionType = 'tcp' | 'serial' | 'windows_driver';
export type PrinterProtocol = 'zpl' | 'tspl' | 'image';

export interface PrinterDeviceConfig {
    id: string;
    active: boolean;
    name: string;
    connection: ConnectionType;
    protocol: PrinterProtocol;
    ip?: string;
    port?: number;
    serialPort?: string;
    baudRate?: number;
    driverName?: string;

    // UI only
    darkness?: number; // 0-30
    printSpeed?: number; // 2-12
}

interface PrinterSettingsProps {
    title: string;
    config: PrinterDeviceConfig;
    onChange: (config: PrinterDeviceConfig) => void;
    systemPrinters: Array<{ name: string; displayName: string }>;
    serialPorts: Array<{ path: string; manufacturer?: string }>;
}

const PrinterSettings = ({ title, config, onChange, systemPrinters, serialPorts }: PrinterSettingsProps) => {
    const { t } = useTranslation();
    const [isTesting, setIsTesting] = useState(false);

    const update = (field: keyof PrinterDeviceConfig, value: any) => {
        console.log(`[PrinterSettings] Updating ${field}:`, value);
        if (window.electron) {
            window.electron.send('log-to-main', { message: `[PrinterSettings] Updating ${field}`, data: value });
        }
        onChange({ ...config, [field]: value });
    };

    const handleTestPrint = async () => {
        console.log('[PrinterSettings] Starting Test Print', config);
        if (window.electron) {
            window.electron.send('log-to-main', { message: '[PrinterSettings] Starting Test Print', data: config });
        }
        setIsTesting(true);
        try {
            const res = await (window as any).electron.invoke('test-print', config);
            if (res && res.success) {
                console.log('[PrinterSettings] Test print success');
                if (window.electron) window.electron.send('log-to-main', { message: '[PrinterSettings] Test print success' });
            } else {
                console.error('[PrinterSettings] Test print failed', res);
                if (window.electron) window.electron.send('log-to-main', { message: '[PrinterSettings] Test print failed', data: res });
            }
        } catch (e) {
            console.error('[PrinterSettings] Test print error', e);
            if (window.electron) window.electron.send('log-to-main', { message: '[PrinterSettings] Test print error', data: e });
        } finally {
            setIsTesting(false);
        }
    };

    return (
        <div className="bg-black/20 p-5 rounded-xl border border-white/5">
            <h3 className="text-lg font-medium text-amber-400 mb-4 flex items-center gap-2">
                <Printer size={20} />
                {title}
            </h3>

            <div className="space-y-4">
                {/* Connection Type */}
                <div>
                    <label className="block text-sm text-neutral-400 mb-2">{t('settings.printerType')}</label>
                    <div className="grid grid-cols-3 gap-2">
                        {[
                            { id: 'windows_driver', icon: Monitor, label: 'Driver' },
                            { id: 'tcp', icon: Network, label: 'Ethernet' },
                            { id: 'serial', icon: Usb, label: 'Serial' }
                        ].map((type) => (
                            <button
                                key={type.id}
                                onClick={() => update('connection', type.id)}
                                className={`flex flex-col items-center justify-center p-3 rounded-xl border transition-all ${config.connection === type.id
                                    ? 'bg-amber-500/20 border-amber-500 text-amber-400'
                                    : 'bg-black/20 border-white/5 text-neutral-500 hover:bg-white/5 hover:text-white'
                                    }`}
                            >
                                <type.icon size={20} className="mb-1" />
                                <span className="text-xs">{type.label}</span>
                            </button>
                        ))}
                    </div>
                </div>

                {/* Protocol Selection */}
                <div>
                    <label className="block text-sm text-neutral-400 mb-2">Протокол печати</label>
                    <div className="grid grid-cols-2 gap-2">
                        {[
                            { id: 'zpl', icon: Activity, label: 'ZPL (Raw)', desc: 'Для Zebra/TSC' },
                            { id: 'image', icon: Monitor, label: 'Driver (Image)', desc: 'Для всех принтеров' }
                        ].map((proto) => (
                            <button
                                key={proto.id}
                                onClick={() => update('protocol', proto.id)}
                                className={`flex flex-col items-start p-3 rounded-xl border transition-all ${config.protocol === proto.id
                                    ? 'bg-emerald-500/10 border-emerald-500 text-emerald-400'
                                    : 'bg-black/20 border-white/5 text-neutral-500 hover:bg-white/5 hover:text-white'
                                    }`}
                            >
                                <div className="flex items-center gap-2 mb-1">
                                    <proto.icon size={16} />
                                    <span className="font-bold text-xs">{proto.label}</span>
                                </div>
                                <span className="text-[10px] opacity-60 leading-tight">{proto.desc}</span>
                            </button>
                        ))}
                    </div>
                </div>

                {/* Dynamic Configuration Fields */}

                {/* Windows Driver */}
                {config.connection === 'windows_driver' && (
                    <div>
                        <label className="block text-sm text-neutral-400 mb-2">{t('settings.driverName')}</label>
                        <select
                            value={config.driverName || ''}
                            onChange={(e) => update('driverName', e.target.value)}
                            className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                        >
                            <option value="">{t('settings.systemDefault')}</option>
                            {systemPrinters.map(p => (
                                <option key={p.name} value={p.name}>
                                    {p.displayName || p.name}
                                </option>
                            ))}
                        </select>
                    </div>
                )}



                {/* TCP/IP */}
                {config.connection === 'tcp' && (
                    <div className="grid grid-cols-3 gap-3">
                        <div className="col-span-2">
                            <label className="block text-sm text-neutral-400 mb-2">{t('settings.ipAddress')}</label>
                            <input
                                type="text"
                                value={config.ip || '192.168.1.100'}
                                onChange={(e) => update('ip', e.target.value)}
                                className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                            />
                        </div>
                        <div>
                            <label className="block text-sm text-neutral-400 mb-2">{t('settings.port')}</label>
                            <input
                                type="number"
                                value={config.port || 9100}
                                onChange={(e) => update('port', Number(e.target.value))}
                                className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                            />
                        </div>
                    </div>
                )}

                {/* Serial */}
                {config.connection === 'serial' && (
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="block text-sm text-neutral-400 mb-2">{t('settings.port')}</label>
                            <select
                                value={config.serialPort || ''}
                                onChange={(e) => update('serialPort', e.target.value)}
                                className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                            >
                                <option value="">Select Port</option>
                                {serialPorts.map(p => (
                                    <option key={p.path} value={p.path}>{p.path}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="block text-sm text-neutral-400 mb-2">{t('settings.baudRate')}</label>
                            <select
                                value={config.baudRate || 9600}
                                onChange={(e) => update('baudRate', Number(e.target.value))}
                                className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                            >
                                {[9600, 19200, 38400, 57600, 115200].map(r => (
                                    <option key={r} value={r}>{r}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                )}



                <div className="pt-2 flex justify-end">
                    <button
                        onClick={handleTestPrint}
                        disabled={isTesting}
                        className="text-xs px-4 py-2 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 rounded-lg border border-amber-500/20 transition-all flex items-center gap-2"
                    >
                        {isTesting ? <RefreshCw size={14} className="animate-spin" /> : <Activity size={14} />}
                        {t('settings.testPrint')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default PrinterSettings;
