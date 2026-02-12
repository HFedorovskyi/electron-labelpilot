import React, { useState, useEffect } from 'react';
import { Package, Search, ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslation } from '../i18n';

const Products: React.FC = () => {
    const { t } = useTranslation();
    const [products, setProducts] = useState<any[]>([]);
    const [containers, setContainers] = useState<any[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [expandedId, setExpandedId] = useState<number | null>(null);

    useEffect(() => {
        loadData();
    }, []);

    const loadData = async () => {
        try {
            const [prods, conts] = await Promise.all([
                window.electron.invoke('get-products', ''),
                window.electron.invoke('get-containers'),
            ]);
            setProducts(prods || []);
            setContainers(conts || []);
        } catch (err) {
            console.error('Failed to load products', err);
        }
    };

    const getContainerName = (id: number | null) => {
        if (!id) return '—';
        const c = containers.find((c: any) => c.id === id);
        return c ? `${c.name} (${c.weight} ${t('products.gram')})` : `#${id}`;
    };

    const filtered = products.filter(p => {
        if (!searchQuery) return true;
        const q = searchQuery.toLowerCase();
        return (p.name?.toLowerCase().includes(q) || p.article?.toLowerCase().includes(q));
    });

    const parseExtra = (extra: any): Record<string, any> | null => {
        if (!extra) return null;
        try {
            return typeof extra === 'string' ? JSON.parse(extra) : extra;
        } catch { return null; }
    };

    return (
        <div className="bg-neutral-900 min-h-screen text-white p-8">
            <h1 className="text-3xl font-bold mb-8 flex items-center gap-3">
                <Package className="w-8 h-8 text-emerald-500" />
                {t('products.title')}
                <span className="ml-auto text-sm font-normal text-neutral-500">
                    {t('products.totalItems')}: {filtered.length}
                </span>
            </h1>

            {/* Search */}
            <div className="relative mb-6 max-w-xl">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500" />
                <input
                    type="text"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder={t('products.search')}
                    className="w-full pl-11 pr-4 py-3 bg-black/30 border border-white/10 rounded-xl text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                />
            </div>

            {filtered.length === 0 ? (
                <div className="text-center text-neutral-500 py-20 text-lg">{t('products.noProducts')}</div>
            ) : (
                <div className="space-y-3">
                    {/* Header */}
                    <div className="grid grid-cols-12 gap-3 px-5 py-2 text-xs text-neutral-500 uppercase tracking-wider">
                        <div className="col-span-4">{t('products.name')}</div>
                        <div className="col-span-2">{t('products.article')}</div>
                        <div className="col-span-1 text-center">{t('products.expDays')}</div>
                        <div className="col-span-2">{t('products.packTare')}</div>
                        <div className="col-span-2">{t('products.boxTare')}</div>
                        <div className="col-span-1 text-center">{t('products.boxLimit')}</div>
                    </div>

                    {filtered.map(product => {
                        const isExpanded = expandedId === product.id;
                        const extra = parseExtra(product.extra_data);

                        return (
                            <div key={product.id} className="bg-white/5 border border-white/10 rounded-xl overflow-hidden transition-all">
                                <button
                                    onClick={() => setExpandedId(isExpanded ? null : product.id)}
                                    className="w-full grid grid-cols-12 gap-3 items-center px-5 py-4 hover:bg-white/5 transition-colors text-left"
                                >
                                    <div className="col-span-4 font-medium text-white truncate">{product.name}</div>
                                    <div className="col-span-2 text-neutral-400 font-mono text-sm">{product.article || '—'}</div>
                                    <div className="col-span-1 text-center text-neutral-300">{product.exp_date || 0}</div>
                                    <div className="col-span-2 text-neutral-400 text-sm">{getContainerName(product.portion_container_id)}</div>
                                    <div className="col-span-2 text-neutral-400 text-sm">{getContainerName(product.box_container_id)}</div>
                                    <div className="col-span-1 flex items-center justify-center gap-2">
                                        <span className="text-neutral-300">{product.close_box_counter || '—'}</span>
                                        {isExpanded ? (
                                            <ChevronUp className="w-4 h-4 text-neutral-500" />
                                        ) : (
                                            <ChevronDown className="w-4 h-4 text-neutral-500" />
                                        )}
                                    </div>
                                </button>

                                {isExpanded && (
                                    <div className="px-5 pb-5 pt-2 border-t border-white/5">
                                        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                                            <div className="bg-black/20 p-3 rounded-lg">
                                                <div className="text-xs text-neutral-500 mb-1">{t('products.packLabel')}</div>
                                                <div className="text-sm text-white">{product.templates_pack_label ? `#${product.templates_pack_label}` : '—'}</div>
                                            </div>
                                            <div className="bg-black/20 p-3 rounded-lg">
                                                <div className="text-xs text-neutral-500 mb-1">{t('products.boxLabel')}</div>
                                                <div className="text-sm text-white">{product.templates_box_label ? `#${product.templates_box_label}` : '—'}</div>
                                            </div>
                                            <div className="bg-black/20 p-3 rounded-lg">
                                                <div className="text-xs text-neutral-500 mb-1">ID</div>
                                                <div className="text-sm text-white font-mono">{product.id}</div>
                                            </div>
                                            <div className="bg-black/20 p-3 rounded-lg">
                                                <div className="text-xs text-neutral-500 mb-1">{t('products.packTare')} ({t('products.gram')})</div>
                                                <div className="text-sm text-white">{product.portion_weight ?? '—'}</div>
                                            </div>
                                        </div>

                                        {extra && Object.keys(extra).length > 0 && (
                                            <div className="mt-4">
                                                <div className="text-xs text-neutral-500 mb-2">{t('products.extraData')}</div>
                                                <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
                                                    {Object.entries(extra).map(([key, val]) => (
                                                        <div key={key} className="bg-black/20 p-2 rounded-lg">
                                                            <div className="text-xs text-neutral-500">{key}</div>
                                                            <div className="text-sm text-white truncate">{String(val)}</div>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default Products;
