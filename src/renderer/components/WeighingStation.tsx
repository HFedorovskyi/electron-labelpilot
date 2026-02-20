import React, { useEffect, useState, useRef } from 'react';
import { Printer, RefreshCw, Box, AlertCircle, X, Hash, Layers, Calendar } from 'lucide-react';
import { generateBarcode, type BarcodeData } from '../utils/barcodeGenerator';
import { useTranslation } from '../i18n';
import NumericKeypad from './NumericKeypad';
import DeleteItemsModal from './DeleteItemsModal';
import DatePickerModal from './DatePickerModal';

const WeighingStation = ({ activeTab }: { activeTab?: string }) => {
    const { t } = useTranslation();
    // --- STATE DECLARATIONS ---
    const [weight, setWeight] = useState<string>('0.000');
    const [status, setStatus] = useState<string>('disconnected');
    const [labelDoc, setLabelDoc] = useState<any>(null);

    const [products, setProducts] = useState<any[]>([]);
    const [selectedProduct, setSelectedProduct] = useState<any | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const [alertMessage, setAlertMessage] = useState<string | null>(null);
    const [numberingConfig, setNumberingConfig] = useState<any>(null);

    const [containers, setContainers] = useState<any[]>([]);

    const [boxLabelDoc, setBoxLabelDoc] = useState<any>(null);
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
        autoPrintOnStable: false
    });

    const [batchNumber, setBatchNumber] = useState<string>('');
    const [isKeypadOpen, setIsKeypadOpen] = useState(false);
    const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
    const [labelingDate, setLabelingDate] = useState<Date>(new Date());
    const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);

    // Auto-print refs to prevent duplicate prints
    const autoPrintFiredRef = useRef(false);
    const isPrintingRef = useRef(false);
    const weightRef = useRef('0.000');
    const componentReadyRef = useRef(false);

    // --- EFFECTS ---
    useEffect(() => {
        const loadStationInfo = async () => {
            try {
                const info = await window.electron.invoke('get-station-info');
                if (info) {
                    if (info.station_number) setStationNumber(info.station_number);
                }

                // Get latest records from history
                const latest = await window.electron.invoke('get-latest-counters');
                console.log('Latest Counters from DB:', latest);
                if (latest) {
                    if (latest.totalUnits !== undefined) setTotalUnits(latest.totalUnits);
                    if (latest.totalBoxes !== undefined) setTotalBoxes(latest.totalBoxes);
                    if (latest.boxesInPallet !== undefined) setBoxesInPallet(latest.boxesInPallet);
                }
            } catch (e) {
                console.error('Failed to load station info', e);
            }
        };
        loadStationInfo();

        // Delay enabling auto-print to avoid firing on startup
        const readyTimer = setTimeout(() => { componentReadyRef.current = true; }, 2000);
        return () => clearTimeout(readyTimer);
    }, []);



    // --- HELPER FUNCTIONS ---
    const getGrossWeight = () => {
        if (!selectedProduct) return weight;
        const currentWeight = parseFloat(weight);
        // Try to find container first
        if (selectedProduct.portion_container_id) {
            const container = containers.find(c => c.id === selectedProduct.portion_container_id);
            if (container) {
                return (currentWeight + container.weight / 1000).toFixed(3);
            }
        }
        // Fallback to direct portion_weight if present
        return (currentWeight + (selectedProduct.portion_weight || 0) / 1000).toFixed(3);
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
        const weightNettoPack = currentWeightVal;
        const portionContainer = containers.find(c => c.id === selectedProduct?.portion_container_id);
        const weightBruttoPack = weightNettoPack + (portionContainer?.weight || 0) / 1000;

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

        const getFormattedCounter = (count: number, labelDoc: any, placeholder: string): string => {
            // Base: Station + Count
            const stationPrefix = stationNumber ? String(stationNumber).padStart(2, '0') : '';
            const countStr = String(count);

            // Check for minLength in template
            let minLength = 0;
            const items = labelDoc ? (labelDoc.elements || labelDoc.objects) : null;
            if (items) {
                const el = items.find((e: any) => e.type === 'text' && ((e.value && e.value.includes(placeholder)) || (e.text && e.text.includes(placeholder))));
                if (el && el.minLength) minLength = Number(el.minLength);
            }

            // Formatting Logic
            if (minLength > 0) {
                // If minLength is set, we assume it refers to the TOTAL length of the ID
                // Format: [StationPrefix][PaddedCounter]
                // Example: Station 06, Count 1, MinLength 8 -> 06000001
                const targetCountLength = Math.max(0, minLength - stationPrefix.length);
                return stationPrefix + countStr.padStart(targetCountLength, '0');
            } else {
                // Default: Just concatenate
                return stationPrefix + countStr;
            }
        };

        // Select the template document to use for looking up minLength/formatting rules
        const activeLabelDoc = isBoxLabel ? boxLabelDoc : labelDoc;

        // For Pack Label
        let unitNumStr = '';
        if (stationNumber) {
            // We use totalUnits for the permanent individual pack number.
            // unitsInBox is used for "Pack X of Y" statistics.
            unitNumStr = getFormattedCounter(totalUnits + 1, activeLabelDoc, '{{pack_number}}');
        } else {
            // Fallback to local config
            unitNumStr = numberingConfig?.unit?.enabled
                ? `${numberingConfig.unit.prefix || ''}${String(totalUnits + 1).padStart(numberingConfig.unit.length, '0')}`
                : String(totalUnits + 1);
        }

        // For Box Label
        let boxNumStr = '';
        if (stationNumber) {
            boxNumStr = getFormattedCounter(totalBoxes + 1, activeLabelDoc, '{{box_number}}');
        } else {
            boxNumStr = numberingConfig?.box?.enabled
                ? `${numberingConfig.box.prefix || ''}${String(totalBoxes + 1).padStart(numberingConfig.box.length, '0')}`
                : String(totalBoxes + 1);
        }

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
            close_box_counter: selectedProduct?.close_box_counter?.toString() || '',

            // Raw numeric values for barcode generator
            _raw_weight_netto_pack: weightNettoPack,
            _raw_weight_brutto_pack: weightBruttoPack,
            _raw_weight_netto_box: effectiveBoxNet,
            _raw_weight_brutto_box: weightBruttoBox,

            ...extra
        };

        console.log('DEBUG: Generated Label Data:', dataObj);
        if (window.electron && window.electron.send) {
            window.electron.send('log-to-main', `DEBUG Renderer: Data keys: ${Object.keys(dataObj).join(', ')}`);
        }

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



    // Label Structure Diagnostic
    useEffect(() => {
        window.electron.invoke('get-all-labels').then((labels: any) => {
            window.electron.send('log-to-main', `DEBUG: Full Labels Dump: ${JSON.stringify(labels)}`);
        }).catch(err => {
            console.error('Failed to dump labels', err);
        });
    }, []);

    // Scale, Status, Sync Listeners
    useEffect(() => {
        const removeReadingListener = window.electron.on('scale-reading', (data: any) => {
            if (data && typeof data === 'object' && 'weight' in data) {
                const w = typeof data.weight === 'number' ? data.weight : parseFloat(String(data.weight));
                setWeight(w.toFixed(3));
                weightRef.current = w.toFixed(3);
                setIsStable(!!data.stable);

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
            loadProducts(searchQuery);
        });

        return () => {
            removeReadingListener();
            removeStatusListener();
            removeErrorListener();
            removeUpdateListener();
        };
    }, [searchQuery]);

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

    // Auto-print on weight stabilization
    // Only reacts to isStable changes (not every weight reading) to avoid blocking React rendering
    useEffect(() => {
        if (
            !componentReadyRef.current ||
            !printerConfig.autoPrintOnStable ||
            !isStable ||
            !selectedProduct ||
            !labelDoc ||
            autoPrintFiredRef.current ||
            isPrintingRef.current ||
            activeTab !== 'weighing'
        ) return;

        // Check weight from ref (avoids putting weight in deps which would cause effect to fire ~7/sec)
        const currentWeight = parseFloat(weightRef.current);
        if (currentWeight <= 0.010) return;

        autoPrintFiredRef.current = true;
        handlePrint().catch((err) => {
            console.error('Auto-print failed:', err);
            isPrintingRef.current = false;
        });
    }, [isStable, selectedProduct, labelDoc, printerConfig.autoPrintOnStable]);

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
                setBoxLabelDoc(null);
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
                    } else {
                        console.warn('DEBUG: Pack Label structure invalid or missing');
                    }
                } catch (err) {
                    console.error('Failed to fetch pack label template:', err);
                }
            } else {
                setLabelDoc(null);
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
                    } else {
                        console.warn('DEBUG: Box Label structure invalid or missing', doc);
                    }
                } catch (err) {
                    console.error('Failed to fetch box label template:', err);
                }
            } else {
                setBoxLabelDoc(null);
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
    }, [selectedProduct]);

    const handleRepeat = async () => {
        if (!lastPrinted) {
            setAlertMessage('Нет данных для повторной печати.\n(No label printed yet)');
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
            setAlertMessage('Нельзя закрыть пустой короб!\n(Box is empty)');
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

            const boxData = {
                ...baseData,
                is_box: true,
                count: boxLimit,
                pack_counter: String(finalUnitsInBox), // Actual count in this box
                weight_netto: finalBoxWeight.toFixed(3),
                barcode: boxBarcode || baseData.barcode
            };

            await window.electron.invoke('print-label', {
                silent: true,
                labelDoc: boxLabelDoc,
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
            setAlertMessage('Шаблон этикетки короба не найден!');
        }
    };

    const handlePrint = async () => {
        if (isPrintingRef.current) return;
        isPrintingRef.current = true;

        try {
            if (!labelDoc) {
                console.warn('Cannot print: No label template selected');
                isPrintingRef.current = false;
                return;
            }

            const currentWeight = parseFloat(weight);
            const boxLimit = selectedProduct?.close_box_counter || 999999;

            // 1. Get PREDICTED Box Number for Record-Pack if no box is open
            // We use a dummy dataObj to get the predicted number
            const predictedData = getLabelData();
            const predictedBoxNum = currentBoxNumber || predictedData.box_number;

            // 2. Record Pack to DB FIRST
            // This ensures we have the CORRECT box_id and box_number from the DB
            const recordResult = await window.electron.invoke('record-pack', {
                number: predictedData.pack_number,
                box_number: predictedBoxNum,
                nomenclature_id: selectedProduct.id,
                weight_netto: parseFloat(predictedData.weight_netto_pack),
                weight_brutto: parseFloat(predictedData.weight_brutto_pack),
                barcode_value: '', // We don't have final barcode yet, that's okay, we'll update if needed or just live with it? 
                // Actually, record-pack stores the barcode_value. 
                // Let's generate a PRELIMINARY barcode.
                station_number: stationNumber
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

            // 4. Generate FINAL Label Data using the ACTUAL box number
            // We override the box_number in dataObj
            const finalPrintData = getLabelData();
            finalPrintData.box_number = actualBoxNumber;
            // Regenerate barcode with actual box number if it changed (though unlikely for pack label)

            // 5. Update pack record with final barcode in background (optional, for data integrity)
            // But usually the barcode_value in pack table is used for re-printing.

            // 6. Launch Printing in Background
            window.electron.invoke('print-label', {
                silent: true,
                labelDoc,
                data: finalPrintData,
                printerConfig: printerConfig.packPrinter || undefined
            }).catch(err => console.error('Background Printing Error:', err));

            setLastPrinted({ doc: labelDoc, data: finalPrintData });

            // 7. Update Box Stats
            const newUnitsInBox = unitsInBox + 1;
            const newBoxNetWeight = boxNetWeight + currentWeight;

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

                    const boxData = {
                        ...baseData,
                        is_box: true,
                        count: boxLimit,
                        pack_counter: String(finalUnitsInBox),
                        weight_netto: finalBoxWeight.toFixed(3),
                        barcode: boxBarcode || baseData.barcode
                    };

                    window.electron.invoke('print-label', {
                        silent: true,
                        labelDoc: boxLabelDoc,
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

            isPrintingRef.current = false;
        } catch (err) {
            console.error('Print Error:', err);
            setAlertMessage(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
            isPrintingRef.current = false;
        }
    };



    const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
        const query = e.target.value;
        setSearchQuery(query);
        loadProducts(query);
        setIsMenuOpen(true);
    };

    const handleSelectProduct = (product: any) => {
        if (unitsInBox > 0) {
            setAlertMessage(t('ws.closeBoxBeforeChange'));
            return;
        }
        setSelectedProduct(product);
        setCurrentBoxId(null);
        setCurrentBoxNumber(null);
        setSearchQuery('');
        setIsMenuOpen(false);
    };

    return (
        <div className="grid grid-cols-12 gap-6 h-full p-4 relative" onClick={() => setIsMenuOpen(false)}>
            {/* Product Information Card */}
            <div className="col-span-8 bg-neutral-900/50 border border-white/5 rounded-3xl p-8 backdrop-blur shadow-2xl">
                <div className="flex justify-between items-start mb-8">
                    <div>
                        <h2 className="text-2xl font-semibold text-white">{t('ws.title')}</h2>
                    </div>
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
                        {status === 'connected' ? t('ws.scaleStatus.connected') :
                            (status === 'reconnecting' || status === 'connecting') ? t('ws.scaleStatus.connecting') : t('ws.scaleStatus.disconnected')}
                    </div>
                    {/* Auto-print indicator */}
                    {printerConfig.autoPrintOnStable && (
                        <div className={`ml-4 px-3 py-1 rounded-full text-xs font-medium border flex items-center gap-2 ${autoPrintFiredRef.current
                            ? 'bg-amber-500/10 border-amber-500/20 text-amber-400'
                            : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                            }`}>
                            <Printer className="w-3 h-3" />
                            {autoPrintFiredRef.current ? t('ws.printed') : t('ws.autoPrintActive')}
                        </div>
                    )}
                </div>

                <div className="space-y-6 relative">
                    <div onClick={(e) => e.stopPropagation()}>
                        <label className="block text-sm font-medium text-neutral-400 mb-2">{t('ws.search')}</label>
                        <input
                            type="text"
                            placeholder={selectedProduct ? selectedProduct.name : "..."}
                            value={isMenuOpen ? searchQuery : (selectedProduct?.name || '')}
                            onChange={handleSearch}
                            onFocus={() => setIsMenuOpen(true)}
                            className="w-full bg-black/20 border border-white/10 rounded-2xl px-5 py-4 text-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all text-white placeholder-neutral-500/50"
                        />
                        {/* Dropdown Menu */}
                        {isMenuOpen && (products.length > 0 || searchQuery !== '') && (
                            <div className="absolute w-full mt-2 bg-neutral-900 border border-white/10 rounded-2xl shadow-xl max-h-60 overflow-y-auto z-50">
                                {products.length > 0 ? products.map((p: any) => (
                                    <div
                                        key={p.id}
                                        onClick={() => handleSelectProduct(p)}
                                        className="px-5 py-3 hover:bg-emerald-500/20 cursor-pointer flex justify-between items-center group transition-colors"
                                    >
                                        <span className="text-white group-hover:text-emerald-100">{p.name} <span className="text-neutral-500 text-sm ml-2">({p.article})</span></span>
                                    </div>
                                )) : (
                                    <div className="px-5 py-3 text-neutral-500 italic">{t('ws.noProducts')}</div>
                                )}
                            </div>
                        )}
                    </div>

                    <div className="p-6 bg-emerald-500/5 border border-emerald-500/10 rounded-2xl min-h-[140px] flex flex-col justify-center">
                        {selectedProduct ? (
                            <>
                                <h3 className="text-sm uppercase tracking-wider text-emerald-500/60 font-bold mb-2">{t('products.name')}</h3>
                                <div className="text-3xl font-bold text-emerald-100">{selectedProduct.name}</div>
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
                <div className="mt-8 grid grid-cols-2 gap-4">
                    <div className="bg-black/30 border border-white/10 rounded-3xl p-8 text-center relative overflow-hidden group">
                        <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
                        <label className="text-xs uppercase tracking-widest text-neutral-500 font-bold">{t('ws.net')}</label>
                        <div className="text-7xl font-mono text-emerald-400 mt-2 font-light tracking-tighter">
                            {weight} <span className="text-2xl text-emerald-500/50">{t('ws.kg')}</span>
                        </div>
                        {isStable && (
                            <div className="mt-2 text-emerald-500/60 text-xs font-bold uppercase tracking-widest animate-pulse flex items-center justify-center gap-2">
                                <div className="w-1 h-1 rounded-full bg-emerald-500"></div>
                                {t('ws.stable')}
                            </div>
                        )}
                    </div>
                    <div className="bg-black/30 border border-white/10 rounded-3xl p-8 text-center">
                        <label className="text-xs uppercase tracking-widest text-neutral-500 font-bold">{t('ws.gross')}</label>
                        <div className="text-7xl font-mono text-neutral-300 mt-2 font-light tracking-tighter">
                            {getGrossWeight()} <span className="text-2xl text-neutral-600">{t('ws.kg')}</span>
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
                    {t('ws.print')}
                </button>

                <div className="grid grid-cols-2 gap-4">
                    <button
                        onClick={handleRepeat}
                        className="py-6 bg-neutral-800/50 hover:bg-neutral-800 border border-white/5 hover:border-white/10 rounded-2xl font-semibold transition-all flex flex-col items-center gap-2 group"
                    >
                        <RefreshCw className="w-6 h-6 text-neutral-400 group-hover:text-white transition-colors" />
                        <span className="text-neutral-400 group-hover:text-white uppercase text-xs tracking-widest">{t('ws.reprintSmall')}</span>
                    </button>
                    <button
                        onClick={handleCloseBox}
                        className="py-6 bg-neutral-800/50 hover:bg-neutral-800 border border-white/5 hover:border-white/10 rounded-2xl font-semibold transition-all flex flex-col items-center gap-2 group"
                    >
                        <Box className="w-6 h-6 text-neutral-400 group-hover:text-white transition-colors" />
                        <span className="text-neutral-400 group-hover:text-white uppercase text-xs tracking-widest">{t('ws.closeBox')}</span>
                    </button>
                    <button
                        onClick={() => setIsDeleteModalOpen(true)}
                        className="py-6 bg-neutral-800/50 hover:bg-red-900/30 border border-white/5 hover:border-red-500/30 rounded-2xl font-semibold transition-all flex flex-col items-center gap-2 group"
                    >
                        <Layers className="w-6 h-6 text-neutral-400 group-hover:text-red-400 transition-colors" />
                        <span className="text-neutral-400 group-hover:text-red-400 uppercase text-xs tracking-widest">Удаление</span>
                    </button>
                </div>

                <div className="mt-auto p-6 bg-neutral-900/50 border border-white/5 rounded-3xl backdrop-blur">
                    <h3 className="text-sm font-semibold mb-4 text-white/60 uppercase tracking-widest">{t('ws.sessionStats')}</h3>
                    <div className="space-y-3">
                        <div
                            className="flex justify-between items-center p-3 bg-white/5 border border-white/10 rounded-xl group cursor-pointer hover:bg-emerald-500/10 hover:border-emerald-500/30 transition-all active:scale-[0.98]"
                            onClick={(e) => {
                                e.stopPropagation();
                                if (unitsInBox > 0) {
                                    setAlertMessage(t('ws.closeBoxBeforeChange'));
                                    return;
                                }
                                setIsKeypadOpen(true);
                            }}
                        >
                            <span className="text-xs uppercase tracking-wider text-neutral-500 font-bold">Партия</span>
                            <div className="flex items-center gap-3">
                                <span className="text-xl font-mono font-bold text-white group-hover:text-emerald-400 transition-colors">
                                    {batchNumber || <span className="text-neutral-700 italic text-sm">Ввести...</span>}
                                </span>
                                <div className="p-2 bg-neutral-800 border border-white/10 rounded-lg group-hover:bg-emerald-500/20 group-hover:border-emerald-500/40 transition-colors">
                                    <Hash className="w-4 h-4 text-emerald-500" />
                                </div>
                            </div>
                        </div>
                        <div
                            className="flex justify-between items-center p-3 bg-white/5 border border-white/10 rounded-xl group cursor-pointer hover:bg-emerald-500/10 hover:border-emerald-500/30 transition-all active:scale-[0.98]"
                            onClick={(e) => {
                                e.stopPropagation();
                                if (unitsInBox > 0) {
                                    setAlertMessage(t('ws.closeBoxBeforeChange'));
                                    return;
                                }
                                setIsDatePickerOpen(true);
                            }}
                        >
                            <span className="text-xs uppercase tracking-wider text-neutral-500 font-bold">Дата марк.</span>
                            <div className="flex items-center gap-3">
                                <span className="text-xl font-mono font-bold text-white group-hover:text-emerald-400 transition-colors">
                                    {labelingDate.toLocaleDateString('ru-RU')}
                                </span>
                                <div className="p-2 bg-neutral-800 border border-white/10 rounded-lg group-hover:bg-emerald-500/20 group-hover:border-emerald-500/40 transition-colors">
                                    <Calendar className="w-4 h-4 text-emerald-500" />
                                </div>
                            </div>
                        </div>
                        <div className="flex justify-between text-sm py-2 border-b border-white/5">
                            <span className="text-neutral-500">{t('ws.packNum')}</span>
                            <span className="font-mono text-emerald-400">{getLabelData().pack_number || '--'}</span>
                        </div>
                        <div className="flex justify-between text-sm py-2 border-b border-white/5">
                            <span className="text-neutral-500">{t('ws.boxNum')}</span>
                            <span className="font-mono text-emerald-400">{getLabelData(undefined, true).box_number || '--'}</span>
                        </div>
                        <div className="flex justify-between text-sm py-2 border-b border-white/5">
                            <span className="text-neutral-500">{t('ws.inBox')}</span>
                            <div className="flex items-center gap-2">
                                <span className="font-mono text-white">{unitsInBox}</span>
                                <span className="text-neutral-600">/ {selectedProduct?.close_box_counter || '-'}</span>
                            </div>
                        </div>
                        <div className="flex justify-between text-sm py-2 border-b border-white/5">
                            <span className="text-neutral-500">{t('ws.boxesOnPallet')}</span>
                            <span className="font-mono text-amber-400">{boxesInPallet}</span>
                        </div>
                        <div className="flex justify-between text-sm py-2">
                            <span className="text-neutral-500">{t('ws.totalUnits')}</span>
                            <span className="font-mono text-white">{totalUnits}</span>
                        </div>
                    </div>


                </div>
            </div>
            {/* Custom Alert Modal */}
            {alertMessage && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4 animate-in fade-in duration-200">
                    <div className="bg-neutral-900 border border-white/10 rounded-[2rem] p-10 max-w-2xl w-full text-center shadow-2xl relative animate-in zoom-in-95 duration-200">
                        <button
                            onClick={() => setAlertMessage(null)}
                            className="absolute top-6 right-6 p-2 bg-white/5 hover:bg-white/10 rounded-full transition-colors"
                        >
                            <X className="w-8 h-8 text-neutral-400" />
                        </button>

                        <div className="mx-auto w-24 h-24 bg-red-500/10 rounded-full flex items-center justify-center mb-8">
                            <AlertCircle className="w-12 h-12 text-red-500" />
                        </div>

                        <h3 className="text-3xl font-bold text-white mb-4">{t('ws.attention')}</h3>

                        <p className="text-xl text-neutral-400 mb-10 whitespace-pre-line leading-relaxed">
                            {alertMessage}
                        </p>

                        <button
                            onClick={() => setAlertMessage(null)}
                            className="w-full py-6 !bg-neutral-300 hover:!bg-neutral-200 !text-black active:!bg-neutral-400 active:scale-[0.98] transition-all rounded-2xl font-bold text-xl shadow-lg border border-white/20"
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
                    title="Номер партии"
                />
            )}

            {isDatePickerOpen && (
                <DatePickerModal
                    value={labelingDate}
                    onUpdate={setLabelingDate}
                    onClose={() => setIsDatePickerOpen(false)}
                    title="Дата маркировки"
                />
            )}

            <DeleteItemsModal
                isOpen={isDeleteModalOpen}
                onClose={() => setIsDeleteModalOpen(false)}
                onDeleted={async () => {
                    // Refresh counters
                    const latest = await window.electron.invoke('get-latest-counters');
                    if (latest) {
                        setTotalUnits(latest.totalUnits);
                        setTotalBoxes(latest.totalBoxes);
                        setUnitsInBox(latest.unitsInBox);
                        setBoxesInPallet(latest.boxesInPallet);
                    }

                    // We also need to refresh local state if the current box/pack was deleted
                    const openContent = await window.electron.invoke('get-open-pallet-content');
                    if (openContent && openContent.openBox) {
                        // setUnitsInBox(openContent.packsInCurrentBox?.length || 0); // Already set by get-latest-counters
                        setCurrentBoxId(openContent.openBox.id);
                        setCurrentBoxNumber(openContent.openBox.number);
                        setBoxNetWeight(openContent.openBox.weight_netto || 0);
                    } else {
                        // No open box
                        // setUnitsInBox(0); // Already set by get-latest-counters
                        setCurrentBoxId(null);
                        setCurrentBoxNumber(null);
                        setBoxNetWeight(0);
                    }
                }}
            />



            {/* Alert Modal */}
        </div>
    );
};

export default WeighingStation;
