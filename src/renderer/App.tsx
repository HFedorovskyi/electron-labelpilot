import React, { useState } from 'react';
import Sidebar from './components/Sidebar';
import WeighingStation from './components/WeighingStation';
import Settings from './components/Settings';

const App = () => {
    const [activeTab, setActiveTab] = useState('weighing');

    return (
        <div className="flex h-screen bg-neutral-950 text-white font-sans overflow-hidden">
            <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} />
            <main className="flex-1 overflow-auto p-6 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-emerald-900/20 via-neutral-950 to-neutral-950">
                {activeTab === 'weighing' && <WeighingStation />}
                {activeTab === 'settings' && <Settings />}
            </main>
        </div>
    );
};

export default App;
