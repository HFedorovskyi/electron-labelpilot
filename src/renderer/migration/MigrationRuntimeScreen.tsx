import { useEffect, useState } from 'react';
import { CheckCircle2, FolderOpen, LoaderCircle, Power, Radio, TerminalSquare } from 'lucide-react';
import type { DesktopBridge } from '../../shared/desktopBridge';
import {
    getTauriIngressSummary,
    getTauriNetworkSummary,
    getTauriPrinterGeneratorSummary,
    getTauriPrinterTransportSummary,
    getTauriRuntimeSummary,
    getTauriScaleSummary,
    openTauriLogsFolder,
    writeTauriRuntimeLog,
    type TauriIngressSummary,
    type TauriNetworkSummary,
    type TauriPrinterGeneratorSummary,
    type TauriPrinterTransportSummary,
    type TauriRuntimeSummary,
    type TauriScaleSummary,
} from '../platform/tauriBridge';
import './migration.css';

interface MigrationRuntimeScreenProps {
    bridge: DesktopBridge;
}

interface PersistedChecks {
    scale: boolean;
    numbering: boolean;
    printer: boolean;
    identity: 'loaded' | 'not-configured';
}

interface OperationalChecks {
    totalUnits: number;
    totalBoxes: number;
    unitsInBox: number;
    boxesInPallet: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readServerStatus(value: unknown): 'connected' | 'disconnected' | undefined {
    const candidate = isRecord(value) ? value.status : value;
    return candidate === 'connected' || candidate === 'disconnected' ? candidate : undefined;
}

export default function MigrationRuntimeScreen({ bridge }: MigrationRuntimeScreenProps) {
    const [version, setVersion] = useState<string>();
    const [summary, setSummary] = useState<TauriRuntimeSummary>();
    const [network, setNetwork] = useState<TauriNetworkSummary>();
    const [ingress, setIngress] = useState<TauriIngressSummary>();
    const [scaleRuntime, setScaleRuntime] = useState<TauriScaleSummary>();
    const [printerTransport, setPrinterTransport] = useState<TauriPrinterTransportSummary>();
    const [printerGenerator, setPrinterGenerator] = useState<TauriPrinterGeneratorSummary>();
    const [serverStatus, setServerStatus] = useState<'connected' | 'disconnected'>('disconnected');
    const [checks, setChecks] = useState<PersistedChecks>();
    const [operational, setOperational] = useState<OperationalChecks>();
    const [status, setStatus] = useState('Инициализация Rust runtime…');
    const [busy, setBusy] = useState(true);

    useEffect(() => {
        let active = true;
        const unsubscribe = bridge.on('server-status-updated', (...values) => {
            const nextStatus = readServerStatus(values[0]);
            if (active && nextStatus) setServerStatus(nextStatus);
        });
        bridge.send('renderer-ready');

        void Promise.all([
            bridge.invoke<string>('updater:get-version'),
            getTauriRuntimeSummary(),
            getTauriNetworkSummary(),
            getTauriIngressSummary(),
            getTauriScaleSummary(),
            getTauriPrinterTransportSummary(),
            getTauriPrinterGeneratorSummary(),
            bridge.invoke<string>('get-server-status'),
            bridge.invoke<unknown>('get-scale-config'),
            bridge.invoke<unknown>('get-numbering-config'),
            bridge.invoke<unknown>('get-printer-config'),
            bridge.invoke<unknown>('get-identity'),
            bridge.invoke<unknown>('get-latest-counters'),
        ]).then(([runtimeVersion, runtimeSummary, networkSummary, ingressSummary, scaleSummary, printerSummary, generatorSummary, currentServerStatus, scale, numbering, printer, identity, counters]) => {
            if (!isRecord(scale) || !isRecord(numbering) || !isRecord(printer)) {
                throw new Error('Rust storage вернул некорректную конфигурацию');
            }
            if (!isRecord(counters)) {
                throw new Error('Операционный SQLite вернул некорректные счётчики');
            }
            if (!networkSummary.workerRunning) {
                throw new Error('Фоновый сетевой worker не запущен');
            }
            if (!ingressSummary.workerRunning) {
                throw new Error('HTTP-вход синхронизации не запущен');
            }
            if (!active) return;
            setVersion(runtimeVersion);
            setSummary(runtimeSummary);
            setNetwork(networkSummary);
            setIngress(ingressSummary);
            setScaleRuntime(scaleSummary);
            setPrinterTransport(printerSummary);
            setPrinterGenerator(generatorSummary);
            const initialStatus = readServerStatus(currentServerStatus);
            if (initialStatus) setServerStatus(initialStatus);
            setChecks({
                scale: true,
                numbering: true,
                printer: true,
                identity: isRecord(identity) ? 'loaded' : 'not-configured',
            });
            setOperational({
                totalUnits: Number(counters.totalUnits ?? 0),
                totalBoxes: Number(counters.totalBoxes ?? 0),
                unitsInBox: Number(counters.unitsInBox ?? 0),
                boxesInPallet: Number(counters.boxesInPallet ?? 0),
            });
            setStatus('Rust storage, SQLite, scale worker, сеть, HTTP-вход и TCP-печать готовы');
            void writeTauriRuntimeLog(
                `Runtime diagnostics passed: network=${networkSummary.workerRunning} printerWorkers=${printerSummary.workerCount} generated=${generatorSummary.generatedJobs} status=${currentServerStatus}`,
            ).catch(error => console.error('[MigrationRuntime] diagnostics log:', error));
        }).catch(error => {
            if (!active) return;
            setStatus(error instanceof Error ? error.message : String(error));
        }).finally(() => {
            if (active) setBusy(false);
        });

        return () => {
            active = false;
            unsubscribe();
        };
    }, [bridge]);

    const openLogs = async () => {
        setBusy(true);
        try {
            const path = await openTauriLogsFolder();
            setStatus(`Открыт каталог: ${path}`);
        } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    };

    return (
        <main className="migration-shell">
            <section className="migration-card" aria-labelledby="migration-title">
                <div className="migration-heading">
                    <div className="migration-icon"><TerminalSquare size={34} /></div>
                    <div>
                        <p className="migration-eyebrow">Параллельная оболочка</p>
                        <h1 id="migration-title">LabelPilot на Rust / Tauri</h1>
                        <p>Архивный установщик 1.3.x сохранён как rollback. Tauri/Rust ведёт SQLite-цикл и единый Serial/TCP worker промышленных весов.</p>
                    </div>
                </div>

                <div className="migration-status" role="status">
                    {busy ? <LoaderCircle className="migration-spin" size={24} /> : <CheckCircle2 size={24} />}
                    <span>{status}</span>
                </div>

                <div className="migration-grid">
                    <article><strong>{version ?? '—'}</strong><span>Версия</span></article>
                    <article><strong>{summary?.invokeChannels ?? '—'}</strong><span>Invoke</span></article>
                    <article><strong>{summary?.sendChannels ?? '—'}</strong><span>Send</span></article>
                    <article><strong>{summary?.eventChannels ?? '—'}</strong><span>Events</span></article>
                    <article className={serverStatus === 'connected' ? 'migration-online' : ''}>
                        <strong><Radio size={28} /> {serverStatus === 'connected' ? 'Online' : 'Offline'}</strong>
                        <span>Сервер</span>
                    </article>
                </div>

                <div className="migration-section migration-split">
                    <div>
                        <h2>Persisted storage</h2>
                        <div className="migration-tags migration-storage">
                            <span>{checks?.scale ? '✓' : '…'} Весы</span>
                            <span>{checks?.numbering ? '✓' : '…'} Нумерация</span>
                            <span>{checks?.printer ? '✓' : '…'} Принтеры</span>
                            <span>{checks?.identity === 'loaded' ? '✓ Identity' : '○ Identity не настроен'}</span>
                        </div>
                    </div>
                    <div>
                        <h2>Сеть Rust</h2>
                        <div className="migration-tags migration-network">
                            <span>{network?.workerRunning ? '✓' : '…'} 1 worker</span>
                            <span>HTTP {network?.httpTimeoutMs ?? '—'} мс</span>
                            <span>UDP {network?.discoveryIntervalMs ?? '—'} мс</span>
                            <span>≤ {network ? network.discoveryDatagramLimit / 1024 : '—'} КиБ</span>
                        </div>
                    </div>
                    <div>
                        <h2>Вход сервера</h2>
                        <div className="migration-tags migration-ingress">
                            <span>{ingress?.workerRunning ? '✓' : '…'} {ingress?.bindAddress ?? ':5556'}</span>
                            <span>Sync ≤ {ingress ? ingress.syncBodyLimit / 1024 / 1024 : '—'} МиБ</span>
                            <span>Job ≤ {ingress ? ingress.printJobBodyLimit / 1024 / 1024 : '—'} МиБ</span>
                            <span>{ingress?.completedRequests ?? 0} запросов</span>
                        </div>
                    </div>
                    <div>
                        <h2>Весы Rust</h2>
                        <div className="migration-tags migration-scale">
                            <span>{scaleRuntime?.workerRunning ? '✓' : '…'} 1 worker</span>
                            <span>{scaleRuntime?.status ?? '—'}</span>
                            <span>{scaleRuntime?.protocolId ?? '—'}</span>
                            <span>{scaleRuntime?.emittedReadings ?? 0} / {scaleRuntime?.droppedReadings ?? 0}</span>
                        </div>
                    </div>
                    <div>
                        <h2>Операционный SQLite</h2>
                        <div className="migration-tags migration-operational">
                            <span>✓ 1 persistent connection</span>
                            <span>{operational?.totalUnits ?? '—'} упаковок</span>
                            <span>{operational?.totalBoxes ?? '—'} коробов</span>
                            <span>{operational?.unitsInBox ?? '—'} / {operational?.boxesInPallet ?? '—'} текущие</span>
                        </div>
                    </div>
                    <div>
                        <h2>Принтер TCP Rust</h2>
                        <div className="migration-tags migration-printer">
                            <span>{printerTransport?.workerCount ?? 0} / {printerTransport?.maxWorkers ?? '—'} workers</span>
                            <span>{printerTransport?.queuedNow ?? 0} / {printerTransport?.queueCapacityPerPrinter ?? '—'} очередь</span>
                            <span>{printerTransport?.completedJobs ?? 0} / {printerTransport?.failedJobs ?? 0} jobs</span>
                            <span>TCP {printerTransport?.tcpJobs ?? 0} · COM {printerTransport?.serialJobs ?? 0} · spooler {printerTransport?.spoolerJobs ?? 0}</span>
                            <span>GDI {printerTransport?.driverBitmapJobs ?? 0}</span>
                            <span>{printerTransport ? Math.round(printerTransport.bytesSent / 1024) : 0} КиБ TCP</span>
                            <span>{printerGenerator?.generatedJobs ?? 0} native</span>
                            <span>{printerGenerator?.fallbackJobs ?? 0} fallback</span>
                            <span>{printerGenerator ? Math.round(printerGenerator.fallbackBytesGenerated / 1024) : 0} КиБ fallback</span>
                            <span>≤ {printerGenerator?.maxElements ?? '—'} элементов</span>
                        </div>
                    </div>
                </div>

                <details className="migration-section migration-commands">
                    <summary>Мигрированные команды: {summary?.migratedCommands.length ?? 0}</summary>
                    <div className="migration-tags">
                        {(summary?.migratedCommands ?? []).map(command => <span key={command}>{command}</span>)}
                    </div>
                </details>

                <div className="migration-actions">
                    <button type="button" onClick={openLogs} disabled={busy}>
                        <FolderOpen size={22} /> Открыть логи
                    </button>
                    <button type="button" className="migration-danger" onClick={() => bridge.send('quit-app')}>
                        <Power size={22} /> Закрыть runtime
                    </button>
                </div>
            </section>
        </main>
    );
}
