import { useState, useMemo } from 'react';
import { X, Search, Keyboard } from 'lucide-react';
import VirtualKeyboard from './VirtualKeyboard';
import { useTranslation } from '../i18n';

interface ProductSelectionModalProps {
    products: any[];
    onSelect: (product: any) => void;
    onClose: () => void;
}

const ProductSelectionModal: React.FC<ProductSelectionModalProps> = ({ products, onSelect, onClose }) => {
    const { t } = useTranslation();
    const [searchQuery, setSearchQuery] = useState('');
    const [showKeyboard, setShowKeyboard] = useState(false);

    const filteredProducts = useMemo(() => {
        if (!searchQuery) return products;
        const q = searchQuery.toLowerCase();
        return products.filter(p =>
            p.name.toLowerCase().includes(q) ||
            (p.article && p.article.toLowerCase().includes(q))
        );
    }, [products, searchQuery]);

    return (
        <div className="fixed inset-0 bg-neutral-100 dark:bg-neutral-900 z-[150] flex flex-col animate-in fade-in duration-200">
            {/* Header */}
            <div className="flex-none p-6 bg-white dark:bg-neutral-800 border-b border-neutral-200 dark:border-white/10 shadow-sm flex items-center gap-6">
                <div className="relative flex-1">
                    <Search className="absolute left-6 top-1/2 -translate-y-1/2 w-8 h-8 text-neutral-400" />
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onFocus={() => setShowKeyboard(true)}
                        className="w-full pl-20 pr-24 py-6 text-3xl rounded-3xl bg-neutral-100 dark:bg-black/20 border border-neutral-300 dark:border-white/10 focus:outline-none focus:ring-2 focus:ring-emerald-500 transition-all text-neutral-900 dark:text-white placeholder-neutral-400 font-medium"
                        placeholder="Поиск номенклатуры или артикула..."
                    />
                    <button
                        onClick={() => setShowKeyboard(!showKeyboard)}
                        className={`absolute right-4 top-1/2 -translate-y-1/2 p-4 rounded-2xl transition-all ${showKeyboard ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400' : 'text-neutral-400 hover:bg-neutral-200 dark:hover:bg-white/10'}`}
                    >
                        <Keyboard className="w-10 h-10" />
                    </button>
                </div>
                <button onClick={onClose} className="p-6 bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400 rounded-3xl hover:bg-red-100 dark:hover:bg-red-500/20 active:scale-95 transition-all shadow-sm">
                    <X className="w-10 h-10" />
                </button>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
                {filteredProducts.map(p => (
                    <div
                        key={p.id}
                        onClick={() => onSelect(p)}
                        className="p-8 bg-white dark:bg-neutral-800 rounded-3xl border border-neutral-200 dark:border-white/5 active:bg-emerald-50 dark:active:bg-emerald-500/10 shadow-sm flex flex-col gap-3 cursor-pointer transition-colors"
                    >
                        <div className="text-3xl font-bold text-neutral-900 dark:text-white">{p.name}</div>
                        <div className="text-xl text-neutral-500 dark:text-neutral-400 font-mono">
                            {t('products.article')}: <span className="text-neutral-700 dark:text-neutral-300 font-bold">{p.article || '—'}</span>
                        </div>
                    </div>
                ))}
                {filteredProducts.length === 0 && (
                    <div className="text-center p-20 text-neutral-500 text-3xl font-medium italic">
                        {t('ws.noProducts')}
                    </div>
                )}
            </div>

            {/* Keyboard */}
            {showKeyboard && (
                <div className="flex-none bg-neutral-200 dark:bg-neutral-800 border-t border-neutral-300 dark:border-white/10 p-4 shadow-[0_-10px_40px_rgba(0,0,0,0.1)] slide-in-from-bottom-full duration-300 animate-in pt-6 pb-8">
                    <VirtualKeyboard value={searchQuery} onChange={setSearchQuery} />
                </div>
            )}
        </div>
    );
};

export default ProductSelectionModal;
