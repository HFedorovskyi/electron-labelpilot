import { useState, useEffect } from 'react';
import { Database, RefreshCw, Table as TableIcon, Search } from 'lucide-react';
import { useTranslation } from '../i18n';

const DatabaseViewer = () => {
    const { t } = useTranslation();
    const [tables, setTables] = useState<string[]>([]);
    const [selectedTable, setSelectedTable] = useState<string | null>(null);
    const [tableData, setTableData] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');

    useEffect(() => {
        loadTables();
    }, []);

    useEffect(() => {
        if (selectedTable) {
            loadTableData(selectedTable);
        }
    }, [selectedTable]);

    const loadTables = async () => {
        try {
            const result = await window.electron.invoke('get-tables');
            if (Array.isArray(result)) {
                setTables(result.map((t: any) => t.name));
            }
        } catch (err) {
            console.error('Failed to load tables:', err);
        }
    };

    const loadTableData = async (tableName: string) => {
        setLoading(true);
        try {
            const data = await window.electron.invoke('get-table-data', tableName);
            setTableData(data);
        } catch (err) {
            console.error(`Failed to load data for ${tableName}:`, err);
        } finally {
            setLoading(false);
        }
    };

    const filteredData = tableData.filter(row =>
        JSON.stringify(row).toLowerCase().includes(searchTerm.toLowerCase())
    );

    const headers = tableData.length > 0 ? Object.keys(tableData[0]) : [];

    return (
        <div className="flex h-full bg-neutral-900/50 backdrop-blur rounded-3xl border border-white/5 overflow-hidden shadow-2xl">
            {/* Sidebar - Table List */}
            <div className="w-64 bg-black/20 border-r border-white/5 flex flex-col">
                <div className="p-4 border-b border-white/5 flex items-center gap-2 text-emerald-400">
                    <Database className="w-5 h-5" />
                    <h2 className="font-bold">{t('db.tables')}</h2>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-1">
                    {tables.map(table => (
                        <button
                            key={table}
                            onClick={() => setSelectedTable(table)}
                            className={`w-full text-left px-4 py-3 rounded-xl transition-all flex items-center gap-3 ${selectedTable === table
                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/20'
                                : 'text-neutral-400 hover:bg-white/5 hover:text-white'
                                }`}
                        >
                            <TableIcon className="w-4 h-4" />
                            <span className="font-medium truncate">{table}</span>
                        </button>
                    ))}
                </div>
            </div>

            {/* Main Content - Data Grid */}
            <div className="flex-1 flex flex-col min-w-0">
                {selectedTable ? (
                    <>
                        <div className="p-4 border-b border-white/5 flex justify-between items-center bg-white/5">
                            <div className="flex items-center gap-4">
                                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                                    <TableIcon className="w-5 h-5 text-neutral-400" />
                                    {selectedTable}
                                </h2>
                                <span className="text-neutral-500 text-sm bg-neutral-900 px-2 py-0.5 rounded-full border border-white/5">
                                    {tableData.length} {t('db.records')}
                                </span>
                            </div>

                            <div className="flex items-center gap-3">
                                <div className="relative">
                                    <Search className="w-4 h-4 text-neutral-500 absolute left-3 top-1/2 -translate-y-1/2" />
                                    <input
                                        type="text"
                                        placeholder={t('db.search')}
                                        value={searchTerm}
                                        onChange={(e) => setSearchTerm(e.target.value)}
                                        className="bg-neutral-900 border border-white/10 rounded-lg pl-9 pr-4 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500/50 w-64"
                                    />
                                </div>
                                <button
                                    onClick={() => loadTableData(selectedTable)}
                                    className="p-2 bg-neutral-800 hover:bg-neutral-700 rounded-lg text-white transition-colors"
                                    title="Reload Data"
                                >
                                    <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                                </button>
                            </div>
                        </div>

                        <div className="flex-1 overflow-auto relative bg-neutral-900/40">
                            {loading ? (
                                <div className="absolute inset-0 flex items-center justify-center">
                                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-500"></div>
                                </div>
                            ) : tableData.length === 0 ? (
                                <div className="flex flex-col items-center justify-center h-full text-neutral-500">
                                    <Database className="w-12 h-12 mb-4 opacity-20" />
                                    <p>No data in this table</p>
                                </div>
                            ) : (
                                <table className="w-full text-sm text-left">
                                    <thead className="text-xs text-neutral-400 uppercase bg-neutral-900/80 sticky top-0 z-10 backdrop-blur-sm">
                                        <tr>
                                            {headers.map(header => (
                                                <th key={header} className="px-6 py-3 font-medium whitespace-nowrap border-b border-white/5">
                                                    {header}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-white/5">
                                        {filteredData.map((row, idx) => (
                                            <tr key={idx} className="hover:bg-white/5 transition-colors">
                                                {headers.map(header => {
                                                    const val = row[header];
                                                    let displayVal = val;

                                                    // Simple heuristic to detect if string might be JSON
                                                    if (typeof val === 'string' && (val.startsWith('{') || val.startsWith('['))) {
                                                        try {
                                                            // Verify formatted JSON
                                                            const parsed = JSON.parse(val);
                                                            displayVal = (
                                                                <code className="text-[10px] font-mono text-emerald-400 block max-w-xs truncate" title={JSON.stringify(parsed, null, 2)}>
                                                                    {val}
                                                                </code>
                                                            );
                                                        } catch (e) { }
                                                    }

                                                    if (val === null) displayVal = <span className="text-neutral-600 italic">null</span>;

                                                    return (
                                                        <td key={`${idx}-${header}`} className="px-6 py-3 whitespace-nowrap text-neutral-300 max-w-xs truncate">
                                                            {displayVal}
                                                        </td>
                                                    );
                                                })}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    </>
                ) : (
                    <div className="flex flex-col items-center justify-center h-full text-neutral-500">
                        <Database className="w-16 h-16 mb-4 opacity-20" />
                        <p className="text-lg">{t('db.noTable')}</p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default DatabaseViewer;
