import React from 'react';
import { Scale, Settings, Package, LogOut, ChevronLeft, Menu, Weight, ClipboardList, User, UserCog, KeyRound } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from '../i18n';
import { useLicenseStatus } from '../hooks/useLicenseStatus';
import { useSession } from './SessionProvider';
import LicenseBadge from './LicenseBadge';
import packageJson from '../../../package.json';

interface SidebarProps {
    activeTab: string;
    setActiveTab: (tab: string) => void;
    serverStatus: string;
    stationNumber: number | null;
    isCollapsed: boolean;
    toggleCollapse: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({ activeTab, setActiveTab, serverStatus, stationNumber, isCollapsed, toggleCollapse }) => {
    const { t } = useTranslation();
    const { license } = useLicenseStatus(serverStatus);
    const { operator, isDemo, logout } = useSession();

    const menuItems = [
        { id: 'weighing', labelKey: 'sidebar.weighing', icon: Scale },
        { id: 'fixedWeight', labelKey: 'sidebar.fixedWeight', icon: Weight },
        { id: 'printJob', labelKey: 'sidebar.printJob', icon: ClipboardList },
        { id: 'products', labelKey: 'sidebar.products', icon: Package },
        { id: 'license', labelKey: 'license.title', icon: KeyRound },
        { id: 'settings', labelKey: 'sidebar.settings', icon: Settings },
    ];

    const handleExit = () => {
        window.electron.send('quit-app', {});
    };

    return (
        <div className={clsx(
            "bg-white/50 dark:bg-neutral-900/50 backdrop-blur border-r border-neutral-200 dark:border-neutral-600 flex flex-col transition-all duration-300",
            isCollapsed ? "w-[4.5rem] p-3" : "w-64 p-4"
        )}>
            <div className={clsx("flex items-center gap-1.5 py-6 mb-6", isCollapsed ? "justify-center" : "justify-between")}>
                {isCollapsed ? (
                    <button onClick={toggleCollapse} className="p-2 hover:bg-neutral-100 dark:hover:bg-white/5 rounded-xl transition-colors">
                        <Menu className="w-6 h-6 text-neutral-500 dark:text-neutral-400" />
                    </button>
                ) : (
                    <>
                        <div className="flex items-center gap-1.5 overflow-hidden">
                            <div className="flex items-center justify-center shrink-0">
                                <img src="./sidebar-logo.svg" alt="LabelPilot Logo" className="w-10 h-10" />
                            </div>
                            <h1 className="text-2xl font-black tracking-tighter whitespace-nowrap text-neutral-800 dark:text-white" style={{ fontFamily: "'Outfit', sans-serif", textShadow: '0 2px 4px rgba(0,0,0,0.1)' }}>LabelPilot</h1>
                        </div>
                        <button onClick={toggleCollapse} className="p-1.5 hover:bg-neutral-100 dark:hover:bg-white/5 rounded-lg transition-colors shrink-0 outline-none">
                            <ChevronLeft className="w-5 h-5 text-neutral-500 dark:text-neutral-400" />
                        </button>
                    </>
                )}
            </div>

            <div className="space-y-2 flex-1">
                {menuItems.map((item) => (
                    <button
                        key={item.id}
                        onClick={() => setActiveTab(item.id)}
                        title={isCollapsed ? t(item.labelKey) : undefined}
                        className={clsx(
                            "w-full flex items-center gap-3 rounded-xl transition-all duration-200 text-sm font-medium",
                            isCollapsed ? "justify-center p-3" : "px-4 py-3",
                            activeTab === item.id
                                ? "bg-emerald-100/50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 shadow-[0_0_20px_rgba(16,185,129,0.05)] dark:shadow-[0_0_20px_rgba(16,185,129,0.1)]"
                                : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-white/5"
                        )}
                    >
                        <item.icon className="w-5 h-5 shrink-0" />
                        {!isCollapsed && <span>{t(item.labelKey)}</span>}
                    </button>
                ))}
            </div>

            <div className={clsx("pb-4", isCollapsed ? "" : "px-2")}>
                <button
                    onClick={handleExit}
                    title={isCollapsed ? t('sidebar.exit') : undefined}
                    className={clsx(
                        "w-full flex items-center gap-3 rounded-xl transition-all duration-200 text-sm font-medium text-red-500 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-100 dark:hover:bg-white/5 border border-transparent hover:border-red-500/20",
                        isCollapsed ? "justify-center p-3" : "px-4 py-3"
                    )}
                >
                    <LogOut className="w-5 h-5 shrink-0" />
                    {!isCollapsed && <span>{t('sidebar.exit')}</span>}
                </button>
            </div>

            <div className={clsx(
                "mt-auto py-4 text-xs text-neutral-500 dark:text-neutral-600 border-t border-neutral-200 dark:border-neutral-600 pt-6",
                isCollapsed ? "px-0 space-y-4 flex flex-col items-center" : "px-2 space-y-2.5"
            )}>
                {/* Server Status */}
                <div className={clsx("flex items-center group flex-wrap", isCollapsed ? "justify-center" : "justify-between")} title={isCollapsed ? (serverStatus === 'connected' ? t('sidebar.connected') : t('ws.scaleStatus.disconnected')) : undefined}>
                    {!isCollapsed && <span className="group-hover:text-neutral-700 dark:group-hover:text-neutral-400 transition-colors uppercase tracking-wider text-[10px] font-bold">{t('sidebar.serverStatus')}</span>}
                    <div className="flex items-center gap-2">
                        <div className={clsx(
                            "rounded-full animate-pulse",
                            isCollapsed ? "w-3 h-3" : "w-1.5 h-1.5",
                            serverStatus === 'connected' ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)] dark:shadow-[0_0_8px_rgba(16,185,129,0.6)]" : "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.3)] dark:shadow-[0_0_8px_rgba(239,68,68,0.4)]"
                        )}></div>
                        {!isCollapsed && <span className={clsx(
                            "font-medium",
                            serverStatus === 'connected' ? "text-emerald-600 dark:text-emerald-500" : "text-red-500 dark:text-red-400"
                        )}>
                            {serverStatus === 'connected' ? t('sidebar.connected') : t('ws.scaleStatus.disconnected')}
                        </span>}
                    </div>
                </div>

                {/* Station Number */}
                <div className={clsx("flex items-center group", isCollapsed ? "justify-center" : "justify-between")} title={isCollapsed ? t('ws.stationNumber') : undefined}>
                    {!isCollapsed && <span className="group-hover:text-neutral-700 dark:group-hover:text-neutral-400 transition-colors uppercase tracking-wider text-[10px] font-bold">{t('ws.stationNumber')}</span>}
                    <span className="text-neutral-700 dark:text-white font-mono bg-neutral-100 dark:bg-white/5 px-2 py-0.5 rounded border border-neutral-200 dark:border-neutral-600 min-w-[2.5rem] text-center">
                        {stationNumber !== null ? String(stationNumber).padStart(2, '0') : '--'}
                    </span>
                </div>

                {/* Current operator + Switch (PIN-login layer). Demo mode shows the synthetic
                    operator with no "switch" action (demo bypasses login). */}
                {operator && (
                    isCollapsed ? (
                        <button
                            onClick={() => { if (!isDemo) logout(); }}
                            title={`${operator.full_name}${isDemo ? '' : ' — ' + t('operator.switch')}`}
                            className={clsx(
                                "flex items-center justify-center rounded-full border w-9 h-9 transition-colors",
                                isDemo
                                    ? "bg-amber-100 dark:bg-amber-500/10 border-amber-300 dark:border-amber-500/30 text-amber-600 dark:text-amber-400 cursor-default"
                                    : "bg-neutral-100 dark:bg-white/5 border-neutral-200 dark:border-neutral-600 text-neutral-500 dark:text-neutral-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:border-emerald-300 dark:hover:border-emerald-500/40"
                            )}
                        >
                            <User className="w-4 h-4" />
                        </button>
                    ) : (
                        <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                                <User className="w-4 h-4 shrink-0 text-neutral-500 dark:text-neutral-400" />
                                <span className="font-medium text-neutral-700 dark:text-neutral-300 truncate" title={operator.full_name}>
                                    {operator.full_name}
                                </span>
                            </div>
                            {!isDemo && (
                                <button
                                    onClick={() => logout()}
                                    title={t('operator.switch')}
                                    className="flex items-center gap-1 shrink-0 px-2 py-1 rounded-lg bg-neutral-100 dark:bg-white/5 border border-neutral-200 dark:border-neutral-600 text-[10px] font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:border-emerald-300 dark:hover:border-emerald-500/40 transition-colors"
                                >
                                    <UserCog className="w-3.5 h-3.5" />
                                    {t('operator.switch')}
                                </button>
                            )}
                        </div>
                    )
                )}

                {/* License / Demo status — non-blocking; renders nothing until known */}
                {license && (
                    <div className={clsx("min-w-0", isCollapsed ? "flex items-center justify-center" : "flex flex-col gap-1.5")}>
                        {!isCollapsed && license.mode !== 'licensed' && <span className="uppercase tracking-wider text-[10px] font-bold">{t('license.title')}</span>}
                        <LicenseBadge license={license} collapsed={isCollapsed} />
                    </div>
                )}

                {/* Software Version */}
                {!isCollapsed && (
                    <div className="pt-2 opacity-70 flex items-center text-[10px] border-t border-neutral-200 dark:border-neutral-600 mt-1">
                        <span className="text-emerald-600 dark:text-emerald-500 font-bold tracking-widest uppercase">{t('sidebar.version')} {packageJson.version}</span>
                    </div>
                )}
            </div>
        </div>
    );
};

export default Sidebar;
