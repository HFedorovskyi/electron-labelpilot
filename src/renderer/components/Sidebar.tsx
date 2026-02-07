import React from 'react';
import { Scale, Settings, Package, FileText } from 'lucide-react';
import clsx from 'clsx';

interface SidebarProps {
    activeTab: string;
    setActiveTab: (tab: string) => void;
}

const Sidebar: React.FC<SidebarProps> = ({ activeTab, setActiveTab }) => {
    const menuItems = [
        { id: 'weighing', label: 'Label Station', icon: Scale },
        { id: 'products', label: 'Products', icon: Package },
        { id: 'templates', label: 'Templates', icon: FileText },
        { id: 'settings', label: 'Settings', icon: Settings },
    ];

    return (
        <div className="w-64 bg-neutral-900/50 backdrop-blur border-r border-white/5 flex flex-col p-4">
            <div className="flex items-center gap-3 px-4 py-6 mb-6">
                <div className="w-8 h-8 bg-emerald-500 rounded-lg flex items-center justify-center">
                    <Scale className="text-white w-5 h-5" />
                </div>
                <h1 className="text-xl font-bold tracking-tight">LabelPilot</h1>
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
                        {item.label}
                    </button>
                ))}
            </div>

            <div className="mt-auto px-4 py-4 text-xs text-neutral-600 border-t border-white/5 pt-6">
                <p>Status: <span className="text-emerald-500">Connected</span></p>
                <p className="mt-1">v2.0.0 (Electron)</p>
            </div>
        </div>
    );
};

export default Sidebar;
