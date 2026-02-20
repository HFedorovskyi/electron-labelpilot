import React from 'react';
import { Scale, Settings, Package, Database, LogOut } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from '../i18n';
import packageJson from '../../../package.json';

interface SidebarProps {
    activeTab: string;
    setActiveTab: (tab: string) => void;
    serverStatus: string;
    stationNumber: number | null;
}

const Sidebar: React.FC<SidebarProps> = ({ activeTab, setActiveTab, serverStatus, stationNumber }) => {
    const { t } = useTranslation();

    const menuItems = [
        { id: 'weighing', labelKey: 'sidebar.weighing', icon: Scale },
        { id: 'products', labelKey: 'sidebar.products', icon: Package },
        { id: 'database', labelKey: 'sidebar.database', icon: Database },
        { id: 'settings', labelKey: 'sidebar.settings', icon: Settings },
    ];

    const handleExit = () => {
        window.electron.send('quit-app', {});
    };

    return (
        <div className="w-64 bg-neutral-900/50 backdrop-blur border-r border-white/5 flex flex-col p-4">
            <div className="flex items-center gap-1.5 px-0 py-6 mb-6">
                <div className="flex items-center justify-center shrink-0">
                    <img src="./sidebar-logo.svg" alt="LabelPilot Logo" className="w-16 h-16 filter grayscale brightness-200" style={{ filter: 'invert(100%)' }} />
                </div>
                <h1 className="text-3xl font-black tracking-tighter whitespace-nowrap overflow-hidden text-ellipsis text-neutral-300" style={{ fontFamily: "'Outfit', sans-serif", textShadow: '0 2px 4px rgba(0,0,0,0.3)' }}>LabelPilot</h1>
            </div>

            <div className="space-y-2 flex-1">
                {menuItems.map((item) => (
                    <button
                        key={item.id}
                        onClick={() => setActiveTab(item.id)}
                        className={clsx(
                            "w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 text-sm font-medium",
                            activeTab === item.id
                                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shadow-[0_0_20px_rgba(16,185,129,0.1)]"
                                : "text-neutral-400 hover:text-white hover:bg-white/5"
                        )}
                    >
                        <item.icon className="w-5 h-5" />
                        {t(item.labelKey)}
                    </button>
                ))}
            </div>

            <div className="px-4 pb-4">
                <button
                    onClick={handleExit}
                    className="w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 text-sm font-medium text-red-400 hover:text-red-300 hover:bg-white/5 border border-transparent hover:border-red-500/20"
                >
                    <LogOut className="w-5 h-5" />
                    {t('sidebar.exit')}
                </button>
            </div>

            <div className="mt-auto px-4 py-4 text-xs text-neutral-600 border-t border-white/5 pt-6 space-y-2.5">
                {/* Server Status */}
                <div className="flex justify-between items-center group">
                    <span className="group-hover:text-neutral-400 transition-colors uppercase tracking-wider text-[10px] font-bold">{t('sidebar.serverStatus')}</span>
                    <div className="flex items-center gap-2">
                        <div className={clsx(
                            "w-1.5 h-1.5 rounded-full animate-pulse",
                            serverStatus === 'connected' ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]" : "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.4)]"
                        )}></div>
                        <span className={clsx(
                            "font-medium",
                            serverStatus === 'connected' ? "text-emerald-500" : "text-red-400"
                        )}>
                            {serverStatus === 'connected' ? t('sidebar.connected') : t('ws.scaleStatus.disconnected')}
                        </span>
                    </div>
                </div>

                {/* Station Number */}
                <div className="flex justify-between items-center group">
                    <span className="group-hover:text-neutral-400 transition-colors uppercase tracking-wider text-[10px] font-bold">{t('ws.stationNumber')}</span>
                    <span className="text-white font-mono bg-white/5 px-2 py-0.5 rounded border border-white/5 min-w-[2.5rem] text-center">
                        {stationNumber !== null ? String(stationNumber).padStart(2, '0') : '--'}
                    </span>
                </div>

                {/* Software Version */}
                <div className="pt-2 opacity-70 flex justify-between items-center text-[10px] border-t border-white/5 mt-1">
                    <span className="text-emerald-500 font-bold tracking-widest uppercase">v{packageJson.version}</span>
                    <span className="font-bold tracking-wider text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-cyan-400">LabelPilot</span>
                </div>
            </div>
        </div>
    );
};

export default Sidebar;
