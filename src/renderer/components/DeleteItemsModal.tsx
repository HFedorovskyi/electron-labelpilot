import React, { useEffect, useState } from 'react';
import { X, Trash2, Box, Layers, RefreshCw } from 'lucide-react';
import { useTranslation } from '../i18n';

interface DeleteItemsModalProps {
    isOpen: boolean;
    onClose: () => void;
    onDeleted: () => void; // Callback to refresh parent state
}

const DeleteItemsModal: React.FC<DeleteItemsModalProps> = ({ isOpen, onClose, onDeleted }) => {
    const { t } = useTranslation();
    const [activeTab, setActiveTab] = useState<'packs' | 'boxes'>('packs');
    const [data, setData] = useState<any>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // State for custom confirmation modal
    const [confirmModal, setConfirmModal] = useState<{
        isOpen: boolean;
        type: 'pack' | 'box';
        id: number | null;
        message: string;
    }>({
        isOpen: false,
        type: 'pack',
        id: null,
        message: ''
    });

    const loadData = async () => {
        setLoading(true);
        setError(null);
        try {
            const content = await window.electron.invoke('get-open-pallet-content');
            setData(content);
        } catch (err: any) {
            console.error("Error loading deletion data:", err);
            let msg = err.message || t('delete.errorLoad');
            if (msg.includes('No handler registered')) {
                msg = "Internal Error: IPC Handler missing. Please restart app.";
            }
            setError(msg);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (isOpen) {
            loadData();
        }
    }, [isOpen]);

    const handleDeletePackClick = (packId: number) => {
        setConfirmModal({
            isOpen: true,
            type: 'pack',
            id: packId,
            message: t('delete.confirmPack')
        });
    };

    const handleDeleteBoxClick = (boxId: number) => {
        setConfirmModal({
            isOpen: true,
            type: 'box',
            id: boxId,
            message: t('delete.confirmBox')
        });
    };

    const confirmDelete = async () => {
        if (!confirmModal.id) return;

        try {
            if (confirmModal.type === 'pack') {
                await window.electron.invoke('delete-pack', confirmModal.id);
            } else {
                await window.electron.invoke('delete-box', confirmModal.id);
            }
            await loadData();
            onDeleted();
            setConfirmModal({ ...confirmModal, isOpen: false });
        } catch (err: any) {
            setConfirmModal({ ...confirmModal, isOpen: false }); // Close confirm first
            alert((confirmModal.type === 'pack' ? t('delete.errorDeletePack') : t('delete.errorDeleteBox')) + err.message);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-neutral-900 border border-neutral-800 rounded-2xl w-full max-w-4xl h-[80vh] flex flex-col shadow-2xl relative overflow-hidden">

                {/* Header */}
                <div className="p-6 border-b border-neutral-800 flex justify-between items-center bg-neutral-900/50">
                    <h2 className="text-2xl font-semibold text-white flex items-center gap-3">
                        <Trash2 className="text-red-500" />
                        {t('delete.title')}
                    </h2>
                    <button
                        onClick={onClose}
                        className="p-2 hover:bg-neutral-800 rounded-full transition-colors"
                    >
                        <X size={28} className="text-neutral-400 hover:text-white" />
                    </button>
                </div>

                {/* Tabs */}
                <div className="flex border-b border-neutral-800 bg-neutral-900/30">
                    <button
                        onClick={() => setActiveTab('packs')}
                        className={`flex-1 p-4 text-lg font-medium flex items-center justify-center gap-2 transition-colors relative ${activeTab === 'packs'
                                ? 'text-white bg-neutral-800/50'
                                : 'text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800/30'
                            }`}
                    >
                        <Box size={20} />
                        {t('delete.currentBoxTab')}
                        {activeTab === 'packs' && (
                            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]" />
                        )}
                    </button>
                    <button
                        onClick={() => setActiveTab('boxes')}
                        className={`flex-1 p-4 text-lg font-medium flex items-center justify-center gap-2 transition-colors relative ${activeTab === 'boxes'
                                ? 'text-white bg-neutral-800/50'
                                : 'text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800/30'
                            }`}
                    >
                        <Layers size={20} />
                        {t('delete.currentPalletTab')}
                        {activeTab === 'boxes' && (
                            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-500 shadow-[0_0_10px_rgba(99,102,241,0.5)]" />
                        )}
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-auto p-4 bg-neutral-900/30">
                    {loading ? (
                        <div className="flex items-center justify-center h-full text-neutral-500 gap-2">
                            <RefreshCw className="animate-spin" /> {t('delete.loading')}
                        </div>
                    ) : error ? (
                        <div className="flex items-center justify-center h-full text-red-400">
                            {error}
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {activeTab === 'packs' && (
                                <>
                                    {!data?.openBox ? (
                                        <div className="text-center p-10 text-neutral-500">
                                            {t('delete.noOpenBox')}
                                        </div>
                                    ) : (
                                        <>
                                            <div className="bg-neutral-800/50 p-3 rounded-lg flex justify-between items-center mb-4 border border-neutral-700">
                                                <div className="text-neutral-400">{t('delete.currentBox')} <span className="text-white font-mono text-xl ml-2">{data.openBox.number}</span></div>
                                                <div className="text-sm text-neutral-500">{t('delete.totalPacks')} {data.packsInCurrentBox?.length || 0}</div>
                                            </div>
                                            <div className="space-y-2">
                                                {data.packsInCurrentBox?.map((pack: any) => (
                                                    <div
                                                        key={pack.id}
                                                        className={`flex items-center justify-between p-4 rounded-xl border transition-all ${pack.status === 'Deleted'
                                                                ? 'bg-red-900/10 border-red-900/30 opacity-60'
                                                                : 'bg-neutral-800 border-neutral-700 hover:border-neutral-600'
                                                            }`}
                                                    >
                                                        <div className="flex flex-col">
                                                            <div className="flex items-center gap-3">
                                                                <span className="font-mono text-xl font-medium">{pack.number}</span>
                                                                {pack.status === 'Deleted' && (
                                                                    <span className="px-2 py-0.5 text-xs bg-red-500/20 text-red-400 rounded-full border border-red-500/20">{t('delete.deleted')}</span>
                                                                )}
                                                            </div>
                                                            <div className="text-sm text-neutral-400 mt-1">
                                                                {t('delete.weight')} <span className="text-white">{pack.weight_netto.toFixed(3)} {t('ws.kg')}</span>
                                                            </div>
                                                        </div>

                                                        {pack.status !== 'Deleted' && (
                                                            <button
                                                                onClick={() => handleDeletePackClick(pack.id)}
                                                                className="p-3 bg-red-500/10 hover:bg-red-500/20 text-red-500 rounded-lg border border-red-500/20 transition-colors"
                                                            >
                                                                <Trash2 size={24} />
                                                            </button>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        </>
                                    )}
                                </>
                            )}

                            {activeTab === 'boxes' && (
                                <>
                                    {!data?.pallet ? (
                                        <div className="text-center p-10 text-neutral-500">
                                            {t('delete.noOpenPallet')}
                                        </div>
                                    ) : (
                                        <>
                                            <div className="bg-neutral-800/50 p-3 rounded-lg flex justify-between items-center mb-4 border border-neutral-700">
                                                <div className="text-neutral-400">{t('delete.currentPallet')} <span className="text-white font-mono text-xl ml-2">{data.pallet.number}</span></div>
                                                <div className="text-sm text-neutral-500">{t('delete.totalBoxes')} {data.boxesInPallet?.length || 0}</div>
                                            </div>
                                            <div className="space-y-2">
                                                {data.boxesInPallet?.map((box: any) => (
                                                    <div
                                                        key={box.id}
                                                        className={`flex items-center justify-between p-4 rounded-xl border transition-all ${box.status === 'Deleted'
                                                                ? 'bg-red-900/10 border-red-900/30 opacity-60'
                                                                : box.status === 'Open'
                                                                    ? 'bg-emerald-900/10 border-emerald-900/30'
                                                                    : 'bg-neutral-800 border-neutral-700 hover:border-neutral-600'
                                                            }`}
                                                    >
                                                        <div className="flex flex-col">
                                                            <div className="flex items-center gap-3">
                                                                <span className="font-mono text-xl font-medium">{box.number}</span>
                                                                {box.status === 'Deleted' ? (
                                                                    <span className="px-2 py-0.5 text-xs bg-red-500/20 text-red-400 rounded-full border border-red-500/20">{t('delete.deleted')}</span>
                                                                ) : box.status === 'Open' ? (
                                                                    <span className="px-2 py-0.5 text-xs bg-emerald-500/20 text-emerald-400 rounded-full border border-emerald-500/20">{t('delete.open')}</span>
                                                                ) : (
                                                                    <span className="px-2 py-0.5 text-xs bg-neutral-700 text-neutral-400 rounded-full">{t('delete.closed')}</span>
                                                                )}
                                                            </div>
                                                            <div className="text-sm text-neutral-400 mt-1">
                                                                {t('delete.weight')} <span className="text-white">{(box.weight_netto || 0).toFixed(3)} {t('ws.kg')}</span>
                                                            </div>
                                                        </div>

                                                        {box.status !== 'Deleted' && (
                                                            <button
                                                                onClick={() => handleDeleteBoxClick(box.id)}
                                                                className="p-3 bg-red-500/10 hover:bg-red-500/20 text-red-500 rounded-lg border border-red-500/20 transition-colors"
                                                            >
                                                                <Trash2 size={24} />
                                                            </button>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        </>
                                    )}
                                </>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* Confirmation Modal */}
            {confirmModal.isOpen && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 backdrop-blur-md p-4 animate-in fade-in duration-200">
                    <div className="bg-neutral-900 border border-neutral-700 rounded-2xl w-full max-w-md p-8 shadow-2xl flex flex-col items-center">
                        <div className="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center mb-6 border border-red-500/20">
                            <Trash2 size={32} className="text-red-500" />
                        </div>
                        <h3 className="text-xl font-bold text-white mb-2 text-center">{t('delete.title')}?</h3>
                        <p className="text-neutral-400 text-center mb-8">
                            {confirmModal.message}
                        </p>
                        <div className="flex gap-4 w-full">
                            <button
                                onClick={() => setConfirmModal({ ...confirmModal, isOpen: false })}
                                className="flex-1 py-4 rounded-xl bg-neutral-800 text-white font-semibold hover:bg-neutral-700 transition-colors"
                            >
                                {t('ws.cancel')}
                            </button>
                            <button
                                onClick={confirmDelete}
                                className="flex-1 py-4 rounded-xl bg-red-600 text-white font-bold hover:bg-red-500 shadow-lg shadow-red-900/20 transition-all active:scale-[0.98]"
                            >
                                {t('ws.delete')}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default DeleteItemsModal;
