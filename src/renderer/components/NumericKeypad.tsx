import React from 'react';
import { X, Delete, Check } from 'lucide-react';

interface NumericKeypadProps {
    value: string;
    onUpdate: (val: string) => void;
    onClose: () => void;
    title?: string;
}

const NumericKeypad: React.FC<NumericKeypadProps> = ({ value, onUpdate, onClose, title = 'Введите данные' }) => {

    const handleNumber = (n: string) => {
        onUpdate(value + n);
    };

    const handleBackspace = () => {
        onUpdate(value.slice(0, -1));
    };

    const handleClear = () => {
        onUpdate('');
    };

    const buttons = [
        '1', '2', '3',
        '4', '5', '6',
        '7', '8', '9',
        'C', '0', '⌫'
    ];

    return (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
            <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-white/10 rounded-[2.5rem] p-8 w-[400px] shadow-sm dark:shadow-2xl relative animate-in zoom-in-95 duration-200">
                <button
                    onClick={onClose}
                    className="absolute top-6 right-6 p-2 bg-neutral-100 dark:bg-white/5 hover:bg-neutral-200 dark:hover:bg-white/10 rounded-full transition-colors"
                >
                    <X className="w-8 h-8 text-neutral-500 dark:text-neutral-400" />
                </button>

                <h3 className="text-2xl font-bold text-neutral-900 dark:text-white mb-6 text-center">{title}</h3>

                <div className="bg-neutral-50 dark:bg-black/40 border border-neutral-200 dark:border-white/10 rounded-2xl p-6 mb-8 text-center shadow-inner dark:shadow-none">
                    <div className="text-4xl font-mono font-bold text-emerald-600 dark:text-emerald-400 min-h-[44px] break-all">
                        {value || <span className="text-neutral-300 dark:text-neutral-700">_</span>}
                    </div>
                </div>

                <div className="grid grid-cols-3 gap-4">
                    {buttons.map((btn) => {
                        let className = "py-6 text-2xl font-bold rounded-2xl transition-all active:scale-95 flex items-center justify-center shadow-sm dark:shadow-none border ";
                        let action = () => handleNumber(btn);

                        if (btn === 'C') {
                            className += "bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-500 border-red-200 dark:border-red-500/20 hover:bg-red-100 dark:hover:bg-red-500/20";
                            action = handleClear;
                        } else if (btn === '⌫') {
                            className += "bg-neutral-200 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-300 dark:hover:bg-neutral-700 border-neutral-300 dark:border-transparent";
                            action = handleBackspace;
                        } else {
                            className += "bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-white hover:bg-neutral-200 dark:hover:bg-neutral-700 border-neutral-300 dark:border-white/5";
                        }

                        return (
                            <button key={btn} onClick={action} className={className}>
                                {btn === '⌫' ? <Delete className="w-8 h-8" /> : btn}
                            </button>
                        );
                    })}
                </div>

                <button
                    onClick={onClose}
                    className="w-full mt-8 py-6 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl font-bold text-xl flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 transition-all active:scale-[0.98]"
                >
                    <Check className="w-6 h-6" />
                    OK
                </button>
            </div>
        </div>
    );
};

export default NumericKeypad;
