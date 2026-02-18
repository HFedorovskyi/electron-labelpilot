import { useState, useEffect } from 'react';
import { Download, RefreshCw, RotateCcw, HardDrive, CheckCircle, AlertTriangle, XCircle } from 'lucide-react';

interface BackupInfo {
    id: string;
    version: string;
    createdAt: string;
    sizeBytes: number;
}

interface UpdateCheckResult {
    available: boolean;
    version?: string;
    releaseNotes?: string;
    compatible?: boolean;
    compatibilityReason?: string;
}

type UpdatePhase = 'idle' | 'checking' | 'available' | 'incompatible' | 'downloading' | 'ready' | 'up-to-date' | 'error';

const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatDate = (iso: string) => {
    try {
        return new Date(iso).toLocaleString('ru-RU', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });
    } catch {
        return iso;
    }
};

const UpdateSettings = () => {
    const [currentVersion, setCurrentVersion] = useState<string>('...');
    const [phase, setPhase] = useState<UpdatePhase>('idle');
    const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
    const [progress, setProgress] = useState<number>(0);
    const [errorMsg, setErrorMsg] = useState<string>('');
    const [backups, setBackups] = useState<BackupInfo[]>([]);
    const [loadingBackups, setLoadingBackups] = useState(false);
    const [rollbackId, setRollbackId] = useState<string>('');
    const [rollingBack, setRollingBack] = useState(false);
    const [rollbackMsg, setRollbackMsg] = useState<string>('');

    useEffect(() => {
        window.electron.invoke('updater:get-version').then(setCurrentVersion).catch(() => { });
        loadBackups();

        // Listen for updater events from main process
        const removeProgress = window.electron.on('updater:progress', (data: any) => {
            setProgress(Math.round(data.percent));
        });
        const removeDownloaded = window.electron.on('updater:downloaded', () => {
            setPhase('ready');
        });
        const removeError = window.electron.on('updater:error', (data: any) => {
            setPhase('error');
            setErrorMsg(data.message);
        });

        return () => {
            removeProgress();
            removeDownloaded();
            removeError();
        };
    }, []);

    const loadBackups = async () => {
        setLoadingBackups(true);
        try {
            const list = await window.electron.invoke('updater:list-backups');
            setBackups(list || []);
        } catch {
            setBackups([]);
        } finally {
            setLoadingBackups(false);
        }
    };

    const handleCheck = async () => {
        setPhase('checking');
        setErrorMsg('');
        try {
            const result: UpdateCheckResult = await window.electron.invoke('updater:check');
            setUpdateInfo(result);
            if (!result.available) {
                setPhase('up-to-date');
            } else if (result.compatible === false) {
                setPhase('incompatible');
            } else {
                setPhase('available');
            }
        } catch (err: any) {
            setPhase('error');
            setErrorMsg(err.message || 'Ошибка проверки обновлений');
        }
    };

    const handleDownload = async () => {
        setPhase('downloading');
        setProgress(0);
        try {
            await window.electron.invoke('updater:download');
        } catch (err: any) {
            setPhase('error');
            setErrorMsg(err.message || 'Ошибка загрузки');
        }
    };

    const handleInstall = async () => {
        await window.electron.invoke('updater:install');
    };

    const handleOfflineInstall = async () => {
        const res = await window.electron.invoke('updater:install-offline');
        if (!res.success) {
            setPhase('error');
            setErrorMsg(res.message);
        }
    };

    const handleRollback = async () => {
        if (!rollbackId) return;
        setRollingBack(true);
        setRollbackMsg('');
        try {
            const res = await window.electron.invoke('updater:rollback', rollbackId);
            setRollbackMsg(res.message);
            if (res.success) loadBackups();
        } catch (err: any) {
            setRollbackMsg(err.message);
        } finally {
            setRollingBack(false);
        }
    };

    const phaseIcon = () => {
        switch (phase) {
            case 'up-to-date': return <CheckCircle className="w-5 h-5 text-emerald-400" />;
            case 'available': return <Download className="w-5 h-5 text-blue-400" />;
            case 'incompatible': return <AlertTriangle className="w-5 h-5 text-amber-400" />;
            case 'error': return <XCircle className="w-5 h-5 text-red-400" />;
            case 'ready': return <CheckCircle className="w-5 h-5 text-emerald-400" />;
            default: return null;
        }
    };

    const phaseText = () => {
        switch (phase) {
            case 'idle': return 'Нажмите «Проверить» для поиска обновлений';
            case 'checking': return 'Проверка обновлений...';
            case 'up-to-date': return 'Установлена последняя версия';
            case 'available': return `Доступна версия ${updateInfo?.version}`;
            case 'incompatible': return `Версия ${updateInfo?.version} несовместима с текущим сервером`;
            case 'downloading': return `Загрузка... ${progress}%`;
            case 'ready': return `Версия ${updateInfo?.version} загружена. Готова к установке.`;
            case 'error': return `Ошибка: ${errorMsg}`;
        }
    };

    return (
        <div className="p-6 bg-white/5 border border-white/10 rounded-2xl space-y-6">
            <h2 className="text-xl font-semibold flex items-center gap-3 text-sky-400">
                <Download className="w-6 h-6" />
                Обновления приложения
            </h2>

            {/* Version & Status */}
            <div className="flex items-center justify-between p-4 bg-black/20 rounded-xl border border-white/5">
                <div>
                    <div className="text-sm text-neutral-400">Текущая версия</div>
                    <div className="text-2xl font-mono font-bold text-white">v{currentVersion}</div>
                </div>
                <div className="flex items-center gap-2 text-sm">
                    {phaseIcon()}
                    <span className={`${phase === 'error' ? 'text-red-400' : phase === 'incompatible' ? 'text-amber-400' : 'text-neutral-300'}`}>
                        {phaseText()}
                    </span>
                </div>
            </div>

            {/* Incompatibility warning */}
            {phase === 'incompatible' && updateInfo?.compatibilityReason && (
                <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl text-amber-300 text-sm">
                    {updateInfo.compatibilityReason}
                </div>
            )}

            {/* Progress bar */}
            {phase === 'downloading' && (
                <div className="w-full bg-neutral-800 rounded-full h-2 overflow-hidden">
                    <div
                        className="h-2 bg-sky-500 rounded-full transition-all duration-300"
                        style={{ width: `${progress}%` }}
                    />
                </div>
            )}

            {/* Action buttons */}
            <div className="flex flex-wrap gap-3">
                <button
                    onClick={handleCheck}
                    disabled={phase === 'checking' || phase === 'downloading'}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    <RefreshCw className={`w-4 h-4 ${phase === 'checking' ? 'animate-spin' : ''}`} />
                    Проверить обновления
                </button>

                {phase === 'available' && (
                    <button
                        onClick={handleDownload}
                        className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-medium transition-all"
                    >
                        <Download className="w-4 h-4" />
                        Скачать v{updateInfo?.version}
                    </button>
                )}

                {phase === 'ready' && (
                    <button
                        onClick={handleInstall}
                        className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-medium transition-all animate-pulse"
                    >
                        <CheckCircle className="w-4 h-4" />
                        Установить и перезапустить
                    </button>
                )}

                <button
                    onClick={handleOfflineInstall}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-neutral-700 hover:bg-neutral-600 border border-white/10 text-white font-medium transition-all"
                >
                    <HardDrive className="w-4 h-4" />
                    Установить с USB (.exe)
                </button>
            </div>

            {/* Backups & Rollback */}
            <div className="pt-4 border-t border-white/5">
                <div className="flex items-center justify-between mb-3">
                    <h3 className="text-base font-semibold text-neutral-300 flex items-center gap-2">
                        <RotateCcw className="w-4 h-4 text-neutral-400" />
                        Резервные копии (откат)
                    </h3>
                    <button
                        onClick={loadBackups}
                        className="text-xs text-neutral-400 hover:text-white flex items-center gap-1 transition-colors"
                    >
                        <RefreshCw className={`w-3 h-3 ${loadingBackups ? 'animate-spin' : ''}`} />
                        Обновить
                    </button>
                </div>

                {backups.length === 0 ? (
                    <p className="text-sm text-neutral-500">Резервных копий нет</p>
                ) : (
                    <div className="space-y-2 mb-4">
                        {backups.map(b => (
                            <label
                                key={b.id}
                                className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all ${rollbackId === b.id
                                    ? 'bg-sky-500/10 border-sky-500/30'
                                    : 'bg-black/20 border-white/5 hover:border-white/10'
                                    }`}
                            >
                                <input
                                    type="radio"
                                    name="backup"
                                    value={b.id}
                                    checked={rollbackId === b.id}
                                    onChange={() => setRollbackId(b.id)}
                                    className="accent-sky-500"
                                />
                                <div className="flex-1 min-w-0">
                                    <div className="font-mono text-sm text-white">v{b.version}</div>
                                    <div className="text-xs text-neutral-400">{formatDate(b.createdAt)}</div>
                                </div>
                                <div className="text-xs text-neutral-500">{formatBytes(b.sizeBytes)}</div>
                            </label>
                        ))}
                    </div>
                )}

                {backups.length > 0 && (
                    <div className="flex items-center gap-3">
                        <button
                            onClick={handleRollback}
                            disabled={!rollbackId || rollingBack}
                            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-amber-600/20 hover:bg-amber-600 border border-amber-600/30 hover:border-amber-600 text-amber-400 hover:text-white font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            <RotateCcw className={`w-4 h-4 ${rollingBack ? 'animate-spin' : ''}`} />
                            Откатить на выбранную копию
                        </button>
                        {rollbackMsg && (
                            <span className="text-sm text-neutral-300">{rollbackMsg}</span>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

export default UpdateSettings;
