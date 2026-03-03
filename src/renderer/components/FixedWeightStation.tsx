import { useEffect, useState, useRef, useCallback } from 'react';
import { Printer, RefreshCw, Box, AlertCircle, X, Hash, Calendar, Search, Scale, Package, Play, Square, CheckCircle2, Layers } from 'lucide-react';
import { generateBarcode, type BarcodeData } from '../utils/barcodeGenerator';
import { useTranslation } from '../i18n';
import NumericKeypad from './NumericKeypad';
import DeleteItemsModal from './DeleteItemsModal';
import DatePickerModal from './DatePickerModal';
import ProductSelectionModal from './ProductSelectionModal';

type SubMode = 'scale' | 'count';

const FixedWeightStation = ({ activeTab }: { activeTab?: string }) => {
    const { t } = useTranslation();

    // --- SUB-MODE ---
    const [subMode, setSubMode] = useState<SubMode>('scale');

    // --- SHARED STATE ---
    const [weight, setWeight] = useState<string>('0.000');
    const [status, setStatus] = useState<string>('disconnected');
    const [labelDoc, setLabelDoc] = useState<any>(null);
    const [products, setProducts] = useState<any[]>([]);
    const [selectedProduct, setSelectedProduct] = useState<any | null>(null);
    const [isProductModalOpen, setIsProductModalOpen] = useState(false);
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
    const [printerConfig, setPrinterConfig] = useState<any>({ packPrinter: '', boxPrinter: '', autoPrintOnStable: false });
    const [isReady, setIsReady] = useState(false);
    const [stableTrigger, setStableTrigger] = useState(0);
    const [batchNumber, setBatchNumber] = useState<string>('');
    const [isKeypadOpen, setIsKeypadOpen] = useState(false);
    const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
    const [labelingDate, setLabelingDate] = useState<Date>(new Date());
    const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);
    const [syncVersion, setSyncVersion] = useState(0);

    // Auto-print refs
    const autoPrintFiredRef = useRef(false);
    const isPrintingRef = useRef(false);
    const weightRef = useRef('0.000');

    // --- COUNT MODE STATE ---
    const [packsPerBoxInput, setPacksPerBoxInput] = useState(0);
    const [totalBoxesInput, setTotalBoxesInput] = useState(0);
    const [isCountPrinting, setIsCountPrinting] = useState(false);
    const [countCurrentBox, setCountCurrentBox] = useState(0);
    const [countCurrentPack, setCountCurrentPack] = useState(0);
    const [showPacksKeypad, setShowPacksKeypad] = useState(false);
    const [showBoxesKeypad, setShowBoxesKeypad] = useState(false);
    const cancelCountRef = useRef(false);

    // --- WEIGHT RANGE CHECK ---
    const getWeightGrams = useCallback(() => parseFloat(weight) * 1000, [weight]);

    const isWeightInRange = useCallback(() => {
        if (!selectedProduct) return false;
        const wGrams = getWeightGrams();
        const min = selectedProduct.min_weight_grams || 0;
        const max = selectedProduct.max_weight_grams || Infinity;
        return wGrams >= min && wGrams <= max;
    }, [selectedProduct, getWeightGrams]);

    // --- LOAD ---
    useEffect(() => {
        const loadStationInfo = async () => {
            try {
                const info = await window.electron.invoke('get-station-info');
                if (info?.station_number) setStationNumber(info.station_number);
            } catch (e) { console.error('Failed to load station info', e); }
        };
        loadStationInfo();
        const readyTimer = setTimeout(() => { setIsReady(true); }, 1500);
        return () => clearTimeout(readyTimer);
    }, []);

    useEffect(() => {
        const syncCounters = async () => {
            try {
                const latest = await window.electron.invoke('get-latest-counters', selectedProduct?.id);
                if (latest) {
                    if (latest.totalUnits !== undefined) setTotalUnits(latest.totalUnits);
                    if (latest.totalBoxes !== undefined) setTotalBoxes(latest.totalBoxes);
                    if (latest.boxesInPallet !== undefined) setBoxesInPallet(latest.boxesInPallet);
                    if (latest.unitsInBox !== undefined) setUnitsInBox(latest.unitsInBox);
                    if (latest.boxNetWeight !== undefined) setBoxNetWeight(latest.boxNetWeight);
                    if (latest.currentBoxId !== undefined) setCurrentBoxId(latest.currentBoxId);
                    if (latest.currentBoxNumber !== undefined) setCurrentBoxNumber(latest.currentBoxNumber);
                }
            } catch (e) { console.error('Failed to load counters', e); }
        };
        syncCounters();
    }, [selectedProduct]);

    // --- HELPER: getNetWeight ---
    const getNetWeight = () => {
        if (!selectedProduct) return weight;
        const cw = parseFloat(weight);
        const pc = selectedProduct.portion_container_id ? containers.find(c => String(c.id) === String(selectedProduct.portion_container_id)) : null;
        const tareKg = (pc?.weight || selectedProduct.portion_weight || 0) / 1000;
        return Math.max(0, cw - tareKg).toFixed(3);
    };

    // --- HELPER: getLabelData (reuse pattern from WeighingStation) ---
    const getLabelData = (overrideWeight?: number, isBoxLabel = false, overrideUnits?: number, overrides?: { totalUnits?: number; totalBoxes?: number; unitsInBox?: number; boxNetWeight?: number }) => {
        const currentWeightVal = overrideWeight !== undefined ? overrideWeight : parseFloat(weight);
        const now = labelingDate;
        const expDays = selectedProduct?.exp_date || 0;
        const expDate = new Date(now);
        expDate.setDate(now.getDate() + expDays);
        const formatDate = (d: Date) => d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const formatFullDate = (d: Date) => {
            const day = String(d.getDate()).padStart(2, '0');
            const month = String(d.getMonth() + 1).padStart(2, '0');
            return `${day}.${month}.${d.getFullYear()}`;
        };

        let extra: any = {};
        try {
            if (selectedProduct?.extra_data) {
                extra = typeof selectedProduct.extra_data === 'string' ? JSON.parse(selectedProduct.extra_data) : selectedProduct.extra_data;
            }
        } catch (e) { }

        // Use overrides if provided (for count mode where React state is stale)
        const effectiveTotalUnits = overrides?.totalUnits ?? totalUnits;
        const effectiveTotalBoxes = overrides?.totalBoxes ?? totalBoxes;
        const effectiveUnitsInBox = overrides?.unitsInBox ?? unitsInBox;
        const effectiveBoxNetWeight = overrides?.boxNetWeight ?? boxNetWeight;

        const weightBruttoPack = currentWeightVal;
        const portionContainer = containers.find(c => String(c.id) === String(selectedProduct?.portion_container_id));
        const tarePack = (portionContainer?.weight || selectedProduct?.portion_weight || 0) / 1000;
        const weightNettoPack = Math.max(0, weightBruttoPack - tarePack);
        const effectiveBoxNet = isBoxLabel ? currentWeightVal : (effectiveBoxNetWeight + weightNettoPack);
        const boxContainer = containers.find(c => c.id === selectedProduct?.box_container_id);
        const tarePackGrams = portionContainer?.weight || 0;
        const tareBoxGrams = boxContainer?.weight || 0;
        let packsInThisBox = isBoxLabel ? (overrideUnits !== undefined ? overrideUnits : effectiveUnitsInBox) : (effectiveUnitsInBox + 1);
        const weightBruttoBox = effectiveBoxNet + (packsInThisBox * tarePackGrams / 1000) + (tareBoxGrams / 1000);
        const weightNettoPallet = effectiveBoxNet * (boxesInPallet + 1);
        const weightBruttoPallet = weightNettoPallet + 20;
        const currentUnits = overrideUnits !== undefined ? overrideUnits : effectiveUnitsInBox;

        const getFormattedCounter = (count: number, doc: any, placeholder: string, configObj?: any): string => {
            const stationPrefix = stationNumber ? String(stationNumber).padStart(2, '0') : '';
            const countStr = String(count);
            let minLength = 0;
            const items = doc ? (doc.elements || doc.objects) : null;
            if (items) {
                const sp = placeholder.replace(/\s+/g, '');
                let foundEl = items.find((e: any) => {
                    const isText = e.type === 'text' || e.type === 'i-text' || e.type === 'textbox';
                    return isText && ((e.value || '').replace(/\s+/g, '').includes(sp) || (e.text || '').replace(/\s+/g, '').includes(sp));
                });
                if (!foundEl) foundEl = items.find((e: any) => e.type === 'barcode' && (e.value || '').replace(/\s+/g, '').includes(sp));
                const fl = foundEl?.minLength || foundEl?.minLeght;
                if (fl) minLength = Number(fl);
            }
            if (minLength > 0) {
                const targetLen = Math.max(0, minLength - stationPrefix.length);
                return stationPrefix + countStr.padStart(targetLen, '0');
            } else if (configObj?.enabled) {
                const prefix = configObj.prefix !== undefined ? configObj.prefix : stationPrefix;
                return `${prefix}${countStr.padStart(configObj.length || 0, '0')}`;
            }
            return stationPrefix + countStr;
        };

        const activeLabelDoc = isBoxLabel ? boxLabelDoc : labelDoc;
        const unitNumStr = getFormattedCounter(effectiveTotalUnits + 1, activeLabelDoc, '{{pack_number}}', numberingConfig?.unit);
        const boxNumStr = getFormattedCounter(effectiveTotalBoxes + 1, activeLabelDoc, '{{box_number}}', numberingConfig?.box);

        const dataObj: any = {
            name: selectedProduct?.name || '', article: selectedProduct?.article || '',
            exp_date: String(expDays), box_id: currentBoxId,
            weight: weightNettoPack.toFixed(3),
            weight_netto_pack: weightNettoPack.toFixed(3), weight_brutto_pack: weightBruttoPack.toFixed(3),
            weight_netto_box: effectiveBoxNet.toFixed(3), weight_brutto_box: weightBruttoBox.toFixed(3),
            weight_netto_pallet: weightNettoPallet.toFixed(3), weight_brutto_pallet: weightBruttoPallet.toFixed(3),
            weight_brutto_all: weightBruttoPallet.toFixed(3),
            date: formatDate(now), production_date: formatFullDate(now),
            date_exp: formatDate(expDate), exp_date_full: formatFullDate(expDate),
            pack_number: unitNumStr, box_number: boxNumStr,
            batch_number: batchNumber || extra.batch_number || '',
            pack_count: String(currentUnits + (isBoxLabel ? 0 : 1)),
            pack_counter: String(currentUnits + (isBoxLabel ? 0 : 1)),
            box_count: String(boxesInPallet + 1),
            close_box_counter: String(currentUnits + (isBoxLabel ? 0 : 1)),
            box_limit: selectedProduct?.close_box_counter?.toString() || '',
            _raw_weight_netto_pack: weightNettoPack, _raw_weight_brutto_pack: weightBruttoPack,
            _raw_weight_netto_box: effectiveBoxNet, _raw_weight_brutto_box: weightBruttoBox,
            ...extra
        };

        dataObj.barcode = (() => {
            if (packBarcodeTemplate) {
                try {
                    const genData: BarcodeData = {
                        ...dataObj,
                        weight_netto_pack: weightNettoPack, weight_brutto_pack: weightBruttoPack,
                        weight_netto_box: effectiveBoxNet, weight_brutto_box: weightBruttoBox,
                        weight_netto_pallet: weightNettoPallet, weight_brutto_pallet: weightBruttoPallet,
                        production_date: now, exp_date: expDate,
                        article: selectedProduct?.article, unit_number: unitNumStr, box_number: boxNumStr,
                        batch_number: batchNumber || extra.batch_number || ''
                    };
                    return generateBarcode(JSON.parse(packBarcodeTemplate.structure).fields, genData);
                } catch (err) { console.error('Barcode generation failed:', err); }
            }
            return selectedProduct?.barcode || selectedProduct?.article || '0000000000000';
        })();

        return dataObj;
    };

    const loadProducts = async (query = '') => {
        try {
            const list = await window.electron.invoke('get-fixed-weight-products', query);
            setProducts(list);
        } catch (err) { console.error(err); }
    };

    // --- EFFECTS ---
    useEffect(() => {
        const removeReadingListener = window.electron.on('scale-reading', (data: any) => {
            if (data && typeof data === 'object' && 'weight' in data) {
                const w = typeof data.weight === 'number' ? data.weight : parseFloat(String(data.weight));
                setWeight(w.toFixed(3)); weightRef.current = w.toFixed(3);
                setIsStable(!!data.stable);
                if (data.stable) setStableTrigger(prev => prev + 1);
                if (w < 0.010) autoPrintFiredRef.current = false;
                return;
            }
            const ws = typeof data === 'string' ? data : JSON.stringify(data);
            const match = ws.match(/(\d+\.\d+)/);
            if (match) { setWeight(match[1]); weightRef.current = match[1]; }
        });
        const removeStatusListener = window.electron.on('scale-status', (s: any) => setStatus(s));
        const removeErrorListener = window.electron.on('scale-error', (msg: string) => {
            setAlertMessage(`${t('ws.errorPrefix')}: ${msg}`);
        });
        window.electron.invoke('get-scale-status').then((s: string) => { if (s) setStatus(s); });
        const removeUpdateListener = window.electron.on('data-updated', () => {
            loadProducts();
            setSyncVersion(prev => prev + 1);
            window.electron.invoke('get-containers').then((cnts: any) => setContainers(cnts)).catch(console.error);
        });
        return () => { removeReadingListener(); removeStatusListener(); removeErrorListener(); removeUpdateListener(); };
    }, []);

    useEffect(() => {
        if (products.length === 0) return;
        if (selectedProduct) {
            const updated = products.find(p => p.id === selectedProduct.id);
            if (updated && JSON.stringify(updated) !== JSON.stringify(selectedProduct)) setSelectedProduct(updated);
        } else {
            const savedId = localStorage.getItem('lastFWProductId');
            const restored = savedId ? products.find(p => String(p.id) === savedId) : null;
            setSelectedProduct(restored || products[0]);
        }
    }, [products]);

    useEffect(() => {
        if (selectedProduct?.id) localStorage.setItem('lastFWProductId', String(selectedProduct.id));
    }, [selectedProduct]);

    useEffect(() => {
        window.electron.invoke('get-printer-config').then((cfg: any) => { if (cfg) setPrinterConfig(cfg); });
        const rm = window.electron.on('printer-config-updated', (c: any) => setPrinterConfig(c));
        return () => rm();
    }, []);

    useEffect(() => {
        window.electron.invoke('get-containers').then(setContainers).catch(console.error);
    }, []);

    useEffect(() => {
        window.electron.invoke('get-numbering-config').then((cfg: any) => setNumberingConfig(cfg)).catch(console.error);
        loadProducts();
    }, []);

    // Fetch labels & barcodes
    useEffect(() => {
        const fetchLabelsAndBarcodes = async () => {
            if (!selectedProduct) { setLabelDoc(null); setBoxLabelDoc(null); setPackBarcodeTemplate(null); setBoxBarcodeTemplate(null); return; }
            let pDoc = null;
            if (selectedProduct.templates_pack_label) {
                try {
                    const doc = await window.electron.invoke('get-label', selectedProduct.templates_pack_label);
                    if (doc?.structure) { pDoc = JSON.parse(doc.structure); setLabelDoc(pDoc); }
                } catch (err) { console.error(err); }
            } else { setLabelDoc(null); }
            let bDoc = null;
            if (selectedProduct.templates_box_label) {
                try {
                    const doc = await window.electron.invoke('get-label', selectedProduct.templates_box_label);
                    if (doc?.structure) { bDoc = JSON.parse(doc.structure); setBoxLabelDoc(bDoc); }
                } catch (err) { console.error(err); }
            } else { setBoxLabelDoc(null); }
            const fetchBarcode = async (doc: any, setFn: (t: any) => void) => {
                if (!doc) return setFn(null);
                const items = doc.elements || doc.objects;
                if (!items) return setFn(null);
                const bc = items.find((o: any) => o.type === 'barcode');
                if (bc?.templateId) {
                    try { setFn(await window.electron.invoke('get-barcode-template', bc.templateId)); }
                    catch { setFn(null); }
                } else { setFn(null); }
            };
            await fetchBarcode(pDoc, setPackBarcodeTemplate);
            await fetchBarcode(bDoc, setBoxBarcodeTemplate);
        };
        fetchLabelsAndBarcodes();
    }, [selectedProduct, syncVersion]);

    // --- SCALE MODE: Auto-Print ---
    useEffect(() => {
        if (subMode !== 'scale' || !isReady || !printerConfig.autoPrintOnStable || !isStable ||
            !selectedProduct || !labelDoc || autoPrintFiredRef.current || isPrintingRef.current || activeTab !== 'fixedWeight') return;
        const cw = parseFloat(weightRef.current);
        if (cw <= 0.010) return;
        const wGrams = cw * 1000;
        const min = selectedProduct.min_weight_grams || 0;
        const max = selectedProduct.max_weight_grams || Infinity;
        if (wGrams < min || wGrams > max) return;
        autoPrintFiredRef.current = true;
        handlePrint().catch(err => { console.error('Auto-print failed:', err); isPrintingRef.current = false; });
    }, [isStable, selectedProduct, labelDoc, printerConfig.autoPrintOnStable, isReady, stableTrigger, subMode]);

    // --- PRINT HANDLER (Scale mode) ---
    const handlePrint = async () => {
        if (isPrintingRef.current) return;
        isPrintingRef.current = true;
        try {
            if (!labelDoc) return;
            if (subMode === 'scale') {
                const wGrams = parseFloat(weightRef.current) * 1000;
                const min = selectedProduct?.min_weight_grams || 0;
                const max = selectedProduct?.max_weight_grams || Infinity;
                if (wGrams < min || wGrams > max) {
                    setAlertMessage(t('fw.printNotAllowed'));
                    return;
                }
            }
            const boxLimit = selectedProduct?.close_box_counter || 999999;
            const predictedData = getLabelData();
            const predictedBoxNum = currentBoxNumber || predictedData.box_number;
            let packBarcode = '';
            if (packBarcodeTemplate) {
                try {
                    const fields = JSON.parse(packBarcodeTemplate.structure).fields;
                    const expDatePack = new Date(labelingDate);
                    expDatePack.setDate(labelingDate.getDate() + (selectedProduct?.exp_date || 0));
                    packBarcode = generateBarcode(fields, {
                        weight_netto_pack: parseFloat(predictedData.weight_netto_pack),
                        weight_brutto_pack: parseFloat(predictedData.weight_brutto_pack),
                        production_date: labelingDate, exp_date: expDatePack,
                        article: (selectedProduct?.article || '').padStart(14, '0'),
                        pack_number: predictedData.pack_number, box_number: predictedBoxNum,
                        batch_number: batchNumber || ''
                    } as any);
                } catch (err) { console.error(err); }
            }
            const expDatePack = new Date(labelingDate);
            expDatePack.setDate(labelingDate.getDate() + (selectedProduct?.exp_date || 0));
            const recordResult = await window.electron.invoke('record-pack', {
                number: predictedData.pack_number, box_number: predictedBoxNum,
                nomenclature_id: selectedProduct.id,
                weight_netto: parseFloat(predictedData.weight_netto_pack),
                weight_brutto: parseFloat(predictedData.weight_brutto_pack),
                barcode_value: packBarcode, station_number: stationNumber,
                production_date: labelingDate.toISOString(),
                expiration_date: expDatePack.toISOString(), batch: batchNumber || ''
            });
            if (!recordResult.success) throw new Error('Database recording failed');
            const actualBoxNumber = recordResult.boxNumber;
            const actualBoxId = recordResult.boxId;
            if (recordResult.newBoxCreated) setTotalBoxes(prev => prev + 1);
            setCurrentBoxId(actualBoxId);
            setCurrentBoxNumber(actualBoxNumber);

            const finalPrintData = getLabelData();
            finalPrintData.box_number = actualBoxNumber;
            window.electron.invoke('print-label', {
                silent: true, labelDoc, data: finalPrintData,
                printerConfig: printerConfig.packPrinter || undefined
            }).catch(console.error);
            setLastPrinted({ doc: labelDoc, data: finalPrintData });

            const currentNetWeight = parseFloat(finalPrintData.weight_netto_pack);
            const newUnitsInBox = unitsInBox + 1;
            const newBoxNetWeight = boxNetWeight + currentNetWeight;

            if (newUnitsInBox >= boxLimit) {
                await printBoxLabel(newBoxNetWeight, newUnitsInBox, actualBoxNumber, actualBoxId);
                setUnitsInBox(0); setBoxNetWeight(0); setBoxesInPallet(prev => prev + 1);
                setTotalUnits(prev => prev + 1);
                setCurrentBoxId(null); setCurrentBoxNumber(null);
            } else {
                setUnitsInBox(newUnitsInBox); setBoxNetWeight(newBoxNetWeight);
                setTotalUnits(prev => prev + 1);
            }
        } catch (err) {
            console.error('Print Error:', err);
            setAlertMessage(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
        } finally { isPrintingRef.current = false; }
    };

    // --- BOX LABEL PRINT HELPER ---
    const printBoxLabel = async (finalBoxWeight: number, finalUnitsInBox: number, boxNumber: string, boxId: number) => {
        if (!boxLabelDoc) return;
        const boxLimit = selectedProduct?.close_box_counter || 0;
        const baseData = getLabelData(finalBoxWeight, true, finalUnitsInBox);
        baseData.box_number = boxNumber;
        let boxBarcode = '';
        if (boxBarcodeTemplate) {
            try {
                const fields = JSON.parse(boxBarcodeTemplate.structure).fields;
                const boxCont = containers.find(c => c.id === selectedProduct?.box_container_id);
                const brutBox = finalBoxWeight + (boxCont?.weight || 0) / 1000;
                const expDateBox = new Date(labelingDate);
                expDateBox.setDate(labelingDate.getDate() + (selectedProduct?.exp_date || 0));
                boxBarcode = generateBarcode(fields, {
                    weight_netto_box: finalBoxWeight, weight_brutto_box: brutBox,
                    production_date: labelingDate, exp_date: expDateBox,
                    article: (selectedProduct?.article || '').padStart(14, '0'),
                    box_number: boxNumber, batch_number: batchNumber || ''
                } as BarcodeData);
            } catch (err) { console.error(err); }
        }
        const resolvedBarcode = boxBarcode || baseData.barcode;
        const isDefaultZeros = !resolvedBarcode || /^0+$/.test(resolvedBarcode);
        const finalBarcode = isDefaultZeros ? ((baseData as any)['Код ШК'] || selectedProduct?.barcode || selectedProduct?.article || '0000000000000') : resolvedBarcode;
        const boxData = { ...baseData, is_box: true, count: boxLimit, pack_counter: String(finalUnitsInBox), weight_netto: finalBoxWeight.toFixed(3), barcode: finalBarcode };
        await window.electron.invoke('print-label', { silent: true, labelDoc: boxLabelDoc, data: boxData, printerConfig: printerConfig.boxPrinter || undefined });
        const boxCont = containers.find(c => c.id === selectedProduct?.box_container_id);
        const brutBox = finalBoxWeight + (boxCont?.weight || 0) / 1000;
        await window.electron.invoke('close-box', { boxId, weightNetto: finalBoxWeight, weightBrutto: brutBox });
        setLastPrinted({ doc: boxLabelDoc, data: boxData });
    };

    // --- CLOSE BOX ---
    const handleCloseBox = async () => {
        if (unitsInBox === 0) { setAlertMessage('Нельзя закрыть пустой короб!'); return; }
        const finalBoxWeight = boxNetWeight;
        const finalUnitsInBox = unitsInBox;
        setUnitsInBox(0); setBoxNetWeight(0); setBoxesInPallet(prev => prev + 1); setTotalBoxes(prev => prev + 1);
        if (currentBoxId && currentBoxNumber) {
            await printBoxLabel(finalBoxWeight, finalUnitsInBox, currentBoxNumber, currentBoxId);
        }
        setCurrentBoxId(null); setCurrentBoxNumber(null);
    };

    // --- REPEAT ---
    const handleRepeat = async () => {
        if (!lastPrinted) { setAlertMessage('Нет данных для повторной печати.'); return; }
        await window.electron.invoke('print-label', { silent: true, labelDoc: lastPrinted.doc, data: lastPrinted.data, printerConfig: printerConfig.packPrinter });
    };

    // --- COUNT MODE: Batch print ---
    const handleCountStart = async () => {
        if (!selectedProduct) { setAlertMessage(t('fw.selectProductFirst')); return; }
        if (!labelDoc) { setAlertMessage(t('ws.noLabel')); return; }
        if (packsPerBoxInput <= 0) { setAlertMessage(t('fw.enterPacksPerBox')); return; }
        if (totalBoxesInput <= 0) { setAlertMessage(t('fw.enterTotalBoxes')); return; }

        setIsCountPrinting(true);
        cancelCountRef.current = false;
        setCountCurrentBox(0);
        setCountCurrentPack(0);

        const fixedWeightKg = (selectedProduct.fixed_weight_grams || 0) / 1000;

        // Local counters — React state is batched and won't update mid-loop
        let localTotalUnits = totalUnits;
        let localTotalBoxes = totalBoxes;
        let localUnitsInBox = unitsInBox;
        let localBoxNetWeight = boxNetWeight;
        let localBoxesInPallet = boxesInPallet;
        let localCurrentBoxNumber = currentBoxNumber;
        let localCurrentBoxId = currentBoxId;

        for (let box = 0; box < totalBoxesInput; box++) {
            if (cancelCountRef.current) break;
            setCountCurrentBox(box + 1);
            let boxPacksCompleted = 0;

            for (let pack = 0; pack < packsPerBoxInput; pack++) {
                if (cancelCountRef.current) break;
                setCountCurrentPack(pack + 1);

                const overrides = { totalUnits: localTotalUnits, totalBoxes: localTotalBoxes, unitsInBox: localUnitsInBox, boxNetWeight: localBoxNetWeight };
                const predictedData = getLabelData(fixedWeightKg, false, undefined, overrides);
                const predictedBoxNum = localCurrentBoxNumber || predictedData.box_number;

                let packBarcode = '';
                if (packBarcodeTemplate) {
                    try {
                        const fields = JSON.parse(packBarcodeTemplate.structure).fields;
                        const expDatePack = new Date(labelingDate);
                        expDatePack.setDate(labelingDate.getDate() + (selectedProduct?.exp_date || 0));
                        packBarcode = generateBarcode(fields, {
                            weight_netto_pack: parseFloat(predictedData.weight_netto_pack),
                            weight_brutto_pack: parseFloat(predictedData.weight_brutto_pack),
                            production_date: labelingDate, exp_date: expDatePack,
                            article: (selectedProduct?.article || '').padStart(14, '0'),
                            pack_number: predictedData.pack_number, box_number: predictedBoxNum,
                            batch_number: batchNumber || ''
                        } as any);
                    } catch (err) { console.error(err); }
                }

                const expDatePack = new Date(labelingDate);
                expDatePack.setDate(labelingDate.getDate() + (selectedProduct?.exp_date || 0));

                try {
                    const recordResult = await window.electron.invoke('record-pack', {
                        number: predictedData.pack_number, box_number: predictedBoxNum,
                        nomenclature_id: selectedProduct.id,
                        weight_netto: parseFloat(predictedData.weight_netto_pack),
                        weight_brutto: parseFloat(predictedData.weight_brutto_pack),
                        barcode_value: packBarcode, station_number: stationNumber,
                        production_date: labelingDate.toISOString(),
                        expiration_date: expDatePack.toISOString(), batch: batchNumber || ''
                    });

                    if (!recordResult.success) throw new Error('DB record failed');
                    if (recordResult.newBoxCreated) localTotalBoxes++;
                    localCurrentBoxId = recordResult.boxId;
                    localCurrentBoxNumber = recordResult.boxNumber;

                    const finalData = getLabelData(fixedWeightKg, false, undefined, overrides);
                    finalData.box_number = recordResult.boxNumber;
                    await window.electron.invoke('print-label', {
                        silent: true, labelDoc, data: finalData,
                        printerConfig: printerConfig.packPrinter || undefined
                    });

                    const netW = parseFloat(finalData.weight_netto_pack);
                    localTotalUnits++;
                    localUnitsInBox++;
                    localBoxNetWeight += netW;
                    boxPacksCompleted++;

                    // Sync React state for UI updates
                    setTotalUnits(localTotalUnits);
                    setUnitsInBox(localUnitsInBox);
                    setBoxNetWeight(localBoxNetWeight);
                    setCurrentBoxId(localCurrentBoxId);
                    setCurrentBoxNumber(localCurrentBoxNumber);

                    // Auto print box label when pack count reached
                    if (boxPacksCompleted >= packsPerBoxInput) {
                        await printBoxLabel(localBoxNetWeight, packsPerBoxInput, recordResult.boxNumber, recordResult.boxId);
                        localUnitsInBox = 0;
                        localBoxNetWeight = 0;
                        localBoxesInPallet++;
                        localCurrentBoxId = null;
                        localCurrentBoxNumber = null;
                        setUnitsInBox(0); setBoxNetWeight(0);
                        setBoxesInPallet(localBoxesInPallet);
                        setCurrentBoxId(null); setCurrentBoxNumber(null);
                    }
                } catch (err) {
                    console.error('Count print error:', err);
                    setAlertMessage(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
                    cancelCountRef.current = true; break;
                }
                // Small delay between prints
                await new Promise(r => setTimeout(r, 200));
            }
        }
        // Final sync of all local counters to React state
        setTotalUnits(localTotalUnits);
        setTotalBoxes(localTotalBoxes);
        setUnitsInBox(localUnitsInBox);
        setBoxNetWeight(localBoxNetWeight);
        setBoxesInPallet(localBoxesInPallet);
        setCurrentBoxId(localCurrentBoxId);
        setCurrentBoxNumber(localCurrentBoxNumber);
        setIsCountPrinting(false);
        if (!cancelCountRef.current) setAlertMessage(t('fw.completed'));
    };

    const handleSelectProduct = (product: any) => {
        if (unitsInBox > 0) { setAlertMessage(t('ws.closeBoxBeforeChange')); return; }
        setSelectedProduct(product);
        setCurrentBoxId(null); setCurrentBoxNumber(null);
        setIsProductModalOpen(false);
    };

    // --- RENDER ---
    const inRange = isWeightInRange();
    const wGrams = getWeightGrams();

    return (
        <div className="grid grid-cols-12 gap-6 h-full p-4 relative">
            {/* Main Card */}
            <div className="col-span-8 bg-white dark:bg-neutral-900/50 border border-neutral-200 dark:border-white/5 rounded-3xl p-8 backdrop-blur shadow-sm dark:shadow-2xl flex flex-col">
                {/* Header */}
                <div className="flex justify-between items-start mb-6">
                    <h2 className="text-2xl font-semibold text-neutral-900 dark:text-white">{t('fw.title')}</h2>
                    {subMode === 'scale' && (
                        <div className={`px-4 py-2 rounded-full text-sm font-medium flex items-center gap-2 border ${status === 'connected'
                            ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                            : 'bg-red-500/10 border-red-500/20 text-red-400'}`}>
                            <span className={`w-2 h-2 rounded-full ${status === 'connected' ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`}></span>
                            {status === 'connected' ? t('ws.scaleStatus.connected') : t('ws.scaleStatus.disconnected')}
                        </div>
                    )}
                </div>

                {/* Sub-mode tabs */}
                <div className="flex gap-2 mb-6">
                    <button onClick={() => setSubMode('scale')}
                        className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-2xl text-sm font-semibold transition-all border ${subMode === 'scale'
                            ? 'bg-emerald-100/50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 shadow-sm'
                            : 'bg-neutral-100 dark:bg-white/5 text-neutral-500 dark:text-neutral-400 border-neutral-200 dark:border-white/10 hover:bg-neutral-200 dark:hover:bg-white/10'}`}>
                        <Scale className="w-4 h-4" /> {t('fw.modeScale')}
                    </button>
                    <button onClick={() => setSubMode('count')}
                        className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-2xl text-sm font-semibold transition-all border ${subMode === 'count'
                            ? 'bg-blue-100/50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20 shadow-sm'
                            : 'bg-neutral-100 dark:bg-white/5 text-neutral-500 dark:text-neutral-400 border-neutral-200 dark:border-white/10 hover:bg-neutral-200 dark:hover:bg-white/10'}`}>
                        <Package className="w-4 h-4" /> {t('fw.modeCount')}
                    </button>
                </div>

                {/* Product selector */}
                <div onClick={() => setIsProductModalOpen(true)} className="cursor-pointer group mb-6">
                    <label className="block text-sm font-medium text-neutral-400 mb-2">{t('ws.search')}</label>
                    <div className="w-full bg-neutral-50 dark:bg-black/20 border border-neutral-300 dark:border-white/10 rounded-2xl px-5 py-4 text-lg text-neutral-500 dark:text-neutral-400 flex items-center justify-between group-hover:bg-neutral-100 dark:group-hover:bg-black/40 transition-all">
                        <span className={selectedProduct ? "text-neutral-900 dark:text-white" : ""}>{selectedProduct ? selectedProduct.name : "..."}</span>
                        <Search className="w-6 h-6 text-neutral-400" />
                    </div>
                </div>

                {/* Product info */}
                {selectedProduct && (
                    <div className="p-5 bg-emerald-50 dark:bg-emerald-500/5 border border-emerald-200 dark:border-emerald-500/10 rounded-2xl mb-6">
                        <h3 className="text-sm uppercase tracking-wider text-emerald-600 dark:text-emerald-500/60 font-bold mb-1">{t('products.name')}</h3>
                        <div className="text-2xl font-bold text-emerald-700 dark:text-emerald-100 mb-2">{selectedProduct.name}</div>
                        <div className="flex flex-wrap gap-4 text-sm">
                            <span className="text-emerald-500/70">{t('products.article')}: {selectedProduct.article || '—'}</span>
                            <span className="font-mono bg-emerald-100 dark:bg-emerald-500/10 px-2 py-0.5 rounded text-emerald-700 dark:text-emerald-300">
                                {t('fw.fixedWeight')}: {selectedProduct.fixed_weight_grams || 0}
                            </span>
                            <span className="font-mono bg-amber-100 dark:bg-amber-500/10 px-2 py-0.5 rounded text-amber-700 dark:text-amber-300">
                                {t('fw.minWeight')}: {selectedProduct.min_weight_grams || 0} — {t('fw.maxWeight')}: {selectedProduct.max_weight_grams || 0}
                            </span>
                        </div>
                    </div>
                )}

                {/* --- SCALE MODE DISPLAY --- */}
                {subMode === 'scale' && (
                    <div className="flex-1 flex flex-col">
                        <div className="grid grid-cols-2 gap-4 flex-1">
                            <div className="bg-neutral-50 dark:bg-black/30 border border-neutral-200 dark:border-white/10 rounded-3xl p-8 text-center relative overflow-hidden">
                                <label className="text-xs uppercase tracking-widest text-neutral-500 font-bold">{t('ws.gross')}</label>
                                <div className="text-6xl font-mono text-emerald-600 dark:text-emerald-400 mt-2 font-light tracking-tighter">
                                    {weight} <span className="text-2xl text-emerald-500/50">{t('ws.kg')}</span>
                                </div>
                                {isStable && (
                                    <div className="mt-2 text-emerald-600 dark:text-emerald-500/60 text-xs font-bold uppercase tracking-widest animate-pulse flex items-center justify-center gap-2">
                                        <div className="w-1 h-1 rounded-full bg-emerald-500"></div> {t('ws.stable')}
                                    </div>
                                )}
                            </div>
                            <div className="bg-neutral-50 dark:bg-black/30 border border-neutral-200 dark:border-white/10 rounded-3xl p-8 text-center">
                                <label className="text-xs uppercase tracking-widest text-neutral-500 font-bold">{t('ws.net')}</label>
                                <div className="text-6xl font-mono text-neutral-700 dark:text-neutral-300 mt-2 font-light tracking-tighter">
                                    {getNetWeight()} <span className="text-2xl text-neutral-500 dark:text-neutral-600">{t('ws.kg')}</span>
                                </div>
                            </div>
                        </div>

                        {/* Weight range indicator */}
                        {selectedProduct && parseFloat(weight) > 0.010 && (
                            <div className={`mt-4 p-4 rounded-2xl border flex items-center gap-3 text-lg font-semibold transition-all ${inRange
                                ? 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-300 dark:border-emerald-500/20 text-emerald-700 dark:text-emerald-300'
                                : 'bg-red-50 dark:bg-red-500/10 border-red-300 dark:border-red-500/20 text-red-700 dark:text-red-300 animate-pulse'}`}>
                                {inRange ? <CheckCircle2 className="w-6 h-6" /> : <AlertCircle className="w-6 h-6" />}
                                <span>{inRange ? t('fw.weightInRange') : t('fw.weightOutOfRange')}</span>
                                <span className="ml-auto font-mono text-base opacity-70">
                                    {wGrams.toFixed(0)}г ({selectedProduct.min_weight_grams}–{selectedProduct.max_weight_grams}г)
                                </span>
                            </div>
                        )}
                    </div>
                )}

                {/* --- COUNT MODE DISPLAY --- */}
                {subMode === 'count' && (
                    <div className="flex-1 flex flex-col gap-4">
                        <div className="grid grid-cols-2 gap-4">
                            <div onClick={() => !isCountPrinting && setShowPacksKeypad(true)}
                                className="cursor-pointer p-6 bg-blue-50 dark:bg-blue-500/5 border border-blue-200 dark:border-blue-500/10 rounded-2xl text-center hover:bg-blue-100 dark:hover:bg-blue-500/10 transition-all">
                                <label className="text-xs uppercase tracking-widest text-blue-500 font-bold">{t('fw.packsPerBox')}</label>
                                <div className="text-5xl font-mono text-blue-700 dark:text-blue-300 mt-2 font-bold">{packsPerBoxInput || '—'}</div>
                            </div>
                            <div onClick={() => !isCountPrinting && setShowBoxesKeypad(true)}
                                className="cursor-pointer p-6 bg-amber-50 dark:bg-amber-500/5 border border-amber-200 dark:border-amber-500/10 rounded-2xl text-center hover:bg-amber-100 dark:hover:bg-amber-500/10 transition-all">
                                <label className="text-xs uppercase tracking-widest text-amber-500 font-bold">{t('fw.totalBoxes')}</label>
                                <div className="text-5xl font-mono text-amber-700 dark:text-amber-300 mt-2 font-bold">{totalBoxesInput || '—'}</div>
                            </div>
                        </div>

                        {/* Progress */}
                        {isCountPrinting && (
                            <div className="p-6 bg-neutral-50 dark:bg-black/30 border border-neutral-200 dark:border-white/10 rounded-2xl">
                                <div className="flex justify-between mb-3">
                                    <span className="text-sm font-bold text-neutral-500 uppercase tracking-widest">{t('fw.progress')}</span>
                                    <span className="text-sm font-mono text-neutral-700 dark:text-neutral-300">
                                        {t('fw.currentBox')} {countCurrentBox}/{totalBoxesInput} • {t('fw.currentPack')} {countCurrentPack}/{packsPerBoxInput}
                                    </span>
                                </div>
                                <div className="w-full bg-neutral-200 dark:bg-white/10 rounded-full h-4 overflow-hidden">
                                    <div className="h-full bg-gradient-to-r from-blue-500 to-emerald-500 rounded-full transition-all duration-300"
                                        style={{ width: `${((countCurrentBox - 1) * packsPerBoxInput + countCurrentPack) / (totalBoxesInput * packsPerBoxInput) * 100}%` }}></div>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Control Panel */}
            <div className="col-span-4 space-y-4 flex flex-col">
                {subMode === 'scale' ? (
                    <>
                        <button onClick={handlePrint}
                            disabled={subMode === 'scale' && selectedProduct && parseFloat(weight) > 0.010 && !inRange}
                            className={`w-full py-8 transition-all rounded-3xl font-bold text-2xl flex items-center justify-center gap-3 border-t border-white/10 ${selectedProduct && parseFloat(weight) > 0.010 && !inRange
                                ? 'bg-neutral-400 dark:bg-neutral-700 cursor-not-allowed opacity-60'
                                : 'bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 shadow-[0_10px_40px_-10px_rgba(16,185,129,0.5)]'}`}>
                            <Printer className="w-8 h-8" /> {t('ws.print')}
                        </button>
                        <div className="grid grid-cols-2 gap-4">
                            <button onClick={handleRepeat} className="py-6 bg-neutral-100 dark:bg-neutral-800/50 hover:bg-neutral-200 dark:hover:bg-neutral-800 border border-neutral-300 dark:border-white/5 rounded-2xl font-semibold transition-all flex flex-col items-center gap-2 group">
                                <RefreshCw className="w-6 h-6 text-neutral-500 dark:text-neutral-400 group-hover:text-neutral-800 dark:group-hover:text-white transition-colors" />
                                <span className="text-neutral-500 dark:text-neutral-400 group-hover:text-neutral-800 dark:group-hover:text-white uppercase text-xs tracking-widest">{t('ws.reprintSmall')}</span>
                            </button>
                            <button onClick={handleCloseBox} className="py-6 bg-neutral-100 dark:bg-neutral-800/50 hover:bg-neutral-200 dark:hover:bg-neutral-800 border border-neutral-300 dark:border-white/5 rounded-2xl font-semibold transition-all flex flex-col items-center gap-2 group">
                                <Box className="w-6 h-6 text-neutral-500 dark:text-neutral-400 group-hover:text-neutral-800 dark:group-hover:text-white transition-colors" />
                                <span className="text-neutral-500 dark:text-neutral-400 group-hover:text-neutral-800 dark:group-hover:text-white uppercase text-xs tracking-widest">{t('ws.closeBox')}</span>
                            </button>
                            <button onClick={() => setIsDeleteModalOpen(true)} className="py-6 bg-neutral-100 dark:bg-neutral-800/50 hover:bg-red-100 dark:hover:bg-red-900/30 border border-neutral-300 dark:border-white/5 hover:border-red-400 dark:hover:border-red-500/30 rounded-2xl font-semibold transition-all flex flex-col items-center gap-2 group col-span-2">
                                <Layers className="w-6 h-6 text-neutral-500 dark:text-neutral-400 group-hover:text-red-600 dark:group-hover:text-red-400 transition-colors" />
                                <span className="text-neutral-500 dark:text-neutral-400 group-hover:text-red-600 dark:group-hover:text-red-400 uppercase text-xs tracking-widest">{t('ws.delete')}</span>
                            </button>
                        </div>
                    </>
                ) : (
                    <>
                        {!isCountPrinting ? (
                            <button onClick={handleCountStart}
                                className="w-full py-8 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 transition-all rounded-3xl font-bold text-2xl shadow-[0_10px_40px_-10px_rgba(59,130,246,0.5)] flex items-center justify-center gap-3 border-t border-white/10 text-white">
                                <Play className="w-8 h-8" /> {t('fw.start')}
                            </button>
                        ) : (
                            <button onClick={() => { cancelCountRef.current = true; }}
                                className="w-full py-8 bg-red-600 hover:bg-red-500 active:bg-red-700 transition-all rounded-3xl font-bold text-2xl shadow-[0_10px_40px_-10px_rgba(239,68,68,0.5)] flex items-center justify-center gap-3 border-t border-white/10 text-white animate-pulse">
                                <Square className="w-8 h-8" /> {t('fw.stop')}
                            </button>
                        )}
                    </>
                )}

                {/* Session Stats */}
                <div className="mt-auto p-6 bg-white dark:bg-neutral-900/50 border border-neutral-200 dark:border-white/5 shadow-sm dark:shadow-none rounded-3xl backdrop-blur">
                    <h3 className="text-sm font-semibold mb-4 text-neutral-500 dark:text-white/60 uppercase tracking-widest">{t('ws.sessionStats')}</h3>
                    <div className="space-y-3">
                        <div className="flex justify-between items-center p-3 bg-neutral-100 dark:bg-white/5 border border-neutral-300 dark:border-white/10 rounded-xl group cursor-pointer hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-all"
                            onClick={() => { if (unitsInBox > 0) { setAlertMessage(t('ws.closeBoxBeforeChange')); return; } setIsKeypadOpen(true); }}>
                            <span className="text-xs uppercase tracking-wider text-neutral-500 font-bold">Партия</span>
                            <div className="flex items-center gap-3">
                                <span className="text-xl font-mono font-bold text-neutral-900 dark:text-white group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">
                                    {batchNumber || <span className="text-neutral-400 dark:text-neutral-700 italic text-sm">Ввести...</span>}
                                </span>
                                <div className="p-2 bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-white/10 rounded-lg"><Hash className="w-4 h-4 text-emerald-600 dark:text-emerald-500" /></div>
                            </div>
                        </div>
                        <div className="flex justify-between items-center p-3 bg-neutral-100 dark:bg-white/5 border border-neutral-300 dark:border-white/10 rounded-xl group cursor-pointer hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-all"
                            onClick={() => { if (unitsInBox > 0) { setAlertMessage(t('ws.closeBoxBeforeChange')); return; } setIsDatePickerOpen(true); }}>
                            <span className="text-xs uppercase tracking-wider text-neutral-500 font-bold">Дата марк.</span>
                            <div className="flex items-center gap-3">
                                <span className="text-xl font-mono font-bold text-neutral-900 dark:text-white">{labelingDate.toLocaleDateString('ru-RU')}</span>
                                <div className="p-2 bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-white/10 rounded-lg"><Calendar className="w-4 h-4 text-emerald-600 dark:text-emerald-500" /></div>
                            </div>
                        </div>
                        <div className="flex justify-between text-sm py-2 border-b border-neutral-200 dark:border-white/5">
                            <span className="text-neutral-500">{t('ws.inBox')}</span>
                            <div className="flex items-center gap-2">
                                <span className="font-mono text-neutral-900 dark:text-white">{unitsInBox}</span>
                                <span className="text-neutral-500 dark:text-neutral-600">/ {selectedProduct?.close_box_counter || '-'}</span>
                            </div>
                        </div>
                        <div className="flex justify-between text-sm py-2 border-b border-neutral-200 dark:border-white/5">
                            <span className="text-neutral-500">{t('ws.boxesOnPallet')}</span>
                            <span className="font-mono text-amber-600 dark:text-amber-400">{boxesInPallet}</span>
                        </div>
                        <div className="flex justify-between text-sm py-2">
                            <span className="text-neutral-500">{t('ws.totalUnits')}</span>
                            <span className="font-mono text-neutral-900 dark:text-white">{totalUnits}</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* MODALS */}
            {alertMessage && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[300] flex items-center justify-center p-4 animate-in fade-in duration-200">
                    <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-white/10 rounded-[2rem] p-10 max-w-2xl w-full text-center shadow-2xl relative">
                        <button onClick={() => setAlertMessage(null)} className="absolute top-6 right-6 p-2 bg-neutral-100 dark:bg-white/5 hover:bg-neutral-200 dark:hover:bg-white/10 rounded-full transition-colors">
                            <X className="w-8 h-8 text-neutral-500 dark:text-neutral-400" />
                        </button>
                        <div className="mx-auto w-24 h-24 bg-red-100 dark:bg-red-500/10 rounded-full flex items-center justify-center mb-8">
                            <AlertCircle className="w-12 h-12 text-red-500" />
                        </div>
                        <h3 className="text-3xl font-bold text-neutral-900 dark:text-white mb-4">{t('ws.attention')}</h3>
                        <p className="text-xl text-neutral-600 dark:text-neutral-400 mb-10 whitespace-pre-line">{alertMessage}</p>
                        <button onClick={() => setAlertMessage(null)} className="w-full py-6 !bg-neutral-800 hover:!bg-neutral-700 dark:!bg-neutral-300 dark:hover:!bg-neutral-200 !text-white dark:!text-black rounded-2xl font-bold text-xl shadow-lg">{t('ws.ok')}</button>
                    </div>
                </div>
            )}

            {isKeypadOpen && <NumericKeypad value={batchNumber} onUpdate={setBatchNumber} onClose={() => setIsKeypadOpen(false)} title="Номер партии" />}
            {isDatePickerOpen && <DatePickerModal value={labelingDate} onUpdate={setLabelingDate} onClose={() => setIsDatePickerOpen(false)} title="Дата маркировки" />}
            {showPacksKeypad && <NumericKeypad value={String(packsPerBoxInput)} onUpdate={(v) => setPacksPerBoxInput(parseInt(v) || 0)} onClose={() => setShowPacksKeypad(false)} title={t('fw.packsPerBox')} />}
            {showBoxesKeypad && <NumericKeypad value={String(totalBoxesInput)} onUpdate={(v) => setTotalBoxesInput(parseInt(v) || 0)} onClose={() => setShowBoxesKeypad(false)} title={t('fw.totalBoxes')} />}
            <DeleteItemsModal isOpen={isDeleteModalOpen} onClose={() => setIsDeleteModalOpen(false)}
                onDeleted={async () => {
                    const latest = await window.electron.invoke('get-latest-counters', selectedProduct?.id);
                    if (latest) {
                        setTotalUnits(latest.totalUnits); setTotalBoxes(latest.totalBoxes);
                        setUnitsInBox(latest.unitsInBox); setBoxesInPallet(latest.boxesInPallet);
                        setCurrentBoxId(latest.currentBoxId); setCurrentBoxNumber(latest.currentBoxNumber);
                        setBoxNetWeight(latest.boxNetWeight || 0);
                    }
                }} />
            {isProductModalOpen && <ProductSelectionModal products={products} onSelect={handleSelectProduct} onClose={() => setIsProductModalOpen(false)} />}
        </div>
    );
};

export default FixedWeightStation;
