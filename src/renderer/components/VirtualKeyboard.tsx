import { useState } from 'react';
import { Delete, ArrowUp, Globe } from 'lucide-react';

interface VirtualKeyboardProps {
    value: string;
    onChange: (val: string) => void;
}

const LAYOUTS = {
    en: {
        normal: [
            ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-'],
            ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
            ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
            ['z', 'x', 'c', 'v', 'b', 'n', 'm']
        ],
        shift: [
            ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '_'],
            ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
            ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
            ['Z', 'X', 'C', 'V', 'B', 'N', 'M']
        ]
    },
    ru: {
        normal: [
            ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-'],
            ['й', 'ц', 'у', 'к', 'е', 'н', 'г', 'ш', 'щ', 'з', 'х', 'ъ'],
            ['ф', 'ы', 'в', 'а', 'п', 'р', 'о', 'л', 'д', 'ж', 'э'],
            ['я', 'ч', 'с', 'м', 'и', 'т', 'ь', 'б', 'ю']
        ],
        shift: [
            ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '_'],
            ['Й', 'Ц', 'У', 'К', 'Е', 'Н', 'Г', 'Ш', 'Щ', 'З', 'Х', 'Ъ'],
            ['Ф', 'Ы', 'В', 'А', 'П', 'Р', 'О', 'Л', 'Д', 'Ж', 'Э'],
            ['Я', 'Ч', 'С', 'М', 'И', 'Т', 'Ь', 'Б', 'Ю']
        ]
    }
};

const VirtualKeyboard: React.FC<VirtualKeyboardProps> = ({ value, onChange }) => {
    const [lang, setLang] = useState<'ru' | 'en'>('ru');
    const [shift, setShift] = useState(false);

    const layout = LAYOUTS[lang][shift ? 'shift' : 'normal'];

    const handleKeyPress = (key: string) => {
        onChange(value + key);
    };

    const handleBackspace = () => {
        onChange(value.slice(0, -1));
    };

    return (
        <div className="flex flex-col gap-2 p-2 max-w-6xl mx-auto w-full">
            {layout.map((row, rowIndex) => (
                <div key={rowIndex} className="flex justify-center gap-2">
                    {/* Shift Key */}
                    {rowIndex === 3 && (
                        <button
                            onClick={() => setShift(!shift)}
                            className={`flex-[0.5] py-5 rounded-xl font-bold flex items-center justify-center transition-colors active:scale-95 ${shift ? 'bg-emerald-500 text-white' : 'bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white border border-neutral-300 dark:border-transparent shadow-sm'}`}
                        >
                            <ArrowUp className="w-8 h-8" />
                        </button>
                    )}

                    {/* Standard Keys */}
                    {row.map(key => (
                        <button
                            key={key}
                            onClick={() => handleKeyPress(key)}
                            className="flex-1 py-5 bg-white dark:bg-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-600 text-neutral-900 dark:text-white rounded-xl mx-0.5 text-3xl font-medium border border-neutral-300 dark:border-transparent shadow-sm active:scale-95 transition-all outline-none touch-manipulation min-w-[3rem]"
                        >
                            {key}
                        </button>
                    ))}

                    {/* Backspace Key for first row (numbers) to align standard QWERTY */}
                    {rowIndex === 0 && (
                        <button
                            onClick={handleBackspace}
                            className="flex-[1.5] py-5 bg-neutral-200 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 rounded-xl flex items-center justify-center border border-neutral-300 dark:border-transparent shadow-sm active:scale-95 transition-all"
                        >
                            <Delete className="w-8 h-8" />
                        </button>
                    )}
                </div>
            ))}

            {/* Bottom Row */}
            <div className="flex justify-center gap-2 mt-1">
                <button
                    onClick={() => setLang(lang === 'ru' ? 'en' : 'ru')}
                    className="flex-[1] py-5 bg-neutral-200 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 rounded-xl flex items-center justify-center border border-neutral-300 dark:border-transparent shadow-sm active:scale-95 transition-all font-bold uppercase text-2xl"
                >
                    <Globe className="w-8 h-8 mr-3" />
                    {lang}
                </button>
                <button
                    onClick={() => handleKeyPress(' ')}
                    className="flex-[4] py-5 bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white border border-neutral-300 dark:border-transparent rounded-xl shadow-sm active:scale-95 transition-all text-2xl font-medium"
                >
                    Пробел
                </button>
                <button
                    onClick={handleBackspace}
                    className="flex-[1.5] py-5 bg-neutral-200 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 rounded-xl flex items-center justify-center border border-neutral-300 dark:border-transparent shadow-sm active:scale-95 transition-all"
                >
                    <Delete className="w-8 h-8" />
                </button>
            </div>
        </div>
    );
};

export default VirtualKeyboard;
