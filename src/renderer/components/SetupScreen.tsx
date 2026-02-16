import React, { useState } from 'react';
import { useTranslation } from '../i18n';

interface SetupScreenProps {
    onIdentityLoaded: (identity: any) => void;
}

const SetupScreen: React.FC<SetupScreenProps> = ({ onIdentityLoaded }) => {
    const { t } = useTranslation();
    const [importing, setImporting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleImport = async () => {
        setImporting(true);
        setError(null);
        try {
            const result = await window.electron.invoke('import-identity-file');
            if (result.success && result.identity) {
                onIdentityLoaded(result.identity);
            } else {
                setError(result.message || 'Import failed');
            }
        } catch (err: any) {
            setError(err.message || 'Unknown error');
        } finally {
            setImporting(false);
        }
    };

    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-neutral-950 text-white p-6 relative overflow-hidden">
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-emerald-900/20 via-neutral-950 to-neutral-950 pointer-events-none" />

            <div
                className="z-10 bg-neutral-900/50 backdrop-blur-xl p-8 rounded-3xl border border-white/10 shadow-2xl max-w-md w-full text-center animate-in fade-in slide-in-from-bottom-4 duration-700"
            >
                <div className="mb-8 flex justify-center">
                    <div className="w-20 h-20 bg-emerald-500/10 rounded-2xl flex items-center justify-center border border-emerald-500/20 shadow-[0_0_30px_rgba(16,185,129,0.15)]">
                        <svg className="w-10 h-10 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                    </div>
                </div>

                <h1 className="text-3xl font-bold bg-gradient-to-r from-white to-neutral-400 bg-clip-text text-transparent mb-3">
                    {t('setup.welcome') || 'Station Setup'}
                </h1>
                <p className="text-neutral-400 mb-8">
                    {t('setup.instruction') || 'Please insert the USB drive with the station identity file to proceed.'}
                </p>

                {error && (
                    <div
                        className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-200 text-sm animate-in fade-in slide-in-from-top-2"
                    >
                        {error}
                    </div>
                )}

                <button
                    onClick={handleImport}
                    disabled={importing}
                    className="w-full py-4 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-medium transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_0_20px_rgba(16,185,129,0.3)] hover:shadow-[0_0_30px_rgba(16,185,129,0.5)] flex items-center justify-center group"
                >
                    {importing ? (
                        <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin mr-2" />
                    ) : (
                        <svg className="w-5 h-5 mr-2 group-hover:scale-110 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                        </svg>
                    )}
                    {importing ? (t('setup.importing') || 'Importing...') : (t('setup.importButton') || 'Import Identity')}
                </button>
            </div>
        </div>
    );
};

export default SetupScreen;
