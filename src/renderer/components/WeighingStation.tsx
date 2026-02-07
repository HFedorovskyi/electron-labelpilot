import React, { useEffect, useState } from 'react';
import { Printer, RefreshCw, Box } from 'lucide-react';

const WeighingStation = () => {
    const [weight, setWeight] = useState<string>('0.000');
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const [status, setStatus] = useState<string>('disconnected');

    useEffect(() => {
        const removeReadingListener = window.electron.on('scale-reading', (data: any) => {
            // Check if data is object with weight property
            if (data && typeof data === 'object' && 'weight' in data) {
                setWeight(typeof data.weight === 'number' ? data.weight.toFixed(3) : String(data.weight));
                return;
            }

            // Fallback for string or other formats
            const weightStr = typeof data === 'string' ? data : JSON.stringify(data);
            const match = weightStr.match(/(\d+\.\d+)/);
            if (match) {
                setWeight(match[1]);
            } else {
                setWeight(weightStr);
            }
        });

        const removeStatusListener = window.electron.on('scale-status', (s: any) => setStatus(s));

        return () => {
            removeReadingListener();
            removeStatusListener();
        };
    }, []);

    const handlePrint = () => {
        // window.print(); // Simple browser print
        // Or invoke main process
        window.electron.invoke('print-label', { silent: false });
    };

    const [products, setProducts] = useState<any[]>([]);
    const [selectedProduct, setSelectedProduct] = useState<any | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [isMenuOpen, setIsMenuOpen] = useState(false);

    useEffect(() => {
        loadProducts();
    }, []);

    const loadProducts = async (query = '') => {
        try {
            const list = await window.electron.invoke('get-products', query);
            setProducts(list);
        } catch (err) {
            console.error(err);
        }
    };

    const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
        const query = e.target.value;
        setSearchQuery(query);
        loadProducts(query);
        setIsMenuOpen(true);
    };

    const handleSelectProduct = (product: any) => {
        setSelectedProduct(product);
        setSearchQuery('');
        setIsMenuOpen(false);
    };

    return (
        <div className="grid grid-cols-12 gap-6 h-full p-4 relative" onClick={() => setIsMenuOpen(false)}>
            {/* Product Information Card */}
            <div className="col-span-8 bg-neutral-900/50 border border-white/5 rounded-3xl p-8 backdrop-blur shadow-2xl">
                <div className="flex justify-between items-start mb-8">
                    <div>
                        <h2 className="text-2xl font-semibold text-white">Weighing Station</h2>
                        <p className="text-neutral-400 mt-1">Select logic and start weighing</p>
                    </div>
                    <div className="px-4 py-2 bg-emerald-500/10 border border-emerald-500/20 rounded-full text-emerald-400 text-sm font-medium flex items-center gap-2">
                        <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>
                        Scale Active
                    </div>
                </div>

                <div className="space-y-6 relative">
                    <div onClick={(e) => e.stopPropagation()}>
                        <label className="block text-sm font-medium text-neutral-400 mb-2">Search Article / SKU</label>
                        <input
                            type="text"
                            placeholder="Scan or type..."
                            value={searchQuery}
                            onChange={handleSearch}
                            onFocus={() => setIsMenuOpen(true)}
                            className="w-full bg-black/20 border border-white/10 rounded-2xl px-5 py-4 text-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all text-white placeholder-neutral-600"
                        />
                        {/* Dropdown Menu */}
                        {isMenuOpen && products.length > 0 && (
                            <div className="absolute w-full mt-2 bg-neutral-900 border border-white/10 rounded-2xl shadow-xl max-h-60 overflow-y-auto z-50">
                                {products.map((p: any) => (
                                    <div
                                        key={p.id}
                                        onClick={() => handleSelectProduct(p)}
                                        className="px-5 py-3 hover:bg-emerald-500/20 cursor-pointer flex justify-between items-center group transition-colors"
                                    >
                                        <span className="text-white group-hover:text-emerald-100">{p.name} <span className="text-neutral-500 text-sm ml-2">({p.article})</span></span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="p-6 bg-emerald-500/5 border border-emerald-500/10 rounded-2xl min-h-[140px] flex flex-col justify-center">
                        {selectedProduct ? (
                            <>
                                <h3 className="text-sm uppercase tracking-wider text-emerald-500/60 font-bold mb-2">Selected Product</h3>
                                <div className="text-3xl font-bold text-emerald-100">{selectedProduct.name}</div>
                                <div className="mt-2 flex gap-4 text-emerald-400/60 text-sm font-mono">
                                    <span>SKU: {selectedProduct.article || 'N/A'}</span>
                                    <span>EXP: {selectedProduct.exp_date || 'N/A'} DAYS</span>
                                </div>
                            </>
                        ) : (
                            <div className="text-center text-neutral-500 italic">No product selected</div>
                        )}
                    </div>
                </div>

                {/* Weight Display Area */}
                <div className="mt-8 grid grid-cols-2 gap-4">
                    <div className="bg-black/30 border border-white/10 rounded-3xl p-8 text-center relative overflow-hidden group">
                        <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
                        <label className="text-xs uppercase tracking-widest text-neutral-500 font-bold">Net Weight</label>
                        <div className="text-7xl font-mono text-emerald-400 mt-2 font-light tracking-tighter">
                            {weight} <span className="text-2xl text-emerald-500/50">kg</span>
                        </div>
                    </div>
                    <div className="bg-black/30 border border-white/10 rounded-3xl p-8 text-center">
                        <label className="text-xs uppercase tracking-widest text-neutral-500 font-bold">Gross Weight</label>
                        <div className="text-7xl font-mono text-neutral-300 mt-2 font-light tracking-tighter">
                            0.000 <span className="text-2xl text-neutral-600">kg</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Control Panel */}
            <div className="col-span-4 space-y-4 flex flex-col">
                <button
                    onClick={handlePrint}
                    className="w-full py-8 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 transition-all rounded-3xl font-bold text-2xl shadow-[0_10px_40px_-10px_rgba(16,185,129,0.5)] flex items-center justify-center gap-3 border-t border-white/10"
                >
                    <Printer className="w-8 h-8" />
                    PRINT LABEL
                </button>

                <div className="grid grid-cols-2 gap-4">
                    <button className="py-6 bg-neutral-800/50 hover:bg-neutral-800 border border-white/5 hover:border-white/10 rounded-2xl font-semibold transition-all flex flex-col items-center gap-2 group">
                        <RefreshCw className="w-6 h-6 text-neutral-400 group-hover:text-white transition-colors" />
                        <span className="text-neutral-400 group-hover:text-white">Repeat</span>
                    </button>
                    <button className="py-6 bg-neutral-800/50 hover:bg-neutral-800 border border-white/5 hover:border-white/10 rounded-2xl font-semibold transition-all flex flex-col items-center gap-2 group">
                        <Box className="w-6 h-6 text-neutral-400 group-hover:text-white transition-colors" />
                        <span className="text-neutral-400 group-hover:text-white">Close Box</span>
                    </button>
                </div>

                <div className="mt-auto p-6 bg-neutral-900/50 border border-white/5 rounded-3xl backdrop-blur">
                    <h3 className="text-sm font-semibold mb-4 text-white/60">Session Statistics</h3>
                    <div className="space-y-3">
                        <div className="flex justify-between text-sm py-2 border-b border-white/5">
                            <span className="text-neutral-500">Total Weight:</span>
                            <span className="font-mono text-emerald-400">12.450 kg</span>
                        </div>
                        <div className="flex justify-between text-sm py-2 border-b border-white/5">
                            <span className="text-neutral-500">Labels Printed:</span>
                            <span className="font-mono text-white">26</span>
                        </div>
                        <div className="flex justify-between text-sm py-2">
                            <span className="text-neutral-500">Box Status:</span>
                            <span className="font-mono text-amber-400">4 / 10 pack</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default WeighingStation;
