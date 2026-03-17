import { useEffect, useState, useRef, useCallback } from 'react';
import { ClipboardList, Play, Square, Printer, RefreshCw, Upload, CheckCircle2, Clock, Loader2, Trash2, Box, Hash, Calendar, AlertCircle } from 'lucide-react';
import { generateBarcode, type BarcodeData } from '../utils/barcodeGenerator';
import { useTranslation } from '../i18n';
import DatePickerModal from './DatePickerModal';
import DeleteItemsModal from './DeleteItemsModal';

interface PrintJobData {
    id: number;
    job_id: number;
    nomenclature_id: number;
    nomenclature_name: string;
    nomenclature_article: string;
    quantity: number;
    quantity_unit: 'pcs' | 'kg';
    batch_number: string;
    printed_qty: number;
    status: 'pending' | 'in_progress' | 'completed';
    created_at: string;
    completed_at: string | null;
}

const PrintJobStation = (_props: { activeTab?: string }) => {
    const { t } = useTranslation();

    // --- STATE ---
    const [jobs, setJobs] = useState<PrintJobData[]>([]);
    const [activeJob, setActiveJob] = useState<PrintJobData | null>(null);
    const [product, setProduct] = useState<any | null>(null);
    const [labelDoc, setLabelDoc] = useState<any>(null);
    const [boxLabelDoc, setBoxLabelDoc] = useState<any>(null);
    const [packBarcodeTemplate, setPackBarcodeTemplate] = useState<any>(null);
    const [boxBarcodeTemplate, setBoxBarcodeTemplate] = useState<any>(null);
    const [containers, setContainers] = useState<any[]>([]);
    const [printerConfig, setPrinterConfig] = useState<any>({ packPrinter: '', boxPrinter: '' });
    const [numberingConfig, setNumberingConfig] = useState<any>(null);
    const [stationNumber, setStationNumber] = useState<string | null>(null);
    const [alertMessage, setAlertMessage] = useState<string | null>(null);
    const [isPrinting, setIsPrinting] = useState(false);
    const [labelingDate, setLabelingDate] = useState<Date>(new Date());
    const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);
    const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
    const [syncVersion, setSyncVersion] = useState(0);

    // Scale state (for kg mode — weighing each pack)
    const [weight, setWeight] = useState<string>('0.000');
    const [isStable, setIsStable] = useState(false);
    const [scaleStatus, setScaleStatus] = useState<string>('disconnected');

    // Counters
    const [totalUnits, setTotalUnits] = useState(0);
    const [totalBoxes, setTotalBoxes] = useState(0);
    const [unitsInBox, setUnitsInBox] = useState(0);
    const [boxNetWeight, setBoxNetWeight] = useState(0);
    const [boxesInPallet, setBoxesInPallet] = useState(0);
    const [currentBoxId, setCurrentBoxId] = useState<number | null>(null);
    const [currentBoxNumber, setCurrentBoxNumber] = useState<string | null>(null);
    const [lastPrinted, setLastPrinted] = useState<{ doc: any; data: any } | null>(null);

    // Refs
    const isPrintingRef = useRef(false);
    const cancelRef = useRef(false);
    const weightRef = useRef('0.000');
    const autoPrintFiredRef = useRef(false);

    // --- LOAD JOBS ---
    const loadJobs = useCallback(async () => {
        try {
            const list = await window.electron.invoke('get-print-jobs');
            setJobs(list);
        } catch (e) {
            console.error('Failed to load print jobs:', e);
        }
    }, []);

    // --- INIT ---
    useEffect(() => {
        const loadInit = async () => {
            try {
                const info = await window.electron.invoke('get-station-info');
                if (info?.station_number) setStationNumber(info.station_number);
            } catch (e) { console.error('Failed to load station info', e); }

            try {
                const cfg = await window.electron.invoke('get-printer-config');
                if (cfg) setPrinterConfig(cfg);
            } catch (e) { console.error(e); }

            try {
                const cfg = await window.electron.invoke('get-numbering-config');
                if (cfg) setNumberingConfig(cfg);
            } catch (e) { console.error(e); }

            try {
                const cnts = await window.electron.invoke('get-containers');
                if (cnts) setContainers(cnts);
            } catch (e) { console.error(e); }
        };

        loadInit();
        loadJobs();

        // Listeners
        const removeJobsListener = window.electron.on('print-jobs-updated', () => {
            loadJobs();
        });
        const removeDataListener = window.electron.on('data-updated', () => {
            loadJobs();
            window.electron.invoke('get-containers').then((c: any) => setContainers(c)).catch(console.error);
            setSyncVersion(v => v + 1);
        });
        const removePrinterListener = window.electron.on('printer-config-updated', (c: any) => setPrinterConfig(c));

        // Scale listeners
        const removeScaleReading = window.electron.on('scale-reading', (data: any) => {
            if (data && typeof data === 'object' && 'weight' in data) {
                const w = typeof data.weight === 'number' ? data.weight : parseFloat(String(data.weight));
                setWeight(w.toFixed(3));
                weightRef.current = w.toFixed(3);
                setIsStable(!!data.stable);
                if (w < 0.010) autoPrintFiredRef.current = false;
            }
        });
        const removeScaleStatus = window.electron.on('scale-status', (s: any) => setScaleStatus(s));
        window.electron.invoke('get-scale-status').then((s: string) => { if (s) setScaleStatus(s); });

        return () => {
            removeJobsListener();
            removeDataListener();
            removePrinterListener();
            removeScaleReading();
            removeScaleStatus();
        };
    }, []);

    // --- SELECT JOB ---
    const selectJob = useCallback(async (job: PrintJobData) => {
        if (job.status === 'completed') return;
        setActiveJob(job);
        cancelRef.current = false;

        // Load product data from nomenclature
        try {
            const products = await window.electron.invoke('get-products', job.nomenclature_article || job.nomenclature_name);
            const found = products.find((p: any) => p.id === job.nomenclature_id) || products[0];
            setProduct(found || null);
        } catch (e) {
            console.error('Failed to load product:', e);
            setProduct(null);
        }
    }, []);

    // --- LOAD LABELS & BARCODES ---
    useEffect(() => {
        const fetchLabels = async () => {
            if (!product) {
                setLabelDoc(null);
                setBoxLabelDoc(null);
                setPackBarcodeTemplate(null);
                setBoxBarcodeTemplate(null);
                return;
            }

            let pDoc = null;
            if (product.templates_pack_label) {
                try {
                    const doc = await window.electron.invoke('get-label', product.templates_pack_label);
                    if (doc?.structure) { pDoc = JSON.parse(doc.structure); setLabelDoc(pDoc); }
                } catch (e) { console.error(e); }
            } else { setLabelDoc(null); }

            let bDoc = null;
            if (product.templates_box_label) {
                try {
                    const doc = await window.electron.invoke('get-label', product.templates_box_label);
                    if (doc?.structure) { bDoc = JSON.parse(doc.structure); setBoxLabelDoc(bDoc); }
                } catch (e) { console.error(e); }
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
        fetchLabels();
    }, [product, syncVersion]);

    // --- SYNC COUNTERS ---
    useEffect(() => {
        const syncCounters = async () => {
            try {
                const latest = await window.electron.invoke('get-latest-counters', product?.id);
                if (latest) {
                    setTotalUnits(latest.totalUnits ?? 0);
                    setTotalBoxes(latest.totalBoxes ?? 0);
                    setBoxesInPallet(latest.boxesInPallet ?? 0);
                    setUnitsInBox(latest.unitsInBox ?? 0);
                    setBoxNetWeight(latest.boxNetWeight ?? 0);
                    setCurrentBoxId(latest.currentBoxId ?? null);
                    setCurrentBoxNumber(latest.currentBoxNumber ?? null);
                }
            } catch (e) { console.error('Failed to load counters', e); }
        };
        if (product) syncCounters();
    }, [product]);

    // --- helper: getLabelData (reuse pattern from WeighingStation) ---
    const getLabelData = (overrideWeight?: number, isBoxLabel = false, overrideUnits?: number, overrides?: any) => {
        const currentWeightVal = overrideWeight !== undefined ? overrideWeight : parseFloat(weight);
        const now = labelingDate;
        const expDays = product?.exp_date || 0;
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
            if (product?.extra_data) {
                extra = typeof product.extra_data === 'string' ? JSON.parse(product.extra_data) : product.extra_data;
            }
        } catch (e) { }

        const effectiveTotalUnits = overrides?.totalUnits ?? totalUnits;
        const effectiveTotalBoxes = overrides?.totalBoxes ?? totalBoxes;
        const effectiveUnitsInBox = overrides?.unitsInBox ?? unitsInBox;
        const effectiveBoxNetWeight = overrides?.boxNetWeight ?? boxNetWeight;

        const weightBruttoPack = currentWeightVal;
        const portionContainer = containers.find(c => String(c.id) === String(product?.portion_container_id));
        const tarePack = (portionContainer?.weight || product?.portion_weight || 0) / 1000;
        const weightNettoPack = Math.max(0, weightBruttoPack - tarePack);
        const effectiveBoxNet = isBoxLabel ? currentWeightVal : (effectiveBoxNetWeight + weightNettoPack);
        const boxContainer = containers.find(c => c.id === product?.box_container_id);
        const tarePackGrams = portionContainer?.weight || 0;
        const tareBoxGrams = boxContainer?.weight || 0;
        let packsInThisBox = isBoxLabel ? (overrideUnits !== undefined ? overrideUnits : effectiveUnitsInBox) : (effectiveUnitsInBox + 1);
        const weightBruttoBox = effectiveBoxNet + (packsInThisBox * tarePackGrams / 1000) + (tareBoxGrams / 1000);
        const weightNettoPallet = effectiveBoxNet * (boxesInPallet + 1);
        const weightBruttoPallet = weightNettoPallet + 20;
        const currentUnits = overrideUnits !== undefined ? overrideUnits : effectiveUnitsInBox;

        const batchNumber = activeJob?.batch_number || '';

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
            name: product?.name || '', article: product?.article || '',
            exp_date: String(expDays), box_id: currentBoxId,
            weight: weightNettoPack.toFixed(3),
            weight_netto_pack: weightNettoPack.toFixed(3), weight_brutto_pack: weightBruttoPack.toFixed(3),
            weight_netto_box: effectiveBoxNet.toFixed(3), weight_brutto_box: weightBruttoBox.toFixed(3),
            weight_netto_pallet: weightNettoPallet.toFixed(3), weight_brutto_pallet: weightBruttoPallet.toFixed(3),
            weight_brutto_all: weightBruttoPallet.toFixed(3),
            date: formatDate(now), production_date: formatFullDate(now),
            date_exp: formatDate(expDate), exp_date_full: formatFullDate(expDate),
            pack_number: unitNumStr, box_number: boxNumStr,
            batch_number: batchNumber,
            pack_count: String(currentUnits + (isBoxLabel ? 0 : 1)),
            pack_counter: String(currentUnits + (isBoxLabel ? 0 : 1)),
            box_count: String(boxesInPallet + 1),
            close_box_counter: String(currentUnits + (isBoxLabel ? 0 : 1)),
            box_limit: product?.close_box_counter?.toString() || '',
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
                        article: product?.article, unit_number: unitNumStr, box_number: boxNumStr,
                        batch_number: batchNumber
                    };
                    return generateBarcode(JSON.parse(packBarcodeTemplate.structure).fields, genData);
                } catch (err) { console.error('Barcode generation failed:', err); }
            }
            return product?.barcode || product?.article || '0000000000000';
        })();

        return dataObj;
    };

    // --- BOX LABEL PRINT ---
    const printBoxLabel = async (finalBoxWeight: number, finalUnitsInBox: number, boxNumber: string, boxId: number) => {
        if (!boxLabelDoc) return;
        const boxLimit = product?.close_box_counter || 0;
        const baseData = getLabelData(finalBoxWeight, true, finalUnitsInBox);
        baseData.box_number = boxNumber;

        let boxBarcode = '';
        if (boxBarcodeTemplate) {
            try {
                const fields = JSON.parse(boxBarcodeTemplate.structure).fields;
                const boxCont = containers.find(c => c.id === product?.box_container_id);
                const brutBox = finalBoxWeight + (boxCont?.weight || 0) / 1000;
                const expDateBox = new Date(labelingDate);
                expDateBox.setDate(labelingDate.getDate() + (product?.exp_date || 0));
                boxBarcode = generateBarcode(fields, {
                    weight_netto_box: finalBoxWeight, weight_brutto_box: brutBox,
                    production_date: labelingDate, exp_date: expDateBox,
                    article: (product?.article || '').padStart(14, '0'),
                    box_number: boxNumber, batch_number: activeJob?.batch_number || ''
                } as BarcodeData);
            } catch (err) { console.error(err); }
        }
        const resolvedBarcode = boxBarcode || baseData.barcode;
        const isDefaultZeros = !resolvedBarcode || /^0+$/.test(resolvedBarcode);
        const finalBarcode = isDefaultZeros ? ((baseData as any)['Код ШК'] || product?.barcode || product?.article || '0000000000000') : resolvedBarcode;
        const boxData = { ...baseData, is_box: true, count: boxLimit, pack_counter: String(finalUnitsInBox), weight_netto: finalBoxWeight.toFixed(3), barcode: finalBarcode };
        await window.electron.invoke('print-label', { silent: true, labelDoc: boxLabelDoc, data: boxData, printerConfig: printerConfig.boxPrinter || undefined });
        const boxCont = containers.find(c => c.id === product?.box_container_id);
        const brutBox = finalBoxWeight + (boxCont?.weight || 0) / 1000;
        await window.electron.invoke('close-box', { boxId, weightNetto: finalBoxWeight, weightBrutto: brutBox });
        setLastPrinted({ doc: boxLabelDoc, data: boxData });
    };

    // --- PRINT SINGLE PACK (for pcs mode or scale weigh mode) ---
    const printSinglePack = async (packWeight: number, overrides?: any) => {
        if (!labelDoc || !product || !activeJob) return;

        const predictedData = getLabelData(packWeight, false, undefined, overrides);
        const predictedBoxNum = currentBoxNumber || predictedData.box_number;
        const batchNumber = activeJob.batch_number || '';

        let packBarcode = '';
        if (packBarcodeTemplate) {
            try {
                const fields = JSON.parse(packBarcodeTemplate.structure).fields;
                const expDatePack = new Date(labelingDate);
                expDatePack.setDate(labelingDate.getDate() + (product?.exp_date || 0));
                packBarcode = generateBarcode(fields, {
                    weight_netto_pack: parseFloat(predictedData.weight_netto_pack),
                    weight_brutto_pack: parseFloat(predictedData.weight_brutto_pack),
                    production_date: labelingDate, exp_date: expDatePack,
                    article: (product?.article || '').padStart(14, '0'),
                    pack_number: predictedData.pack_number, box_number: predictedBoxNum,
                    batch_number: batchNumber
                } as any);
            } catch (err) { console.error(err); }
        }

        const expDatePack = new Date(labelingDate);
        expDatePack.setDate(labelingDate.getDate() + (product?.exp_date || 0));

        const recordResult = await window.electron.invoke('record-pack', {
            number: predictedData.pack_number, box_number: predictedBoxNum,
            nomenclature_id: product.id,
            weight_netto: parseFloat(predictedData.weight_netto_pack),
            weight_brutto: parseFloat(predictedData.weight_brutto_pack),
            barcode_value: packBarcode, station_number: stationNumber,
            production_date: labelingDate.toISOString(),
            expiration_date: expDatePack.toISOString(), batch: batchNumber
        });

        if (!recordResult.success) throw new Error('Database recording failed');

        const finalData = getLabelData(packWeight, false, undefined, overrides);
        finalData.box_number = recordResult.boxNumber;
        await window.electron.invoke('print-label', {
            silent: true, labelDoc, data: finalData,
            printerConfig: printerConfig.packPrinter || undefined
        });
        setLastPrinted({ doc: labelDoc, data: finalData });

        return {
            recordResult,
            weightNetto: parseFloat(finalData.weight_netto_pack)
        };
    };

    // --- START JOB (pcs mode — batch print) ---
    const handleStartPcsJob = async () => {
        if (!activeJob || !product || !labelDoc) return;
        if (isPrintingRef.current) return;

        setIsPrinting(true);
        isPrintingRef.current = true;
        cancelRef.current = false;

        const fixedWeightKg = (product.is_fixed_weight ? (product.fixed_weight_grams || 0) : 0) / 1000;
        const packWeight = fixedWeightKg > 0 ? fixedWeightKg : 0.1; // fallback for non-fixed products

        let localTotalUnits = totalUnits;
        let localTotalBoxes = totalBoxes;
        let localUnitsInBox = unitsInBox;
        let localBoxNetWeight = boxNetWeight;
        let localBoxesInPallet = boxesInPallet;
        let localCurrentBoxNumber = currentBoxNumber;
        let localCurrentBoxId = currentBoxId;
        let localPrintedQty = activeJob.printed_qty;
        const boxLimit = product.close_box_counter || 999999;

        const remaining = Math.ceil(activeJob.quantity - activeJob.printed_qty);

        for (let i = 0; i < remaining; i++) {
            if (cancelRef.current) break;

            try {
                const overrides = { totalUnits: localTotalUnits, totalBoxes: localTotalBoxes, unitsInBox: localUnitsInBox, boxNetWeight: localBoxNetWeight };
                const result = await printSinglePack(packWeight, overrides);
                if (!result) break;

                if (result.recordResult.newBoxCreated) localTotalBoxes++;
                localCurrentBoxId = result.recordResult.boxId;
                localCurrentBoxNumber = result.recordResult.boxNumber;
                localTotalUnits++;
                localUnitsInBox++;
                localBoxNetWeight += result.weightNetto;
                localPrintedQty++;

                // Update progress in DB
                await window.electron.invoke('update-print-job-progress', { jobId: activeJob.job_id, printedQty: localPrintedQty });

                // Update React state for UI
                setTotalUnits(localTotalUnits);
                setUnitsInBox(localUnitsInBox);
                setBoxNetWeight(localBoxNetWeight);
                setCurrentBoxId(localCurrentBoxId);
                setCurrentBoxNumber(localCurrentBoxNumber);

                // Auto close box
                if (localUnitsInBox >= boxLimit) {
                    await printBoxLabel(localBoxNetWeight, localUnitsInBox, localCurrentBoxNumber!, localCurrentBoxId!);
                    localUnitsInBox = 0;
                    localBoxNetWeight = 0;
                    localBoxesInPallet++;
                    localCurrentBoxId = null;
                    localCurrentBoxNumber = null;
                    setUnitsInBox(0); setBoxNetWeight(0);
                    setBoxesInPallet(localBoxesInPallet);
                    setCurrentBoxId(null); setCurrentBoxNumber(null);
                }

                // Small delay between prints
                await new Promise(r => setTimeout(r, 200));
            } catch (err) {
                console.error('Print error:', err);
                setAlertMessage(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
                break;
            }
        }

        // Final sync
        setTotalUnits(localTotalUnits);
        setTotalBoxes(localTotalBoxes);
        setBoxesInPallet(localBoxesInPallet);

        setIsPrinting(false);
        isPrintingRef.current = false;
        loadJobs(); // Refresh job list
    };

    // --- PRINT SINGLE (kg mode — manual print per weigh) ---
    const handlePrintKgPack = async () => {
        if (!activeJob || !product || !labelDoc) return;
        if (isPrintingRef.current) return;
        isPrintingRef.current = true;

        try {
            const cw = parseFloat(weightRef.current);
            if (cw <= 0.010) {
                setAlertMessage(t('pj.putOnScale'));
                return;
            }

            const boxLimit = product.close_box_counter || 999999;
            const result = await printSinglePack(cw);
            if (!result) return;

            if (result.recordResult.newBoxCreated) setTotalBoxes(prev => prev + 1);
            setCurrentBoxId(result.recordResult.boxId);
            setCurrentBoxNumber(result.recordResult.boxNumber);

            const newUnitsInBox = unitsInBox + 1;
            const newBoxNetWeight = boxNetWeight + result.weightNetto;
            const newPrintedQty = activeJob.printed_qty + result.weightNetto;

            // Update job progress (kg mode: add weight)
            await window.electron.invoke('update-print-job-progress', { jobId: activeJob.job_id, printedQty: newPrintedQty });

            if (newUnitsInBox >= boxLimit) {
                await printBoxLabel(newBoxNetWeight, newUnitsInBox, result.recordResult.boxNumber, result.recordResult.boxId);
                setUnitsInBox(0); setBoxNetWeight(0); setBoxesInPallet(prev => prev + 1);
                setTotalUnits(prev => prev + 1);
                setCurrentBoxId(null); setCurrentBoxNumber(null);
            } else {
                setUnitsInBox(newUnitsInBox); setBoxNetWeight(newBoxNetWeight);
                setTotalUnits(prev => prev + 1);
            }

            loadJobs();
        } catch (err) {
            console.error('Print error:', err);
            setAlertMessage(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            isPrintingRef.current = false;
        }
    };

    // --- CLOSE BOX ---
    const handleCloseBox = async () => {
        if (unitsInBox === 0) { setAlertMessage(t('pj.emptyBox')); return; }
        const finalBoxWeight = boxNetWeight;
        const finalUnitsInBox = unitsInBox;
        setUnitsInBox(0); setBoxNetWeight(0); setBoxesInPallet(prev => prev + 1); setTotalBoxes(prev => prev + 1);
        if (currentBoxId && currentBoxNumber) {
            await printBoxLabel(finalBoxWeight, finalUnitsInBox, currentBoxNumber, currentBoxId);
        }
        setCurrentBoxId(null); setCurrentBoxNumber(null);
    };

    // --- COMPLETE JOB (manual) ---
    const handleCompleteJob = async (jobId: number) => {
        try {
            await window.electron.invoke('complete-print-job', jobId);
            if (activeJob?.job_id === jobId) setActiveJob(null);
            loadJobs();
        } catch (e) {
            console.error('Failed to complete job:', e);
        }
    };

    // --- DELETE JOB ---
    const handleDeleteJob = async (jobId: number) => {
        try {
            await window.electron.invoke('delete-print-job', jobId);
            if (activeJob?.job_id === jobId) setActiveJob(null);
            loadJobs();
        } catch (e) {
            console.error('Failed to delete job:', e);
        }
    };

    // --- IMPORT FILE ---
    const handleImportFile = async () => {
        try {
            const result = await window.electron.invoke('import-print-job-file');
            if (result.success) {
                setAlertMessage(t('pj.importSuccess').replace('{count}', String(result.count || 0)));
                loadJobs();
            } else if (result.message !== 'Cancelled') {
                setAlertMessage(`${t('ws.errorPrefix')}: ${result.message}`);
            }
        } catch (e: any) {
            setAlertMessage(`${t('ws.errorPrefix')}: ${e.message}`);
        }
    };

    // --- REPEAT ---
    const handleRepeat = async () => {
        if (!lastPrinted) { setAlertMessage(t('pj.noReprintData')); return; }
        await window.electron.invoke('print-label', { silent: true, labelDoc: lastPrinted.doc, data: lastPrinted.data, printerConfig: printerConfig.packPrinter });
    };

    // --- RENDER HELPERS ---
    const getStatusColor = (status: string) => {
        switch (status) {
            case 'in_progress': return 'bg-blue-500/10 border-blue-500/20 text-blue-600 dark:text-blue-400';
            case 'completed': return 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400';
            default: return 'bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400';
        }
    };

    const getStatusIcon = (status: string) => {
        switch (status) {
            case 'in_progress': return <Loader2 className="w-4 h-4 animate-spin" />;
            case 'completed': return <CheckCircle2 className="w-4 h-4" />;
            default: return <Clock className="w-4 h-4" />;
        }
    };

    const formatQty = (qty: number, unit: string) => {
        if (unit === 'kg') return `${qty.toFixed(3)} ${t('pj.kg')}`;
        return `${Math.floor(qty)} ${t('pj.pcs')}`;
    };

    const getProgress = (job: PrintJobData) => {
        if (job.quantity <= 0) return 0;
        return Math.min(100, (job.printed_qty / job.quantity) * 100);
    };

    const activeJobs = jobs.filter(j => j.status !== 'completed');
    const completedJobs = jobs.filter(j => j.status === 'completed');

    return (
        <div className="grid grid-cols-12 gap-6 h-full p-4 relative">
            {/* Main Panel — Job List */}
            <div className="col-span-8 bg-white dark:bg-neutral-900/50 border border-neutral-200 dark:border-white/5 rounded-3xl p-8 backdrop-blur shadow-sm dark:shadow-2xl flex flex-col overflow-hidden">
                {/* Header */}
                <div className="flex justify-between items-center mb-6">
                    <h2 className="text-2xl font-semibold text-neutral-900 dark:text-white flex items-center gap-3">
                        <ClipboardList className="w-7 h-7 text-violet-500" />
                        {t('pj.title')}
                    </h2>
                    <button
                        onClick={handleImportFile}
                        className="flex items-center gap-2 px-4 py-2.5 bg-violet-100 dark:bg-violet-500/10 border border-violet-300 dark:border-violet-500/20 text-violet-700 dark:text-violet-300 rounded-2xl text-sm font-semibold hover:bg-violet-200 dark:hover:bg-violet-500/20 transition-all"
                    >
                        <Upload className="w-4 h-4" /> {t('pj.importFile')}
                    </button>
                </div>

                {/* Active Jobs */}
                <div className="flex-1 overflow-y-auto space-y-3 pr-1">
                    {activeJobs.length === 0 && completedJobs.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-64 text-neutral-400 dark:text-neutral-600">
                            <ClipboardList className="w-16 h-16 mb-4 opacity-30" />
                            <p className="text-lg font-medium">{t('pj.noJobs')}</p>
                            <p className="text-sm mt-1">{t('pj.noJobsHint')}</p>
                        </div>
                    )}

                    {activeJobs.map(job => (
                        <div
                            key={job.job_id}
                            onClick={() => selectJob(job)}
                            className={`p-5 rounded-2xl border cursor-pointer transition-all group ${activeJob?.job_id === job.job_id
                                    ? 'bg-violet-50 dark:bg-violet-500/10 border-violet-300 dark:border-violet-500/30 shadow-lg shadow-violet-500/5'
                                    : 'bg-neutral-50 dark:bg-black/20 border-neutral-200 dark:border-white/5 hover:bg-neutral-100 dark:hover:bg-black/30 hover:border-neutral-300 dark:hover:border-white/10'
                                }`}
                        >
                            <div className="flex justify-between items-start mb-3">
                                <div className="flex-1 min-w-0">
                                    <h3 className="text-lg font-bold text-neutral-900 dark:text-white truncate">{job.nomenclature_name}</h3>
                                    <div className="flex items-center gap-3 mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                                        {job.nomenclature_article && <span className="font-mono">{job.nomenclature_article}</span>}
                                        {job.batch_number && <span className="flex items-center gap-1"><Hash className="w-3 h-3" />{job.batch_number}</span>}
                                        <span className="font-mono text-xs opacity-60">ID: {job.job_id}</span>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2 ml-3">
                                    <span className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border ${getStatusColor(job.status)}`}>
                                        {getStatusIcon(job.status)} {t(`pj.status.${job.status}`)}
                                    </span>
                                </div>
                            </div>

                            {/* Progress bar */}
                            <div className="mt-3">
                                <div className="flex justify-between text-xs font-mono mb-1.5">
                                    <span className="text-neutral-500 dark:text-neutral-400">
                                        {formatQty(job.printed_qty, job.quantity_unit)} / {formatQty(job.quantity, job.quantity_unit)}
                                    </span>
                                    <span className="font-bold text-neutral-700 dark:text-neutral-300">{getProgress(job).toFixed(0)}%</span>
                                </div>
                                <div className="w-full bg-neutral-200 dark:bg-white/10 rounded-full h-2.5 overflow-hidden">
                                    <div
                                        className={`h-full rounded-full transition-all duration-500 ${job.status === 'completed' ? 'bg-emerald-500' : 'bg-gradient-to-r from-violet-500 to-blue-500'}`}
                                        style={{ width: `${getProgress(job)}%` }}
                                    />
                                </div>
                            </div>
                        </div>
                    ))}

                    {/* Completed jobs — collapsed */}
                    {completedJobs.length > 0 && (
                        <div className="pt-4 border-t border-neutral-200 dark:border-white/5 mt-4">
                            <p className="text-xs uppercase tracking-widest text-neutral-400 dark:text-neutral-600 font-bold mb-3">{t('pj.status.completed')} ({completedJobs.length})</p>
                            {completedJobs.map(job => (
                                <div key={job.job_id}
                                    className="p-3 rounded-xl border border-neutral-200 dark:border-white/5 bg-neutral-50 dark:bg-black/10 mb-2 opacity-60 flex justify-between items-center">
                                    <div>
                                        <span className="font-medium text-sm text-neutral-700 dark:text-neutral-400">{job.nomenclature_name}</span>
                                        <span className="ml-3 text-xs font-mono text-neutral-400">{formatQty(job.quantity, job.quantity_unit)}</span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                                        <button onClick={(e) => { e.stopPropagation(); handleDeleteJob(job.job_id); }}
                                            className="p-1.5 hover:bg-red-100 dark:hover:bg-red-900/30 rounded-lg transition-colors"
                                            title={t('ws.delete')}>
                                            <Trash2 className="w-3.5 h-3.5 text-neutral-400 hover:text-red-500" />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Right Panel — Controls */}
            <div className="col-span-4 space-y-4 flex flex-col">
                {activeJob ? (
                    <>
                        {/* Active Job Info */}
                        <div className="p-5 bg-violet-50 dark:bg-violet-500/5 border border-violet-200 dark:border-violet-500/10 rounded-2xl">
                            <h3 className="text-sm uppercase tracking-wider text-violet-600 dark:text-violet-500/60 font-bold mb-1">{t('pj.activeJob')}</h3>
                            <div className="text-xl font-bold text-violet-700 dark:text-violet-100 mb-2">{activeJob.nomenclature_name}</div>
                            <div className="flex flex-wrap gap-3 text-sm">
                                <span className="font-mono bg-violet-100 dark:bg-violet-500/10 px-2 py-0.5 rounded text-violet-700 dark:text-violet-300">
                                    {t('pj.quantity')}: {formatQty(activeJob.quantity, activeJob.quantity_unit)}
                                </span>
                                <span className="font-mono bg-violet-100 dark:bg-violet-500/10 px-2 py-0.5 rounded text-violet-700 dark:text-violet-300">
                                    {t('pj.printed')}: {formatQty(activeJob.printed_qty, activeJob.quantity_unit)}
                                </span>
                                {activeJob.batch_number && (
                                    <span className="font-mono bg-amber-100 dark:bg-amber-500/10 px-2 py-0.5 rounded text-amber-700 dark:text-amber-300">
                                        {t('pj.batch')}: {activeJob.batch_number}
                                    </span>
                                )}
                            </div>
                        </div>

                        {/* Kg mode: Show scale weight */}
                        {activeJob.quantity_unit === 'kg' && (
                            <div className="bg-neutral-50 dark:bg-black/30 border border-neutral-200 dark:border-white/10 rounded-2xl p-5 text-center">
                                <div className="flex justify-between items-center mb-2">
                                    <label className="text-xs uppercase tracking-widest text-neutral-500 font-bold">{t('ws.gross')}</label>
                                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${scaleStatus === 'connected' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500'}`}>
                                        {scaleStatus === 'connected' ? t('ws.scaleStatus.connected') : t('ws.scaleStatus.disconnected')}
                                    </span>
                                </div>
                                <div className="text-5xl font-mono text-emerald-600 dark:text-emerald-400 font-light tracking-tighter">
                                    {weight} <span className="text-xl text-emerald-500/50">{t('ws.kg')}</span>
                                </div>
                                {isStable && (
                                    <div className="mt-2 text-emerald-600 dark:text-emerald-500/60 text-xs font-bold uppercase tracking-widest animate-pulse flex items-center justify-center gap-2">
                                        <div className="w-1 h-1 rounded-full bg-emerald-500"></div> {t('ws.stable')}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Print Button */}
                        {activeJob.quantity_unit === 'pcs' ? (
                            !isPrinting ? (
                                <button
                                    onClick={handleStartPcsJob}
                                    className="w-full py-8 bg-violet-600 hover:bg-violet-500 active:bg-violet-700 transition-all rounded-3xl font-bold text-2xl shadow-[0_10px_40px_-10px_rgba(139,92,246,0.5)] flex items-center justify-center gap-3 border-t border-white/10 text-white"
                                >
                                    <Play className="w-8 h-8" /> {t('pj.start')}
                                </button>
                            ) : (
                                <button
                                    onClick={() => { cancelRef.current = true; }}
                                    className="w-full py-8 bg-red-600 hover:bg-red-500 active:bg-red-700 transition-all rounded-3xl font-bold text-2xl shadow-[0_10px_40px_-10px_rgba(239,68,68,0.5)] flex items-center justify-center gap-3 border-t border-white/10 text-white animate-pulse"
                                >
                                    <Square className="w-8 h-8" /> {t('pj.pause')}
                                </button>
                            )
                        ) : (
                            <button
                                onClick={handlePrintKgPack}
                                className="w-full py-8 bg-violet-600 hover:bg-violet-500 active:bg-violet-700 transition-all rounded-3xl font-bold text-2xl shadow-[0_10px_40px_-10px_rgba(139,92,246,0.5)] flex items-center justify-center gap-3 border-t border-white/10 text-white"
                            >
                                <Printer className="w-8 h-8" /> {t('ws.print')}
                            </button>
                        )}

                        {/* Progress bar for pcs printing */}
                        {isPrinting && activeJob.quantity_unit === 'pcs' && (
                            <div className="p-4 bg-neutral-50 dark:bg-black/30 border border-neutral-200 dark:border-white/10 rounded-2xl">
                                <div className="flex justify-between text-xs font-mono mb-2">
                                    <span className="text-neutral-500">{t('pj.progress')}</span>
                                    <span className="font-bold text-neutral-700 dark:text-neutral-300">
                                        {formatQty(activeJob.printed_qty, activeJob.quantity_unit)} / {formatQty(activeJob.quantity, activeJob.quantity_unit)}
                                    </span>
                                </div>
                                <div className="w-full bg-neutral-200 dark:bg-white/10 rounded-full h-3 overflow-hidden">
                                    <div className="h-full bg-gradient-to-r from-violet-500 to-blue-500 rounded-full transition-all duration-300"
                                        style={{ width: `${getProgress(activeJob)}%` }} />
                                </div>
                            </div>
                        )}

                        {/* Action buttons */}
                        <div className="grid grid-cols-2 gap-4">
                            <button onClick={handleRepeat} className="py-6 bg-neutral-100 dark:bg-neutral-800/50 hover:bg-neutral-200 dark:hover:bg-neutral-800 border border-neutral-300 dark:border-white/5 rounded-2xl font-semibold transition-all flex flex-col items-center gap-2 group">
                                <RefreshCw className="w-6 h-6 text-neutral-500 dark:text-neutral-400 group-hover:text-neutral-800 dark:group-hover:text-white transition-colors" />
                                <span className="text-neutral-500 dark:text-neutral-400 group-hover:text-neutral-800 dark:group-hover:text-white uppercase text-xs tracking-widest">{t('ws.reprintSmall')}</span>
                            </button>
                            <button onClick={handleCloseBox} className="py-6 bg-neutral-100 dark:bg-neutral-800/50 hover:bg-neutral-200 dark:hover:bg-neutral-800 border border-neutral-300 dark:border-white/5 rounded-2xl font-semibold transition-all flex flex-col items-center gap-2 group">
                                <Box className="w-6 h-6 text-neutral-500 dark:text-neutral-400 group-hover:text-neutral-800 dark:group-hover:text-white transition-colors" />
                                <span className="text-neutral-500 dark:text-neutral-400 group-hover:text-neutral-800 dark:group-hover:text-white uppercase text-xs tracking-widest">{t('ws.closeBox')}</span>
                            </button>
                            <button onClick={() => handleCompleteJob(activeJob.job_id)} className="py-6 bg-emerald-50 dark:bg-emerald-500/5 hover:bg-emerald-100 dark:hover:bg-emerald-500/10 border border-emerald-300 dark:border-emerald-500/20 rounded-2xl font-semibold transition-all flex flex-col items-center gap-2 group col-span-2">
                                <CheckCircle2 className="w-6 h-6 text-emerald-500 group-hover:text-emerald-600 transition-colors" />
                                <span className="text-emerald-600 dark:text-emerald-400 group-hover:text-emerald-700 dark:group-hover:text-emerald-300 uppercase text-xs tracking-widest">{t('pj.complete')}</span>
                            </button>
                        </div>
                    </>
                ) : (
                    <div className="flex-1 flex flex-col items-center justify-center text-neutral-400 dark:text-neutral-600 p-8">
                        <ClipboardList className="w-20 h-20 mb-4 opacity-20" />
                        <p className="text-center text-sm">{t('pj.selectJob')}</p>
                    </div>
                )}

                {/* Session Stats */}
                <div className="mt-auto p-6 bg-white dark:bg-neutral-900/50 border border-neutral-200 dark:border-white/5 shadow-sm dark:shadow-none rounded-3xl backdrop-blur">
                    <h3 className="text-sm font-semibold mb-4 text-neutral-500 dark:text-white/60 uppercase tracking-widest">{t('ws.sessionStats')}</h3>
                    <div className="space-y-3">
                        <div className="flex justify-between items-center p-3 bg-neutral-100 dark:bg-white/5 border border-neutral-300 dark:border-white/10 rounded-xl cursor-pointer hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-all"
                            onClick={() => setIsDatePickerOpen(true)}>
                            <span className="text-xs uppercase tracking-wider text-neutral-500 font-bold">{t('pj.labelingDate')}</span>
                            <div className="flex items-center gap-3">
                                <span className="text-sm font-mono font-bold text-neutral-900 dark:text-white">
                                    {labelingDate.toLocaleDateString('ru-RU')}
                                </span>
                                <div className="p-2 bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-white/10 rounded-lg">
                                    <Calendar className="w-4 h-4 text-violet-600 dark:text-violet-500" />
                                </div>
                            </div>
                        </div>

                        {[
                            { label: t('ws.inBox'), value: unitsInBox },
                            { label: t('ws.boxesOnPallet'), value: boxesInPallet },
                            { label: t('ws.totalUnits'), value: totalUnits },
                        ].map((stat, i) => (
                            <div key={i} className="flex justify-between items-center p-3 bg-neutral-100 dark:bg-white/5 border border-neutral-300 dark:border-white/10 rounded-xl">
                                <span className="text-xs uppercase tracking-wider text-neutral-500 font-bold">{stat.label}</span>
                                <span className="text-lg font-mono font-bold text-neutral-900 dark:text-white">{stat.value}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* Alert Modal */}
            {alertMessage && (
                <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => setAlertMessage(null)}>
                    <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-white/10 p-8 rounded-3xl shadow-2xl text-center max-w-md mx-4" onClick={e => e.stopPropagation()}>
                        <AlertCircle className="w-12 h-12 text-amber-500 mx-auto mb-4" />
                        <p className="text-neutral-900 dark:text-white text-lg mb-6">{alertMessage}</p>
                        <button onClick={() => setAlertMessage(null)}
                            className="px-8 py-3 bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 rounded-2xl font-bold hover:bg-neutral-800 dark:hover:bg-neutral-100 transition-colors">
                            {t('ws.ok')}
                        </button>
                    </div>
                </div>
            )}

            {/* Date Picker */}
            {isDatePickerOpen && (
                <DatePickerModal
                    value={labelingDate}
                    onUpdate={(d: Date) => { setLabelingDate(d); setIsDatePickerOpen(false); }}
                    onClose={() => setIsDatePickerOpen(false)}
                />
            )}

            {/* Delete Modal */}
            {isDeleteModalOpen && (
                <DeleteItemsModal
                    isOpen={isDeleteModalOpen}
                    onClose={() => setIsDeleteModalOpen(false)}
                    onDeleted={async () => {
                        const latest = await window.electron.invoke('get-latest-counters', product?.id);
                        if (latest) {
                            setTotalUnits(latest.totalUnits ?? 0);
                            setTotalBoxes(latest.totalBoxes ?? 0);
                            setBoxesInPallet(latest.boxesInPallet ?? 0);
                            setUnitsInBox(latest.unitsInBox ?? 0);
                            setBoxNetWeight(latest.boxNetWeight ?? 0);
                            setCurrentBoxId(latest.currentBoxId ?? null);
                            setCurrentBoxNumber(latest.currentBoxNumber ?? null);
                        }
                    }}
                />
            )}
        </div>
    );
};

export default PrintJobStation;
