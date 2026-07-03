import { useEffect, useState, useRef, useMemo } from 'react';
import { Printer, RefreshCw, Box, AlertCircle, X, Hash, Layers, Calendar, Search, Trash2 } from 'lucide-react';
import { generateBarcode, type BarcodeData } from '../utils/barcodeGenerator';
import { printPalletSheet } from '../utils/palletPrint';
import { computeDocKey } from '../utils/docKey';
import { useTranslation } from '../i18n';
import NumericKeypad from './NumericKeypad';
import DeleteItemsModal from './DeleteItemsModal';
import DatePickerModal from './DatePickerModal';
import ProductSelectionModal from './ProductSelectionModal';
import { useSession } from './SessionProvider';

const WeighingStation = ({ activeTab }: { activeTab?: string }) => {
    const { t } = useTranslation();
    // Current operator (PIN-login layer) — used for the pallet-sheet operator_name.
    const { operator } = useSession();
    // --- STATE DECLARATIONS ---
    const [weight, setWeight] = useState<string>('0.000');
    const [status, setStatus] = useState<string>('disconnected');
    // Pack-printer readiness for the header indicator (set from warmup probe + real print outcomes).
    const [printerStatus, setPrinterStatus] = useState<'unknown' | 'ready' | 'unreachable' | 'unconfigured' | 'driver'>('unknown');
    // Transient "label sent" toast (manual print only) + last-printed record for the stats card.
    const [printToast, setPrintToast] = useState<string | null>(null);
    const [lastPrintInfo, setLastPrintInfo] = useState<{ label: string; time: string } | null>(null);
    const printToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [labelDoc, setLabelDoc] = useState<any>(null);
    const [labelDocKey, setLabelDocKey] = useState<string | null>(null);

    const [products, setProducts] = useState<any[]>([]);
    const [selectedProduct, setSelectedProduct] = useState<any | null>(null);
    const [isProductModalOpen, setIsProductModalOpen] = useState(false);
    const [alertMessage, setAlertMessage] = useState<string | null>(null);
    const [numberingConfig, setNumberingConfig] = useState<any>(null);

    const [containers, setContainers] = useState<any[]>([]);

    const [boxLabelDoc, setBoxLabelDoc] = useState<any>(null);
    const [boxLabelDocKey, setBoxLabelDocKey] = useState<string | null>(null);
    const [packBarcodeTemplate, setPackBarcodeTemplate] = useState<any>(null);
    const [boxBarcodeTemplate, setBoxBarcodeTemplate] = useState<any>(null);
    const [boxNetWeight, setBoxNetWeight] = useState(0);

    const [unitsInBox, setUnitsInBox] = useState(0);
    const [boxesInPallet, setBoxesInPallet] = useState(0);
    const [totalBoxes, setTotalBoxes] = useState(0);
    const [totalUnits, setTotalUnits] = useState(0);
    const [currentBoxId, setCurrentBoxId] = useState<number | null>(null);
    const [currentBoxNumber, setCurrentBoxNumber] = useState<string | null>(null);
    const [lastPrinted, setLastPrinted] = useState<{ doc: any, data: any } | null>(null);

    const [stationNumber, setStationNumber] = useState<string | null>(null);
    const [isStable, setIsStable] = useState(false);

    // Printer config (loaded from saved settings)
    const [printerConfig, setPrinterConfig] = useState<any>({
        packPrinter: '',
        boxPrinter: '',
        autoPrintOnStable: true
    });

    const [isReady, setIsReady] = useState(false);
    const [stableTrigger, setStableTrigger] = useState(0);

    const [batchNumber, setBatchNumber] = useState<string>('');
    const [isKeypadOpen, setIsKeypadOpen] = useState(false);
    const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
    const [labelingDate, setLabelingDate] = useState<Date>(new Date());
    const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);

    // Sync version counter — incremented on data-updated to force re-fetch of templates
    const [syncVersion, setSyncVersion] = useState(0);

    // Auto-print refs to prevent duplicate prints
    const autoPrintFiredRef = useRef(false);
    const isPrintingRef = useRef(false);
    const isPalletPrintingRef = useRef(false);
    const weightRef = useRef('0.000');
    // Latest active tab, readable inside the (mounted-once) scale-reading listener without a
    // stale closure. Lets this station skip weight state updates while it's hidden — all three
    // stations stay mounted, so without this each reading would re-render all three.
    const activeTabRef = useRef(activeTab);
    activeTabRef.current = activeTab;

    // --- EFFECTS ---
    useEffect(() => {
        const loadStationInfo = async () => {
            try {
                const info = await window.electron.invoke('get-station-info');
                if (info) {
                    if (info.station_number) setStationNumber(info.station_number);
                }
            } catch (e) {
                console.error('Failed to load station info', e);
            }
        };
        loadStationInfo();

        // Delay enabling auto-print to avoid firing on startup
        const readyTimer = setTimeout(() => { setIsReady(true); }, 1500);
        return () => clearTimeout(readyTimer);
    }, []);

    // Sync counters when selectedProduct changes or on mount
    useEffect(() => {
        const syncCountersWithProduct = async () => {
            try {
                const nomenclatureId = selectedProduct?.id;
                const latest = await window.electron.invoke('get-latest-counters', nomenclatureId);
                console.log('Latest Counters from DB (Product Sync):', latest);
                if (latest) {
                    // Global counters
                    if (latest.totalUnits !== undefined) setTotalUnits(latest.totalUnits);
                    if (latest.totalBoxes !== undefined) setTotalBoxes(latest.totalBoxes);
                    if (latest.boxesInPallet !== undefined) setBoxesInPallet(latest.boxesInPallet);

                    // Box-specific counters
                    if (latest.unitsInBox !== undefined) setUnitsInBox(latest.unitsInBox);
                    if (latest.boxNetWeight !== undefined) setBoxNetWeight(latest.boxNetWeight);
                    if (latest.currentBoxId !== undefined) setCurrentBoxId(latest.currentBoxId);
                    if (latest.currentBoxNumber !== undefined) setCurrentBoxNumber(latest.currentBoxNumber);
                }
            } catch (e) {
                console.error('Failed to load latest counters', e);
            }
        };
        syncCountersWithProduct();
        // syncVersion: re-fetch counters after data-updated (e.g. pallet sheet printed → pallet
        // closed) so "Короб №" / "Коробов на паллете" reset instead of showing stale values.
    }, [selectedProduct, syncVersion]);



    // --- HELPER FUNCTIONS ---
    const getNetWeight = () => {
        if (!selectedProduct) return weight;
        const currentWeight = parseFloat(weight);

        const portionContainerId = selectedProduct.portion_container_id;
        const portionContainer = portionContainerId
            ? containers.find(c => String(c.id) === String(portionContainerId))
            : null;

        // Use container weight from list, or the pre-loaded portion_weight from product query
        const tareGrams = portionContainer?.weight || selectedProduct.portion_weight || 0;
        const tareKg = tareGrams / 1000;

        const result = Math.max(0, currentWeight - tareKg).toFixed(3);
        return result;
    };

    const getLabelData = (overrideWeight?: number, isBoxLabel: boolean = false, overrideUnits?: number) => {
        const currentWeightVal = overrideWeight !== undefined ? overrideWeight : parseFloat(weight);
        const now = labelingDate;
        const expDays = selectedProduct?.exp_date || 0;
        const expDate = new Date(now);
        expDate.setDate(now.getDate() + expDays);

        const formatDate = (d: Date) => {
            return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
        };

        const formatFullDate = (d: Date) => {
            const day = String(d.getDate()).padStart(2, '0');
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const year = d.getFullYear();
            return `${day}.${month}.${year}`;
        };

        let extra = {};
        try {
            if (selectedProduct?.extra_data) {
                // console.log('DEBUG: Parsing extra_data for', selectedProduct.name, typeof selectedProduct.extra_data, selectedProduct.extra_data);
                if (typeof selectedProduct.extra_data === 'string') {
                    extra = JSON.parse(selectedProduct.extra_data);
                } else if (typeof selectedProduct.extra_data === 'object') {
                    extra = selectedProduct.extra_data;
                }
            }
        } catch (e) {
            console.error('Failed to parse extra_data', e);
        }

        // Calculate Weights
        const weightBruttoPack = currentWeightVal;
        const portionContainer = containers.find(c => String(c.id) === String(selectedProduct?.portion_container_id));
        const tarePack = (portionContainer?.weight || selectedProduct?.portion_weight || 0) / 1000;
        const weightNettoPack = Math.max(0, weightBruttoPack - tarePack);

        // Box Weights
        // For box label, currentWeightVal passed in IS the total box net weight
        const effectiveBoxNet = isBoxLabel ? currentWeightVal : (boxNetWeight + weightNettoPack);

        const boxContainer = containers.find(c => c.id === selectedProduct?.box_container_id);
        const tarePackGrams = portionContainer?.weight || 0;
        const tareBoxGrams = boxContainer?.weight || 0;
        // Brutto box = sum of each pack's brutto (net + pack tare) + box container tare
        // Number of packs: for box label use overrideUnits, otherwise current + 1
        let packsInThisBox = isBoxLabel
            ? (overrideUnits !== undefined ? overrideUnits : unitsInBox)
            : (unitsInBox + 1);

        // Safety: if we are printing a box label from handlePrint (auto-close), 
        // unitsInBox is already correct for the FULL box.

        const weightBruttoBox = effectiveBoxNet + (packsInThisBox * tarePackGrams / 1000) + (tareBoxGrams / 1000);

        // Pallet Weights (Placeholder logic for now)
        const weightNettoPallet = effectiveBoxNet * (boxesInPallet + 1);
        const weightBruttoPallet = weightNettoPallet + 20;

        // Counters
        const currentUnits = overrideUnits !== undefined ? overrideUnits : unitsInBox;

        const getFormattedCounter = (count: number, labelDoc: any, placeholder: string, configObj?: any): string => {
            // Base: Station + Count
            const stationPrefix = stationNumber ? String(stationNumber).padStart(2, '0') : '';
            const countStr = String(count);

            // Check for minLength in template
            let minLength = 0;
            const items = labelDoc ? (labelDoc.elements || labelDoc.objects) : null;
            if (items) {
                const searchPlaceholder = placeholder.replace(/\s+/g, '');
                let foundEl = items.find((e: any) => {
                    const isText = e.type === 'text' || e.type === 'i-text' || e.type === 'textbox';
                    const cleanText = (e.text || '').replace(/\s+/g, '');
                    const cleanVal = (e.value || '').replace(/\s+/g, '');
                    return isText && (cleanVal.includes(searchPlaceholder) || cleanText.includes(searchPlaceholder));
                });

                if (!foundEl) {
                    foundEl = items.find((e: any) => {
                        const isBarcode = e.type === 'barcode';
                        const cleanVal = (e.value || '').replace(/\s+/g, '');
                        return isBarcode && cleanVal.includes(searchPlaceholder);
                    });
                }
                const foundLen = foundEl?.minLength || foundEl?.minLeght;
                if (foundLen) minLength = Number(foundLen);
            }

            // Formatting Logic
            if (minLength > 0) {
                // If minLength is set, we assume it refers to the TOTAL length of the ID
                // Format: [StationPrefix][PaddedCounter]
                // Example: Station 06, Count 1, MinLength 8 -> 06000001
                const targetCountLength = Math.max(0, minLength - stationPrefix.length);
                return stationPrefix + countStr.padStart(targetCountLength, '0');
            } else if (configObj?.enabled) {
                // Fallback to local config
                const prefix = configObj.prefix !== undefined ? configObj.prefix : stationPrefix;
                return `${prefix}${countStr.padStart(configObj.length || 0, '0')}`;
            } else {
                // Default: Just concatenate
                return stationPrefix + countStr;
            }
        };

        // Select the template document to use for looking up minLength/formatting rules
        const activeLabelDoc = isBoxLabel ? boxLabelDoc : labelDoc;

        // For Pack Label
        // We use totalUnits for the permanent individual pack number.
        // unitsInBox is used for "Pack X of Y" statistics.
        const unitNumStr = getFormattedCounter(totalUnits + 1, activeLabelDoc, '{{pack_number}}', numberingConfig?.unit);

        // For Box Label
        const boxNumStr = getFormattedCounter(totalBoxes + 1, activeLabelDoc, '{{box_number}}', numberingConfig?.box);

        const dataObj: any = {
            name: selectedProduct?.name || '',
            article: selectedProduct?.article || '',
            exp_date: String(expDays),
            box_id: currentBoxId, // Add for reference

            // Weights (Strings for text replacement)
            weight: weightNettoPack.toFixed(3),
            weight_netto_pack: weightNettoPack.toFixed(3),
            weight_brutto_pack: weightBruttoPack.toFixed(3),
            weight_netto_box: effectiveBoxNet.toFixed(3),
            weight_brutto_box: weightBruttoBox.toFixed(3),
            weight_netto_pallet: weightNettoPallet.toFixed(3),
            weight_brutto_pallet: weightBruttoPallet.toFixed(3),
            weight_brutto_all: weightBruttoPallet.toFixed(3),

            // Dates
            date: formatDate(now),
            production_date: formatFullDate(now),
            date_exp: formatDate(expDate),
            exp_date_full: formatFullDate(expDate),

            // Counters
            pack_number: unitNumStr,
            box_number: boxNumStr,
            batch_number: batchNumber || (extra as any).batch_number || '', // Use manual input primarily
            pack_count: String(currentUnits + (isBoxLabel ? 0 : 1)), // For unit label: current + 1. For box: just total.
            pack_counter: String(currentUnits + (isBoxLabel ? 0 : 1)), // Alias requested by user
            box_count: String(boxesInPallet + 1),
            close_box_counter: String(currentUnits + (isBoxLabel ? 0 : 1)),
            box_limit: selectedProduct?.close_box_counter?.toString() || '', // Kept the actual limit here if needed later

            // Raw numeric values for barcode generator
            _raw_weight_netto_pack: weightNettoPack,
            _raw_weight_brutto_pack: weightBruttoPack,
            _raw_weight_netto_box: effectiveBoxNet,
            _raw_weight_brutto_box: weightBruttoBox,

            // Current station operator (from PIN-login session)
            operator: operator?.short_code || '',
            operator_name: operator?.full_name || '',

            ...extra
        };

        // Barcode Generation
        dataObj.barcode = (() => {
            if (packBarcodeTemplate) {
                try {
                    const genData: BarcodeData = {
                        ...dataObj,
                        weight_netto_pack: weightNettoPack,
                        weight_brutto_pack: weightBruttoPack,
                        weight_netto_box: effectiveBoxNet,
                        weight_brutto_box: weightBruttoBox,
                        weight_netto_pallet: weightNettoPallet,
                        weight_brutto_pallet: weightBruttoPallet,
                        production_date: now,
                        exp_date: expDate,
                        article: selectedProduct?.article,
                        unit_number: unitNumStr,
                        box_number: boxNumStr,
                        batch_number: batchNumber || (extra as any).batch_number || ''
                    };

                    const generated = generateBarcode(JSON.parse(packBarcodeTemplate.structure).fields, genData);
                    // console.log('Generated Barcode:', generated);
                    return generated;
                } catch (err) {
                    console.error('Barcode generation failed:', err);
                    return selectedProduct?.barcode || selectedProduct?.article || '0000000000000';
                }
            }
            return selectedProduct?.barcode || selectedProduct?.article || '0000000000000';
        })();

        return dataObj;
    };

    const loadProducts = async (query: string = '') => {
        try {
            const list = await window.electron.invoke('get-products', query);
            console.log(`WeighingStation: Loaded ${list.length} products for query "${query}"`);
            setProducts(list);
        } catch (err) {
            console.error(err);
        }
    };

    // --- EFFECTS ---



    // Scale, Status, Sync Listeners
    useEffect(() => {
        const removeReadingListener = window.electron.on('scale-reading', (data: any) => {
            // Skip weight updates while this station is hidden — avoids re-rendering an
            // off-screen component on every reading. Status/error listeners stay active.
            if (activeTabRef.current !== 'weighing') return;
            if (data && typeof data === 'object' && 'weight' in data) {
                const w = typeof data.weight === 'number' ? data.weight : parseFloat(String(data.weight));
                console.log(`[WeighingStation] Event received: ${w.toFixed(3)} (stable: ${data.stable})`);
                setWeight(w.toFixed(3));
                weightRef.current = w.toFixed(3);
                setIsStable(!!data.stable);

                if (data.stable) {
                    setStableTrigger(prev => prev + 1);
                }

                // Reset auto-print flag when weight drops near zero (product removed)
                if (w < 0.010) {
                    autoPrintFiredRef.current = false;
                }
                return;
            }
            const weightStr = typeof data === 'string' ? data : JSON.stringify(data);
            const match = weightStr.match(/(\d+\.\d+)/);
            if (match) { setWeight(match[1]); weightRef.current = match[1]; }
            else { setWeight(weightStr); weightRef.current = weightStr; }
        });

        const removeStatusListener = window.electron.on('scale-status', (s: any) => setStatus(s));
        const removeErrorListener = window.electron.on('scale-error', (msg: string) => {
            if (msg.includes('|')) {
                const [code, context] = msg.split('|');
                if (code === 'serial_access_denied') {
                    setAlertMessage(t('error.serialAccessDenied', { port: context }));
                } else if (code === 'serial_not_found') {
                    setAlertMessage(t('error.serialNotFound', { port: context }));
                } else {
                    setAlertMessage(`${t('ws.errorPrefix')}: ${msg}`);
                }
            } else {
                setAlertMessage(`${t('ws.errorPrefix')}: ${msg}`);
            }
        });

        window.electron.invoke('get-scale-status').then((s: string) => {
            if (s) setStatus(s);
        });

        const removeUpdateListener = window.electron.on('data-updated', () => {
            console.log('WeighingStation: data-updated received, reloading all data...');
            loadProducts();
            // Increment sync version to force label/barcode template re-fetch
            setSyncVersion(prev => prev + 1);
            // Also reload containers in case they changed
            window.electron.invoke('get-containers').then((cnts: any) => {
                setContainers(cnts);
            }).catch((e: any) => console.error('Failed to reload containers', e));
        });

        return () => {
            removeReadingListener();
            removeStatusListener();
            removeErrorListener();
            removeUpdateListener();
        };
    }, []); // Remove searchQuery to prevent listener flapping

    // Auto-update selected product / auto-select on load
    useEffect(() => {
        if (products.length === 0) return;

        if (selectedProduct) {
            // Update existing selection if data changed after sync
            const updated = products.find(p => p.id === selectedProduct.id);
            if (updated && JSON.stringify(updated) !== JSON.stringify(selectedProduct)) {
                setSelectedProduct(updated);
            }
        } else {
            // No product selected yet — try to restore from localStorage or pick first
            const savedId = localStorage.getItem('lastSelectedProductId');
            const restored = savedId ? products.find(p => String(p.id) === savedId) : null;
            setSelectedProduct(restored || products[0]);
        }
    }, [products]);

    // Persist selected product ID to localStorage
    useEffect(() => {
        if (selectedProduct?.id) {
            localStorage.setItem('lastSelectedProductId', String(selectedProduct.id));
        }
    }, [selectedProduct]);

    // Load printer config
    useEffect(() => {
        const loadConfig = () => {
            window.electron.invoke('get-printer-config').then((cfg: any) => {
                if (cfg) setPrinterConfig(cfg);
            });
        };
        loadConfig();

        const removeListener = window.electron.on('printer-config-updated', (newConfig: any) => {
            console.log('WeighingStation: Printer config updated', newConfig);
            setPrinterConfig(newConfig);
        });

        return () => removeListener();
    }, []);

    // Eagerly open TCP/Serial to configured printers so first label doesn't pay the handshake.
    useEffect(() => {
        if (!printerConfig.packPrinter && !printerConfig.boxPrinter) { setPrinterStatus('unconfigured'); return; }
        window.electron.invoke('printer:warmup', { printerIds: ['pack', 'box'] })
            .then((res: any) => { if (res?.results?.pack) setPrinterStatus(res.results.pack); })
            .catch(() => { /* best-effort */ });
    }, [printerConfig]);

    // Live pack-printer status from main-process pushes. Needed because merged
    // record-and-print dispatches the print in main (no per-print promise to .then).
    useEffect(() => {
        const remove = window.electron.on('printer-status-update', (u: any) => {
            const packId = (printerConfig.packPrinter as any)?.id;
            if (!packId || !u || u.id !== packId) return;
            if (u.status === 'error') setPrinterStatus('unreachable');
            else if (u.status === 'connected') setPrinterStatus('ready');
        });
        return () => remove();
    }, [printerConfig]);

    // Pre-upload static backgrounds for the current templates so first print is a cache hit.
    useEffect(() => {
        if (labelDoc) {
            window.electron.invoke('printer:warmup-bg', { labelDoc, role: 'pack' }).catch(() => { /* best-effort */ });
        }
        if (boxLabelDoc) {
            window.electron.invoke('printer:warmup-bg', { labelDoc: boxLabelDoc, role: 'box' }).catch(() => { /* best-effort */ });
        }
    }, [labelDoc, boxLabelDoc]);

    // Auto-print on weight stabilization
    // Only reacts to isStable changes (not every weight reading) to avoid blocking React rendering
    useEffect(() => {
        if (
            !isReady ||
            !printerConfig.autoPrintOnStable ||
            !isStable ||
            !selectedProduct ||
            !labelDoc ||
            autoPrintFiredRef.current ||
            isPrintingRef.current ||
            activeTab !== 'weighing'
        ) {
            // Optional: verbose log if we are stable but not firing
            if (isStable && !autoPrintFiredRef.current && !isPrintingRef.current) {
                console.log(`[AutoPrint] Skip: isReady=${isReady}, product=${!!selectedProduct}, doc=${!!labelDoc}, tab=${activeTab}`);
            }
            return;
        }

        // Check weight from ref (avoids putting weight in deps which would cause effect to fire ~7/sec)
        const currentWeight = parseFloat(weightRef.current);
        if (currentWeight <= 0.010) {
            if (isStable) console.log(`[AutoPrint] Skip: weight too low (${currentWeight})`);
            return;
        }

        console.log(`[AutoPrint] Firing! Weight: ${currentWeight}, Product: ${selectedProduct.name}`);
        autoPrintFiredRef.current = true;
        handlePrint(true).catch((err) => {
            console.error('Auto-print failed:', err);
            isPrintingRef.current = false;
        });
    }, [isStable, selectedProduct, labelDoc, printerConfig.autoPrintOnStable, isReady, stableTrigger]);

    // Initial Data Load
    useEffect(() => {
        const loadInitData = async () => {
            try {
                const cnts = await window.electron.invoke('get-containers');
                setContainers(cnts);
            } catch (e) {
                console.error('Failed to load containers', e);
            }
        };
        loadInitData();
    }, []);

    // Config and Product Load
    useEffect(() => {
        const loadConfig = async () => {
            try {
                const cfg = await window.electron.invoke('get-numbering-config');
                setNumberingConfig(cfg);
            } catch (e) {
                console.error('Failed to load numbering config', e);
            }
        };
        loadConfig();
        loadProducts();
    }, []);

    // Fetch Labels & Barcodes
    useEffect(() => {
        const fetchLabelsAndBarcodes = async () => {
            console.log('DEBUG: fetchLabelsAndBarcodes triggered. Selected Product:', selectedProduct ? selectedProduct.name : 'NULL');

            if (!selectedProduct) {
                setLabelDoc(null);
                setLabelDocKey(null);
                setBoxLabelDoc(null);
                setBoxLabelDocKey(null);
                setPackBarcodeTemplate(null);
                setBoxBarcodeTemplate(null);
                return;
            }

            // 1. Pack Label
            let pDoc = null;
            if (selectedProduct.templates_pack_label) {
                try {
                    console.log('DEBUG: Fetching Pack Label ID:', selectedProduct.templates_pack_label);
                    const doc = await window.electron.invoke('get-label', selectedProduct.templates_pack_label);
                    // console.log('DEBUG: Pack Label Doc:', doc ? 'FOUND' : 'NULL');
                    if (doc && typeof doc.structure === 'string') {
                        pDoc = JSON.parse(doc.structure);
                        setLabelDoc(pDoc);
                        setLabelDocKey(computeDocKey(doc.structure));
                    } else {
                        console.warn('DEBUG: Pack Label structure invalid or missing');
                    }
                } catch (err) {
                    console.error('Failed to fetch pack label template:', err);
                }
            } else {
                setLabelDoc(null);
                setLabelDocKey(null);
            }

            // 2. Box Label
            let bDoc = null;
            if (selectedProduct.templates_box_label) {
                try {
                    console.log('DEBUG: Fetching Box Label ID:', selectedProduct.templates_box_label);
                    const doc = await window.electron.invoke('get-label', selectedProduct.templates_box_label);
                    // console.log('DEBUG: Box Label Doc:', doc ? 'FOUND' : 'NULL');
                    if (doc && typeof doc.structure === 'string') {
                        bDoc = JSON.parse(doc.structure);
                        setBoxLabelDoc(bDoc);
                        setBoxLabelDocKey(computeDocKey(doc.structure));
                    } else {
                        console.warn('DEBUG: Box Label structure invalid or missing', doc);
                    }
                } catch (err) {
                    console.error('Failed to fetch box label template:', err);
                }
            } else {
                setBoxLabelDoc(null);
                setBoxLabelDocKey(null);
            }

            // 3. Fetch Barcode Templates based on Label Definition
            const fetchBarcode = async (doc: any, setFn: (t: any) => void, labelType: string) => {
                if (!doc) {
                    console.log(`DEBUG: No doc for ${labelType}`);
                    return setFn(null);
                }
                // Check for 'elements' (LabelRenderer use) or 'objects' (Legacy/Konva?)
                const items = doc.elements || doc.objects;
                if (!items) {
                    console.log(`DEBUG: No elements/objects in ${labelType} doc`);
                    return setFn(null);
                }
                const barcodeObj = items.find((o: any) => o.type === 'barcode');
                console.log(`DEBUG: ${labelType} Barcode Object:`, JSON.stringify(barcodeObj));

                if (barcodeObj && barcodeObj.templateId) {
                    try {
                        console.log(`DEBUG: Fetching template ${barcodeObj.templateId} for ${labelType}`);
                        const tmpl = await window.electron.invoke('get-barcode-template', barcodeObj.templateId);
                        console.log(`DEBUG: Fetched template for ${labelType}:`, tmpl ? 'FOUND' : 'NULL');
                        setFn(tmpl);
                    } catch (e) {
                        console.error('Failed to fetch barcode template:', e);
                        setFn(null);
                    }
                } else {
                    console.log(`DEBUG: No templateId for ${labelType}`);
                    setFn(null);
                }
            };

            await fetchBarcode(pDoc, (t) => {
                setPackBarcodeTemplate(t);
            }, 'PACK');
            await fetchBarcode(bDoc, setBoxBarcodeTemplate, 'BOX');
        };
        fetchLabelsAndBarcodes();
    }, [selectedProduct, syncVersion]);

    const handleRepeat = async () => {
        if (!lastPrinted) {
            setAlertMessage(t('ws.noReprintData'));
            return;
        }
        console.log('WeighingStation: Repeating last print...');
        await window.electron.invoke('print-label', {
            silent: true,
            labelDoc: lastPrinted.doc,
            data: lastPrinted.data,
            // Try to infer which config to use or just use pack as default for repeat
            printerConfig: printerConfig.packPrinter
        });
    };

    const handleCloseBox = async () => {
        const startTime = performance.now();
        if (unitsInBox === 0) {
            setAlertMessage(t('ws.emptyBox'));
            return;
        }

        console.log('WeighingStation: Manual Close Box triggered');

        // Capture current state BEFORE resetting
        const finalBoxWeight = boxNetWeight;
        const finalUnitsInBox = unitsInBox;

        // Reset counters for next box
        setUnitsInBox(0);
        setBoxNetWeight(0);
        setBoxesInPallet(prev => prev + 1);
        setTotalBoxes(prev => prev + 1);

        // Print Box Label
        if (boxLabelDoc) {
            const boxLimit = selectedProduct?.close_box_counter || 0;

            // Generate Box Barcode
            // 1. Get Base Data FIRST to ensure counters (box_number) are consistent
            const baseData = getLabelData(finalBoxWeight, true, finalUnitsInBox);

            // 2. Generate Box Barcode
            let boxBarcode = '';
            if (boxBarcodeTemplate) {
                try {
                    const fields = JSON.parse(boxBarcodeTemplate.structure).fields;
                    console.log('MANUAL CLOSE DEBUG: Template Fields:', JSON.stringify(fields));

                    const boxContainer = containers.find(c => c.id === selectedProduct?.box_container_id);
                    const brutBox = finalBoxWeight + (boxContainer?.weight || 0) / 1000;

                    const expDateBox = new Date(labelingDate);
                    expDateBox.setDate(labelingDate.getDate() + (selectedProduct?.exp_date || 0));

                    const genData = {
                        weight_netto_box: finalBoxWeight,
                        weight_brutto_box: brutBox,
                        production_date: labelingDate,
                        exp_date: expDateBox,
                        // GTIN-14 padding ONLY for box label
                        article: (selectedProduct?.article || '').padStart(14, '0'),
                        // Use the SAME box_number as the textual label
                        box_number: baseData.box_number || '',
                        batch_number: batchNumber || ''
                    } as BarcodeData;
                    console.log('MANUAL CLOSE DEBUG: Gen Data:', JSON.stringify(genData));

                    boxBarcode = generateBarcode(fields, genData);
                    console.log('MANUAL CLOSE DEBUG: Generated Barcode:', boxBarcode);
                } catch (err) {
                    console.error('MANUAL CLOSE DEBUG: Error generating barcode:', err);
                }
            } else {
                console.log('MANUAL CLOSE DEBUG: No boxBarcodeTemplate found');
            }

            // Determine barcode: prefer boxBarcodeTemplate result, fallback to baseData, then product fields
            const resolvedBarcode = boxBarcode || baseData.barcode;
            const isDefaultZeros = !resolvedBarcode || /^0+$/.test(resolvedBarcode);
            const finalBarcode = isDefaultZeros
                ? ((baseData as any)['Код ШК'] || selectedProduct?.barcode || selectedProduct?.article || '0000000000000')
                : resolvedBarcode;

            const boxData = {
                ...baseData,
                is_box: true,
                count: boxLimit,
                pack_counter: String(finalUnitsInBox), // Actual count in this box
                weight_netto: finalBoxWeight.toFixed(3),
                barcode: finalBarcode
            };

            await window.electron.invoke('print-label', {
                silent: true,
                labelDoc: boxLabelDoc,
                docKey: boxLabelDocKey || undefined,
                data: boxData,
                printerConfig: printerConfig.boxPrinter
            });

            // Persist Closed Box to DB
            if (currentBoxId) {
                const boxContainer = containers.find(c => c.id === selectedProduct?.box_container_id);
                const brutBox = finalBoxWeight + (boxContainer?.weight || 0) / 1000;
                await window.electron.invoke('close-box', {
                    boxId: currentBoxId,
                    weightNetto: finalBoxWeight,
                    weightBrutto: brutBox
                });
                setCurrentBoxId(null);
                setCurrentBoxNumber(null);
            }

            const totalTime = performance.now() - startTime;
            console.log(`Performance: handleCloseBox total took ${totalTime.toFixed(2)}ms`);

            setLastPrinted({ doc: boxLabelDoc, data: boxData });
        } else {
            console.warn('Close Box: No box label template found.');
            setAlertMessage(t('ws.noBoxLabel'));
        }
    };

    // Brief auto-dismissing success toast for the manual print (no toast on auto-print: the
    // auto-print badge already confirms, and it fires too often to interrupt with a toast).
    const showPrintToast = (msg: string) => {
        setPrintToast(msg);
        if (printToastTimer.current) clearTimeout(printToastTimer.current);
        printToastTimer.current = setTimeout(() => setPrintToast(null), 1800);
    };
    useEffect(() => () => { if (printToastTimer.current) clearTimeout(printToastTimer.current); }, []);

    const handlePrint = async (isAuto = false) => {
        if (isPrintingRef.current) return;
        isPrintingRef.current = true;

        try {
            if (!labelDoc) {
                console.warn('Cannot print: No label template selected');
                return;
            }

            const boxLimit = selectedProduct?.close_box_counter || 999999;

            // 1. Get PREDICTED Box Number for Record-Pack if no box is open
            // We use a dummy dataObj to get the predicted number
            const predictedData = getLabelData();
            const predictedBoxNum = currentBoxNumber || predictedData.box_number;

            let packBarcode = '';
            if (packBarcodeTemplate) {
                try {
                    const fields = JSON.parse(packBarcodeTemplate.structure).fields;
                    const expDatePack = new Date(labelingDate);
                    expDatePack.setDate(labelingDate.getDate() + (selectedProduct?.exp_date || 0));

                    const genData = {
                        weight_netto_pack: parseFloat(predictedData.weight_netto_pack),
                        weight_brutto_pack: parseFloat(predictedData.weight_brutto_pack),
                        production_date: labelingDate,
                        exp_date: expDatePack,
                        article: (selectedProduct?.article || '').padStart(14, '0'),
                        pack_number: predictedData.pack_number,
                        box_number: predictedBoxNum,
                        batch_number: batchNumber || ''
                    } as any;

                    packBarcode = generateBarcode(fields, genData);
                } catch (err) {
                    console.error('Error generating preliminary pack barcode:', err);
                }
            }

            const expDatePack = new Date(labelingDate);
            expDatePack.setDate(labelingDate.getDate() + (selectedProduct?.exp_date || 0));

            // 2+6 merged: the DB transaction AND the print dispatch happen in ONE
            // main-process turn ('record-and-print') — the label starts generating
            // before this renderer even receives the reply, removing a full IPC round
            // trip plus the renderer event-loop requeue from every pack.
            const recordResult = await window.electron.invoke('record-and-print', {
                record: {
                    number: predictedData.pack_number,
                    box_number: predictedBoxNum,
                    nomenclature_id: selectedProduct.id,
                    weight_netto: parseFloat(predictedData.weight_netto_pack),
                    weight_brutto: parseFloat(predictedData.weight_brutto_pack),
                    barcode_value: packBarcode,
                    station_number: stationNumber,
                    production_date: labelingDate.toISOString(),
                    expiration_date: expDatePack.toISOString(),
                    batch: batchNumber || ''
                },
                labelDoc,
                docKey: labelDocKey || undefined,
                data: predictedData,
                printerConfig: printerConfig.packPrinter || undefined
            });

            if (!recordResult.success) throw new Error('Database recording failed');

            // 3. Update UI state with ACTUAL box info from DB
            const actualBoxNumber = recordResult.boxNumber;
            const actualBoxId = recordResult.boxId;

            if (recordResult.newBoxCreated) {
                setTotalBoxes(prev => prev + 1);
            }
            setCurrentBoxId(actualBoxId);
            setCurrentBoxNumber(actualBoxNumber);

            // Final label data = predicted data with the ACTUAL box number (verified:
            // nothing else can differ — state is unchanged between the two computations).
            const finalPrintData = { ...predictedData, box_number: actualBoxNumber };

            if (recordResult.printDispatched) {
                // Print already queued in main. Failures surface via the
                // printer-status-update push listener; record success optimistically.
                const time = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
                setLastPrintInfo({ label: String(finalPrintData.pack_number || ''), time });
                if (!isAuto) showPrintToast(t('ws.printSentToast'));
            } else if (printerConfig.packPrinter) {
                // Browser-protocol printer — worker-window path stays renderer-driven.
                window.electron.invoke('print-label', {
                    silent: true,
                    labelDoc,
                    data: finalPrintData,
                    printerConfig: printerConfig.packPrinter
                })
                    .then((ok: any) => {
                        setPrinterStatus(ok === false ? 'unreachable' : 'ready');
                        if (ok !== false) {
                            const time = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
                            setLastPrintInfo({ label: String(finalPrintData.pack_number || ''), time });
                            if (!isAuto) showPrintToast(t('ws.printSentToast'));
                        }
                    })
                    .catch(err => { console.error('Background Printing Error:', err); setPrinterStatus('unreachable'); });
            }

            setLastPrinted({ doc: labelDoc, data: finalPrintData });

            // 7. Update Box Stats
            const currentNetWeight = parseFloat(finalPrintData.weight_netto_pack);
            const newUnitsInBox = unitsInBox + 1;
            const newBoxNetWeight = boxNetWeight + currentNetWeight;

            if (newUnitsInBox >= boxLimit) {
                console.log('Box limit reached. Auto-printing box label.');
                const finalBoxWeight = newBoxNetWeight;
                const finalUnitsInBox = newUnitsInBox;

                // Reset local state immediately
                setUnitsInBox(0);
                setBoxNetWeight(0);
                setBoxesInPallet(prev => prev + 1);
                setTotalUnits(prev => prev + 1);

                if (boxLabelDoc) {
                    const baseData = getLabelData(finalBoxWeight, true, finalUnitsInBox);
                    baseData.box_number = actualBoxNumber; // Use the same box number

                    let boxBarcode = '';
                    if (boxBarcodeTemplate) {
                        const fields = JSON.parse(boxBarcodeTemplate.structure).fields;
                        const boxContainer = containers.find(c => c.id === selectedProduct?.box_container_id);
                        const brutBox = finalBoxWeight + (boxContainer?.weight || 0) / 1000;
                        const expDateBox = new Date(labelingDate);
                        expDateBox.setDate(labelingDate.getDate() + (selectedProduct?.exp_date || 0));

                        const genData = {
                            weight_netto_box: finalBoxWeight,
                            weight_brutto_box: brutBox,
                            production_date: labelingDate,
                            exp_date: expDateBox,
                            article: (selectedProduct?.article || '').padStart(14, '0'),
                            box_number: actualBoxNumber,
                            batch_number: batchNumber || ''
                        } as BarcodeData;
                        boxBarcode = generateBarcode(fields, genData);
                    }

                    // Determine barcode: prefer boxBarcodeTemplate result, fallback to baseData, then product fields
                    const resolvedBarcode = boxBarcode || baseData.barcode;
                    const isDefaultZeros = !resolvedBarcode || /^0+$/.test(resolvedBarcode);
                    const finalBarcode = isDefaultZeros
                        ? ((baseData as any)['Код ШК'] || selectedProduct?.barcode || selectedProduct?.article || '0000000000000')
                        : resolvedBarcode;

                    const boxData = {
                        ...baseData,
                        is_box: true,
                        count: boxLimit,
                        pack_counter: String(finalUnitsInBox),
                        weight_netto: finalBoxWeight.toFixed(3),
                        barcode: finalBarcode
                    };

                    window.electron.invoke('print-label', {
                        silent: true,
                        labelDoc: boxLabelDoc,
                        docKey: boxLabelDocKey || undefined,
                        data: boxData,
                        printerConfig: printerConfig.boxPrinter || undefined
                    }).catch(err => console.error('Background Printing Error (Box):', err));

                    // Close box in DB
                    const boxContainer = containers.find(c => c.id === selectedProduct?.box_container_id);
                    const brutBox = finalBoxWeight + (boxContainer?.weight || 0) / 1000;
                    window.electron.invoke('close-box', {
                        boxId: actualBoxId,
                        weightNetto: finalBoxWeight,
                        weightBrutto: brutBox
                    }).catch(err => console.error('Background DB Error (CloseBox):', err));

                    setCurrentBoxId(null);
                    setCurrentBoxNumber(null);
                    setLastPrinted({ doc: boxLabelDoc, data: boxData });
                }
            } else {
                setUnitsInBox(newUnitsInBox);
                setBoxNetWeight(newBoxNetWeight);
                setTotalUnits(prev => prev + 1);
            }
        } catch (err) {
            console.error('Print Error:', err);
            setAlertMessage(`${t('ws.errorPrefix')}: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            isPrintingRef.current = false;
        }
    };



    const handleSelectProduct = (product: any) => {
        if (unitsInBox > 0) {
            setAlertMessage(t('ws.closeBoxBeforeChange'));
            return;
        }
        setSelectedProduct(product);
        setCurrentBoxId(null);
        setCurrentBoxNumber(null);
        setIsProductModalOpen(false);
    };

    // Display-only counters shown in "Session Stats". Memoized so they don't recompute
    // (each call runs getFormattedCounter + barcode generation) on every weight tick —
    // only when the underlying counters/template/config actually change. pack_number and
    // box_number do not depend on the live weight, so excluding it from deps is correct.
    const displayPackNumber = useMemo(
        () => getLabelData().pack_number,
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [totalUnits, stationNumber, labelDoc, numberingConfig, selectedProduct]
    );
    const displayBoxNumber = useMemo(
        () => getLabelData(undefined, true).box_number,
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [totalBoxes, stationNumber, boxLabelDoc, numberingConfig, selectedProduct]
    );

    // Glanceable box-fill progress: emerald → amber (≥80%) → red (full).
    const boxFillLimit = Number(selectedProduct?.close_box_counter) || 0;
    const boxFillPct = boxFillLimit > 0 ? Math.min(100, Math.round((unitsInBox / boxFillLimit) * 100)) : 0;
    const boxFillColor = boxFillPct >= 100 ? 'bg-red-500' : boxFillPct >= 80 ? 'bg-amber-500' : 'bg-emerald-500';

    return (
        <div className="grid grid-cols-12 gap-6 h-full p-3 relative">
            {/* Product Information Card */}
            <div className="col-span-8 bg-white dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-600 rounded-2xl p-5 backdrop-blur shadow-sm dark:shadow-2xl">
                <div className="flex justify-between items-start mb-4 gap-4">
                    <div>
                        <h2 className="text-2xl font-semibold text-neutral-900 dark:text-white">{t('ws.title')}</h2>
                    </div>
                    {/* Status badges grouped on the right (wrap if narrow) */}
                    <div className="flex items-center gap-2 flex-wrap justify-end">
                        {/* Scale status */}
                        <div className={`px-4 py-2 rounded-full text-sm font-medium flex items-center gap-2 border ${status === 'connected'
                            ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                            : (status === 'reconnecting' || status === 'connecting')
                                ? 'bg-yellow-500/10 border-yellow-500/20 text-yellow-400'
                                : 'bg-red-500/10 border-red-500/20 text-red-400'
                            }`}>
                            <span className={`w-2 h-2 rounded-full ${status === 'connected' ? 'bg-emerald-500 animate-pulse' :
                                (status === 'reconnecting' || status === 'connecting') ? 'bg-yellow-500 animate-pulse' :
                                    'bg-red-500'
                                }`}></span>
                            {t('ws.scaleShort')}: {status === 'connected' ? t('ws.scaleStatus.connected') :
                                (status === 'reconnecting' || status === 'connecting') ? t('ws.scaleStatus.connecting') : t('ws.scaleStatus.disconnected')}
                        </div>
                        {/* Printer status */}
                        <div className={`px-4 py-2 rounded-full text-sm font-medium flex items-center gap-2 border ${(printerStatus === 'ready' || printerStatus === 'driver')
                            ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                            : printerStatus === 'unknown'
                                ? 'bg-neutral-500/10 border-neutral-500/20 text-neutral-400'
                                : 'bg-red-500/10 border-red-500/20 text-red-400'
                            }`}>
                            <Printer className="w-3.5 h-3.5" />
                            {printerStatus === 'ready' ? t('ws.printerStatus.ready') :
                                printerStatus === 'driver' ? t('ws.printerStatus.driver') :
                                    printerStatus === 'unreachable' ? t('ws.printerStatus.unreachable') :
                                        printerStatus === 'unconfigured' ? t('ws.printerStatus.unconfigured') :
                                            t('ws.printerStatus')}
                        </div>
                        {/* Auto-print indicator */}
                        {printerConfig.autoPrintOnStable && (
                            <div className={`px-3 py-1.5 rounded-full text-xs font-medium border flex items-center gap-2 ${autoPrintFiredRef.current
                                ? 'bg-amber-500/10 border-amber-500/20 text-amber-400'
                                : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                                }`}>
                                <Printer className="w-3 h-3" />
                                {autoPrintFiredRef.current ? t('ws.printed') : t('ws.autoPrintActive')}
                            </div>
                        )}
                    </div>
                </div>

                <div className="space-y-4 relative">
                    <div onClick={() => setIsProductModalOpen(true)} className="cursor-pointer group">
                        <label className="block text-sm font-medium text-neutral-400 mb-2">{t('ws.search')}</label>
                        <div className="w-full bg-neutral-50 dark:bg-black/20 border border-neutral-300 dark:border-neutral-600 rounded-2xl px-5 py-4 text-lg text-neutral-500 dark:text-neutral-400 flex items-center justify-between group-hover:bg-neutral-100 dark:group-hover:bg-black/40 group-active:scale-[0.98] transition-all">
                            <span className={selectedProduct ? "text-neutral-900 dark:text-white" : ""}>
                                {selectedProduct ? selectedProduct.name : "..."}
                            </span>
                            <Search className="w-6 h-6 text-neutral-400" />
                        </div>
                    </div>

                    <div className="p-4 bg-emerald-50 dark:bg-emerald-500/5 border border-emerald-200 dark:border-emerald-500/10 rounded-2xl min-h-[88px] flex flex-col justify-center">
                        {selectedProduct ? (
                            <>
                                <h3 className="text-sm uppercase tracking-wider text-emerald-600 dark:text-emerald-500/60 font-bold mb-2">{t('products.name')}</h3>
                                <div className="text-3xl font-bold text-emerald-700 dark:text-emerald-100">{selectedProduct.name}</div>
                                <div className="mt-2 flex gap-4 text-emerald-400/60 text-sm font-mono">
                                    <span>{t('products.article')}: {selectedProduct.article || '—'}</span>
                                    <span>{t('products.expDays').toUpperCase()}: {selectedProduct.exp_date || 0}</span>
                                </div>
                            </>
                        ) : (
                            <div className="text-center text-neutral-500 italic">{t('ws.selectProduct')}</div>
                        )}
                    </div>
                </div>

                {/* Weight Display Area */}
                <div className="mt-4 grid grid-cols-2 gap-4">
                    <div className="bg-neutral-50 dark:bg-black/30 border border-neutral-200 dark:border-neutral-600 rounded-2xl p-4 text-center relative overflow-hidden group">
                        <div className="absolute inset-0 bg-gradient-to-br from-emerald-100/50 dark:from-emerald-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
                        <label className="text-xs uppercase tracking-widest text-neutral-500 font-bold">{t('ws.gross')}</label>
                        <div className="text-6xl font-mono text-emerald-600 dark:text-emerald-400 mt-2 font-light tracking-tighter">
                            {weight} <span className="text-2xl text-emerald-500/50">{t('ws.kg')}</span>
                        </div>
                        {isStable && (
                            <div className="mt-2 text-emerald-600 dark:text-emerald-500/60 text-xs font-bold uppercase tracking-widest animate-pulse flex items-center justify-center gap-2">
                                <div className="w-1 h-1 rounded-full bg-emerald-500"></div>
                                {t('ws.stable')}
                            </div>
                        )}
                    </div>
                    <div className="bg-neutral-50 dark:bg-black/30 border border-neutral-200 dark:border-neutral-600 rounded-2xl p-4 text-center">
                        <label className="text-xs uppercase tracking-widest text-neutral-500 font-bold">{t('ws.net')}</label>
                        <div className="text-6xl font-mono text-neutral-700 dark:text-neutral-300 mt-2 font-light tracking-tighter">
                            {getNetWeight()} <span className="text-2xl text-neutral-500 dark:text-neutral-600">{t('ws.kg')}</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Control Panel (scrolls if it doesn't fit, so nothing clips on small screens) */}
            <div className="col-span-4 space-y-4 flex flex-col overflow-y-auto min-h-0">
                <button
                    onClick={() => handlePrint()}
                    disabled={!selectedProduct || status !== 'connected' || !labelDoc}
                    className="w-full py-4 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 transition-all rounded-3xl font-bold text-xl shadow-[0_10px_40px_-10px_rgba(16,185,129,0.5)] flex items-center justify-center gap-3 border-t border-white/10 disabled:opacity-40 disabled:pointer-events-none disabled:shadow-none"
                >
                    <Printer className="w-6 h-6" />
                    {t('ws.print')}
                </button>

                <div className="grid grid-cols-2 gap-4">
                    <button
                        onClick={handleRepeat}
                        className="py-4 bg-neutral-100 dark:bg-neutral-700 hover:bg-neutral-200 dark:hover:bg-neutral-600 border border-neutral-300 dark:border-neutral-600 hover:border-neutral-400 dark:hover:border-white/10 rounded-2xl font-semibold transition-all flex flex-col items-center gap-2 group shadow-sm dark:shadow-none"
                    >
                        <RefreshCw className="w-6 h-6 text-neutral-500 dark:text-neutral-400 group-hover:text-neutral-800 dark:group-hover:text-white transition-colors" />
                        <span className="text-neutral-500 dark:text-neutral-400 group-hover:text-neutral-800 dark:group-hover:text-white uppercase text-xs tracking-widest">{t('ws.reprintSmall')}</span>
                    </button>
                    <button
                        onClick={handleCloseBox}
                        disabled={unitsInBox === 0}
                        className="py-4 bg-neutral-100 dark:bg-neutral-700 hover:bg-neutral-200 dark:hover:bg-neutral-600 border border-neutral-300 dark:border-neutral-600 hover:border-neutral-400 dark:hover:border-white/10 rounded-2xl font-semibold transition-all flex flex-col items-center gap-2 group shadow-sm dark:shadow-none disabled:opacity-40 disabled:pointer-events-none"
                    >
                        <Box className="w-6 h-6 text-neutral-500 dark:text-neutral-400 group-hover:text-neutral-800 dark:group-hover:text-white transition-colors" />
                        <span className="text-neutral-500 dark:text-neutral-400 group-hover:text-neutral-800 dark:group-hover:text-white uppercase text-xs tracking-widest">{t('ws.closeBox')}</span>
                    </button>
                    <button
                        onClick={() => setIsDeleteModalOpen(true)}
                        className="py-4 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40 border border-red-300 dark:border-red-500/30 hover:border-red-400 dark:hover:border-red-500/50 rounded-2xl font-semibold transition-all flex flex-col items-center gap-2 group shadow-sm dark:shadow-none"
                    >
                        <Trash2 className="w-6 h-6 text-red-500 dark:text-red-400 transition-colors" />
                        <span className="text-red-600 dark:text-red-400 uppercase text-xs tracking-widest">{t('ws.delete')}</span>
                    </button>
                </div>

                <button
                    onClick={() => printPalletSheet({ printerConfig, selectedProduct, t, setAlert: setAlertMessage, operatorName: operator?.full_name || '', busyRef: isPalletPrintingRef })}
                    className="w-full py-3 bg-amber-600 hover:bg-amber-500 active:bg-amber-700 transition-all rounded-2xl font-bold text-lg text-white flex items-center justify-center gap-3 shadow-[0_10px_30px_-12px_rgba(217,119,6,0.6)] border-t border-white/10"
                >
                    <Layers className="w-6 h-6" />
                    {t('pallet.printSheet')}
                </button>

                <div className="mt-3 p-4 bg-white dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-600 shadow-sm dark:shadow-none rounded-3xl backdrop-blur">
                    <h3 className="text-sm font-semibold mb-3 text-neutral-500 dark:text-white/60 uppercase tracking-widest">{t('ws.sessionStats')}</h3>
                    <div className="space-y-2">
                        <div
                            className="flex justify-between items-center p-2.5 bg-neutral-100 dark:bg-white/5 border border-neutral-300 dark:border-neutral-600 rounded-xl group cursor-pointer hover:bg-emerald-50 dark:hover:bg-emerald-500/10 hover:border-emerald-300 dark:hover:border-emerald-500/30 transition-all active:scale-[0.98]"
                            onClick={(e) => {
                                e.stopPropagation();
                                // Batch is metadata applied to future packs — safe to change anytime.
                                setIsKeypadOpen(true);
                            }}
                        >
                            <span className="text-xs uppercase tracking-wider text-neutral-500 font-bold">{t('ws.batchLabel')}</span>
                            <div className="flex items-center gap-3">
                                <span className="text-lg font-mono font-bold text-neutral-900 dark:text-white group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">
                                    {batchNumber || <span className="text-neutral-400 dark:text-neutral-700 italic text-sm">{t('ws.enterPlaceholder')}</span>}
                                </span>
                                <div className="p-2 bg-white dark:bg-neutral-700 border border-neutral-300 dark:border-neutral-600 rounded-lg group-hover:bg-emerald-100 dark:group-hover:bg-emerald-500/20 group-hover:border-emerald-400 dark:group-hover:border-emerald-500/40 transition-colors">
                                    <Hash className="w-4 h-4 text-emerald-600 dark:text-emerald-500" />
                                </div>
                            </div>
                        </div>
                        <div
                            className="flex justify-between items-center p-2.5 bg-neutral-100 dark:bg-white/5 border border-neutral-300 dark:border-neutral-600 rounded-xl group cursor-pointer hover:bg-emerald-50 dark:hover:bg-emerald-500/10 hover:border-emerald-300 dark:hover:border-emerald-500/30 transition-all active:scale-[0.98]"
                            onClick={(e) => {
                                e.stopPropagation();
                                if (unitsInBox > 0) {
                                    setAlertMessage(t('ws.closeBoxBeforeChange'));
                                    return;
                                }
                                setIsDatePickerOpen(true);
                            }}
                        >
                            <span className="text-xs uppercase tracking-wider text-neutral-500 font-bold">{t('ws.dateLabel')}</span>
                            <div className="flex items-center gap-3">
                                <span className="text-lg font-mono font-bold text-neutral-900 dark:text-white group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">
                                    {labelingDate.toLocaleDateString('ru-RU')}
                                </span>
                                <div className="p-2 bg-white dark:bg-neutral-700 border border-neutral-300 dark:border-neutral-600 rounded-lg group-hover:bg-emerald-100 dark:group-hover:bg-emerald-500/20 group-hover:border-emerald-400 dark:group-hover:border-emerald-500/40 transition-colors">
                                    <Calendar className="w-4 h-4 text-emerald-600 dark:text-emerald-500" />
                                </div>
                            </div>
                        </div>
                        <div className="flex justify-between text-sm py-1.5 border-b border-neutral-200 dark:border-neutral-600">
                            <span className="text-neutral-500">{t('ws.packNum')}</span>
                            <span className="font-mono text-emerald-600 dark:text-emerald-400">{displayPackNumber || '--'}</span>
                        </div>
                        <div className="flex justify-between text-sm py-1.5 border-b border-neutral-200 dark:border-neutral-600">
                            <span className="text-neutral-500">{t('ws.boxNum')}</span>
                            <span className="font-mono text-emerald-600 dark:text-emerald-400">{displayBoxNumber || '--'}</span>
                        </div>
                        <div className="py-1.5 border-b border-neutral-200 dark:border-neutral-600">
                            <div className="flex justify-between text-sm mb-1.5">
                                <span className="text-neutral-500">{t('ws.inBox')}</span>
                                <div className="flex items-center gap-2">
                                    <span className="font-mono text-neutral-900 dark:text-white">{unitsInBox}</span>
                                    <span className="text-neutral-500 dark:text-neutral-600">/ {selectedProduct?.close_box_counter || '-'}</span>
                                </div>
                            </div>
                            {boxFillLimit > 0 && (
                                <div className="h-2 w-full rounded-full bg-neutral-200 dark:bg-white/10 overflow-hidden">
                                    <div className={`h-full rounded-full transition-all duration-300 ${boxFillColor}`} style={{ width: `${boxFillPct}%` }}></div>
                                </div>
                            )}
                        </div>
                        <div className="flex justify-between text-sm py-1.5 border-b border-neutral-200 dark:border-neutral-600">
                            <span className="text-neutral-500">{t('ws.boxesOnPallet')}</span>
                            <span className="font-mono text-amber-600 dark:text-amber-400">{boxesInPallet}</span>
                        </div>
                        <div className="flex justify-between text-sm py-1.5">
                            <span className="text-neutral-500">{t('ws.totalUnits')}</span>
                            <span className="font-mono text-neutral-900 dark:text-white">{totalUnits}</span>
                        </div>
                        {lastPrintInfo && (
                            <div className="flex justify-between text-xs pt-1 text-amber-600 dark:text-amber-400/80">
                                <span className="uppercase tracking-wider">{t('ws.lastPrinted')}</span>
                                <span className="font-mono">#{lastPrintInfo.label} · {lastPrintInfo.time}</span>
                            </div>
                        )}
                    </div>


                </div>
            </div>
            {/* Transient print-success toast (manual print) */}
            {printToast && (
                <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[250] px-6 py-3 rounded-2xl bg-emerald-600 text-white font-semibold shadow-[0_10px_30px_-8px_rgba(16,185,129,0.6)] flex items-center gap-2 animate-in fade-in slide-in-from-bottom-2 duration-200">
                    <Printer className="w-5 h-5" />
                    {printToast}
                </div>
            )}

            {/* Custom Alert Modal */}
            {alertMessage && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[300] flex items-center justify-center p-4 animate-in fade-in duration-200">
                    <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-600 rounded-[2rem] p-10 max-w-2xl w-full text-center shadow-2xl relative animate-in zoom-in-95 duration-200">
                        <button
                            onClick={() => setAlertMessage(null)}
                            className="absolute top-6 right-6 p-2 bg-neutral-100 dark:bg-white/5 hover:bg-neutral-200 dark:hover:bg-white/10 rounded-full transition-colors"
                        >
                            <X className="w-8 h-8 text-neutral-500 dark:text-neutral-400" />
                        </button>

                        <div className="mx-auto w-24 h-24 bg-red-100 dark:bg-red-500/10 rounded-full flex items-center justify-center mb-8">
                            <AlertCircle className="w-12 h-12 text-red-500" />
                        </div>

                        <h3 className="text-3xl font-bold text-neutral-900 dark:text-white mb-4">{t('ws.attention')}</h3>

                        <p className="text-xl text-neutral-600 dark:text-neutral-400 mb-10 whitespace-pre-line leading-relaxed">
                            {alertMessage}
                        </p>

                        <button
                            onClick={() => setAlertMessage(null)}
                            className="w-full py-6 !bg-neutral-800 hover:!bg-neutral-700 dark:!bg-neutral-300 dark:hover:!bg-neutral-200 !text-white dark:!text-black active:!bg-neutral-900 dark:active:!bg-neutral-400 active:scale-[0.98] transition-all rounded-2xl font-bold text-xl shadow-lg border border-transparent dark:border-neutral-600"
                        >
                            {t('ws.ok')}
                        </button>
                    </div>
                </div>
            )}

            {/* Numeric Keypad Modal */}
            {isKeypadOpen && (
                <NumericKeypad
                    value={batchNumber}
                    onUpdate={setBatchNumber}
                    onClose={() => setIsKeypadOpen(false)}
                    title={t('ws.batchModalTitle')}
                />
            )}

            {isDatePickerOpen && (
                <DatePickerModal
                    value={labelingDate}
                    onUpdate={setLabelingDate}
                    onClose={() => setIsDatePickerOpen(false)}
                    title={t('ws.dateModalTitle')}
                />
            )}

            <DeleteItemsModal
                isOpen={isDeleteModalOpen}
                onClose={() => setIsDeleteModalOpen(false)}
                onDeleted={async () => {
                    // Refresh counters
                    const nomenclatureId = selectedProduct?.id;
                    const latest = await window.electron.invoke('get-latest-counters', nomenclatureId);
                    if (latest) {
                        setTotalUnits(latest.totalUnits);
                        setTotalBoxes(latest.totalBoxes);
                        setUnitsInBox(latest.unitsInBox);
                        setBoxesInPallet(latest.boxesInPallet);

                        setCurrentBoxId(latest.currentBoxId);
                        setCurrentBoxNumber(latest.currentBoxNumber);
                        setBoxNetWeight(latest.boxNetWeight || 0);
                    } else {
                        setCurrentBoxId(null);
                        setCurrentBoxNumber(null);
                        setBoxNetWeight(0);
                    }
                }}
            />

            {isProductModalOpen && (
                <ProductSelectionModal
                    products={products}
                    onSelect={handleSelectProduct}
                    onClose={() => setIsProductModalOpen(false)}
                />
            )}

            {/* Alert Modal */}
        </div>
    );
};

export default WeighingStation;
