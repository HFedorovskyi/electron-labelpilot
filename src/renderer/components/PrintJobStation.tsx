import { useEffect, useState, useRef, useCallback } from 'react';
import { ClipboardList, Play, Printer, RefreshCw, Upload, CheckCircle2, Clock, Loader2, Trash2, Box, Hash, Calendar, AlertCircle, Layers, ArrowLeft } from 'lucide-react';
import { printPalletSheet } from '../utils/palletPrint';
import { generateBarcode, type BarcodeData } from '../utils/barcodeGenerator';
import { useTranslation } from '../i18n';
import DatePickerModal from './DatePickerModal';
import DeleteItemsModal from './DeleteItemsModal';
import { useSession } from './SessionProvider';

interface PrintJobData {
    id: number;
    job_id: number;
    nomenclature_id: number;
    nomenclature_name: string;
    nomenclature_article: string;
    quantity: number;
    quantity_unit: 'pcs' | 'kg';
    batch_number: string;
    marking_date: string | null;
    printed_qty: number;
    status: 'pending' | 'in_progress' | 'completed';
    created_at: string;
    completed_at: string | null;
}

const PrintJobStation = (_props: { activeTab?: string }) => {
    const { t } = useTranslation();
    // Current operator (PIN-login layer) — used for the pallet-sheet operator_name.
    const { operator } = useSession();

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
    const [labelingDate, setLabelingDate] = useState<Date>(new Date());
    const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);
    const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
    const [syncVersion, setSyncVersion] = useState(0);
    const [jobsTab, setJobsTab] = useState<'active' | 'completed'>('active');

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
    // Printer-readiness indicator + manual-print feedback + complete-job confirmation (parity).
    const [printerStatus, setPrinterStatus] = useState<'unknown' | 'ready' | 'unreachable' | 'unconfigured' | 'driver'>('unknown');
    const [printToast, setPrintToast] = useState<string | null>(null);
    const [lastPrintInfo, setLastPrintInfo] = useState<{ label: string; time: string } | null>(null);
    const printToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [confirmCompleteJobId, setConfirmCompleteJobId] = useState<number | null>(null);

    // Refs
    const isPrintingRef = useRef(false);
    const cancelRef = useRef(false);
    const weightRef = useRef('0.000');
    const isPalletPrintingRef = useRef(false);
    // Latest active tab for the mounted-once scale-reading listener (avoids stale closure).
    const activeTabRef = useRef(_props.activeTab);
    activeTabRef.current = _props.activeTab;
    const kgPrintedQtyRef = useRef(0);
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
            if (activeTabRef.current !== 'printJob') return; // skip while hidden
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

    // Eagerly open TCP/Serial to configured printers so first label doesn't pay the handshake.
    useEffect(() => {
        if (!printerConfig.packPrinter && !printerConfig.boxPrinter) { setPrinterStatus('unconfigured'); return; }
        window.electron.invoke('printer:warmup', { printerIds: ['pack', 'box'] })
            .then((res: any) => { if (res?.results?.pack) setPrinterStatus(res.results.pack); })
            .catch(() => { /* best-effort */ });
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

    // --- SELECT JOB ---
    const selectJob = useCallback(async (job: PrintJobData) => {
        if (job.status === 'completed') return;

        // Block switching if box is not closed
        if (unitsInBox > 0 && activeJob && activeJob.job_id !== job.job_id) {
            setAlertMessage(t('ws.closeBoxBeforeChange'));
            return;
        }

        setActiveJob(job);
        cancelRef.current = false;
        kgPrintedQtyRef.current = job.printed_qty || 0;

        // Set labeling date from job's marking_date (if provided by server)
        if (job.marking_date) {
            const md = new Date(job.marking_date + 'T00:00:00');
            if (!isNaN(md.getTime())) setLabelingDate(md);
        }

        // Load product data from nomenclature
        try {
            const products = await window.electron.invoke('get-products', job.nomenclature_article || job.nomenclature_name);
            const found = products.find((p: any) => p.id === job.nomenclature_id) || products[0];
            setProduct(found || null);
        } catch (e) {
            console.error('Failed to load product:', e);
            setProduct(null);
        }
    }, [unitsInBox, activeJob]);

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
        // syncVersion: re-fetch counters after data-updated (e.g. pallet sheet printed → pallet
        // closed) so box/pallet counters reset instead of showing stale values.
    }, [product, syncVersion]);

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

    // Brief auto-dismissing success toast for the manual print.
    const showPrintToast = (msg: string) => {
        setPrintToast(msg);
        if (printToastTimer.current) clearTimeout(printToastTimer.current);
        printToastTimer.current = setTimeout(() => setPrintToast(null), 1800);
    };
    useEffect(() => () => { if (printToastTimer.current) clearTimeout(printToastTimer.current); }, []);

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
        // Fire-and-forget: UI doesn't depend on print success, and main-process queue preserves order.
        // Lets this function return as soon as DB is recorded, shaving an IPC roundtrip off perceived latency.
        window.electron.invoke('print-label', {
            silent: true, labelDoc, data: finalData,
            printerConfig: printerConfig.packPrinter || undefined
        })
            .then((ok: any) => { if (printerConfig.packPrinter) setPrinterStatus(ok === false ? 'unreachable' : 'ready'); })
            .catch((e: any) => { console.error('[printSinglePack] print failed', e); if (printerConfig.packPrinter) setPrinterStatus('unreachable'); });
        setLastPrinted({ doc: labelDoc, data: finalData });
        const time = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        setLastPrintInfo({ label: String(finalData.pack_number || ''), time });
        showPrintToast(t('ws.printSentToast'));

        return {
            recordResult,
            weightNetto: parseFloat(finalData.weight_netto_pack)
        };
    };

    // --- PRINT SINGLE PACK (pcs mode — scale-based) ---
    const handlePrintPcsPack = async () => {
        if (!activeJob || !product || !labelDoc) return;
        if (isPrintingRef.current) return;
        isPrintingRef.current = true;

        try {
            const cw = parseFloat(weightRef.current);
            if (cw <= 0.010) {
                setAlertMessage(t('pj.putOnScale'));
                return;
            }

            // Fixed weight: validate min/max, use fixed weight for label
            const isFixed = product.is_fixed_weight;
            let labelWeight: number;

            if (isFixed) {
                const wGrams = cw * 1000;
                const min = product.min_weight_grams || 0;
                const max = product.max_weight_grams || Infinity;
                if (wGrams < min || wGrams > max) {
                    setAlertMessage(t('fw.printNotAllowed'));
                    return;
                }
                labelWeight = (product.fixed_weight_grams || 0) / 1000;
            } else {
                // Non-fixed: use actual scale weight
                labelWeight = cw;
            }

            const boxLimit = product.close_box_counter || 999999;
            const result = await printSinglePack(labelWeight);
            if (!result) return;

            if (result.recordResult.newBoxCreated) setTotalBoxes(prev => prev + 1);
            setCurrentBoxId(result.recordResult.boxId);
            setCurrentBoxNumber(result.recordResult.boxNumber);

            const newUnitsInBox = unitsInBox + 1;
            const newBoxNetWeight = boxNetWeight + result.weightNetto;
            kgPrintedQtyRef.current += 1; // pcs mode: count by weighings
            const newPrintedQty = kgPrintedQtyRef.current;

            // Update job progress
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
            setAlertMessage(`${t('ws.errorPrefix')}: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            isPrintingRef.current = false;
        }
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
            kgPrintedQtyRef.current += result.weightNetto;
            const newPrintedQty = kgPrintedQtyRef.current;

            // Update job progress (kg mode: accumulate weight)
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
            setAlertMessage(`${t('ws.errorPrefix')}: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            isPrintingRef.current = false;
        }
    };

    // --- BACK TO JOB SELECTION (deselect active job) ---
    const handleBackToJobs = () => {
        if (unitsInBox > 0) { setAlertMessage(t('ws.closeBoxBeforeChange')); return; }
        setActiveJob(null);
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

    const getNetWeight = () => {
        if (!product) return weight;
        const currentWeight = parseFloat(weight);
        const portionContainerId = product.portion_container_id;
        const portionContainer = portionContainerId
            ? containers.find(c => String(c.id) === String(portionContainerId))
            : null;
        const tareGrams = portionContainer?.weight || product.portion_weight || 0;
        const tareKg = tareGrams / 1000;
        return Math.max(0, currentWeight - tareKg).toFixed(3);
    };

    const activeJobs = jobs.filter(j => j.status !== 'completed');
    const completedJobs = jobs.filter(j => j.status === 'completed');

    // Glanceable box-fill progress (emerald → amber ≥80% → red full).
    const boxFillLimit = Number(product?.close_box_counter) || 0;
    const boxFillPct = boxFillLimit > 0 ? Math.min(100, Math.round((unitsInBox / boxFillLimit) * 100)) : 0;
    const boxFillColor = boxFillPct >= 100 ? 'bg-red-500' : boxFillPct >= 80 ? 'bg-amber-500' : 'bg-emerald-500';

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

                {/* Active Job — shown above the weight display, with a back-to-jobs button */}
                {activeJob && (
                    <div className="mb-4 p-4 bg-violet-50 dark:bg-violet-500/5 border border-violet-200 dark:border-violet-500/10 rounded-2xl">
                        <div className="flex justify-between items-start gap-3">
                            <div className="flex-1 min-w-0">
                                <h3 className="text-xs uppercase tracking-wider text-violet-600 dark:text-violet-500/60 font-bold mb-1">{t('pj.activeJob')}</h3>
                                <div className="text-lg font-bold text-violet-700 dark:text-violet-100 mb-2">{activeJob.nomenclature_name}</div>
                                <div className="flex flex-wrap gap-2 text-sm">
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
                            <button onClick={handleBackToJobs} className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-white/10 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-white/10 text-sm font-semibold transition-colors">
                                <ArrowLeft className="w-4 h-4" /> {t('pj.backToJobs')}
                            </button>
                        </div>
                    </div>
                )}

                {/* Weight Display (for all modes when a job is active) */}
                {activeJob && (
                    <div className="mb-6 grid grid-cols-2 gap-4">
                        <div className="bg-neutral-50 dark:bg-black/30 border border-neutral-200 dark:border-white/10 rounded-3xl p-8 text-center relative overflow-hidden group">
                            <div className="absolute inset-0 bg-gradient-to-br from-emerald-100/50 dark:from-emerald-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
                            <div className="flex justify-between items-center mb-2 gap-1.5">
                                <label className="text-xs uppercase tracking-widest text-neutral-500 font-bold">{t('ws.gross')}</label>
                                <div className="flex items-center gap-1.5 flex-wrap justify-end">
                                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${scaleStatus === 'connected' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500'}`}>
                                        {t('ws.scaleShort')}: {scaleStatus === 'connected' ? t('ws.scaleStatus.connected') : t('ws.scaleStatus.disconnected')}
                                    </span>
                                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full flex items-center gap-1 ${(printerStatus === 'ready' || printerStatus === 'driver') ? 'bg-emerald-500/10 text-emerald-500' : printerStatus === 'unknown' ? 'bg-neutral-500/10 text-neutral-400' : 'bg-red-500/10 text-red-500'}`}>
                                        <Printer className="w-3 h-3" />
                                        {printerStatus === 'ready' ? t('ws.printerStatus.ready') : printerStatus === 'driver' ? t('ws.printerStatus.driver') : printerStatus === 'unreachable' ? t('ws.printerStatus.unreachable') : printerStatus === 'unconfigured' ? t('ws.printerStatus.unconfigured') : t('ws.printerStatus')}
                                    </span>
                                </div>
                            </div>
                            <div className="text-7xl font-mono text-emerald-600 dark:text-emerald-400 mt-2 font-light tracking-tighter">
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
                            <div className="text-7xl font-mono text-neutral-700 dark:text-neutral-300 mt-2 font-light tracking-tighter">
                                {getNetWeight()} <span className="text-2xl text-neutral-500 dark:text-neutral-600">{t('ws.kg')}</span>
                            </div>
                        </div>
                    </div>
                )}

                {/* Tabs */}
                <div className="flex border-b border-neutral-200 dark:border-white/5 mb-4">
                    <button
                        onClick={() => setJobsTab('active')}
                        className={`flex-1 py-3 text-sm font-semibold flex items-center justify-center gap-2 transition-colors relative ${jobsTab === 'active'
                            ? 'text-violet-700 dark:text-violet-300'
                            : 'text-neutral-400 dark:text-neutral-600 hover:text-neutral-600 dark:hover:text-neutral-400'
                        }`}
                    >
                        <Play className="w-4 h-4" />
                        {t('pj.tab.active')} ({activeJobs.length})
                        {jobsTab === 'active' && (
                            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-violet-500 shadow-[0_0_10px_rgba(139,92,246,0.5)]" />
                        )}
                    </button>
                    <button
                        onClick={() => setJobsTab('completed')}
                        className={`flex-1 py-3 text-sm font-semibold flex items-center justify-center gap-2 transition-colors relative ${jobsTab === 'completed'
                            ? 'text-emerald-700 dark:text-emerald-300'
                            : 'text-neutral-400 dark:text-neutral-600 hover:text-neutral-600 dark:hover:text-neutral-400'
                        }`}
                    >
                        <CheckCircle2 className="w-4 h-4" />
                        {t('pj.tab.completed')} ({completedJobs.length})
                        {jobsTab === 'completed' && (
                            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]" />
                        )}
                    </button>
                </div>

                {/* Job List */}
                <div className="flex-1 overflow-y-auto space-y-3 pr-1">
                    {jobsTab === 'active' ? (
                        <>
                            {activeJobs.length === 0 && (
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
                        </>
                    ) : (
                        <>
                            {completedJobs.length === 0 && (
                                <div className="flex flex-col items-center justify-center h-64 text-neutral-400 dark:text-neutral-600">
                                    <CheckCircle2 className="w-16 h-16 mb-4 opacity-30" />
                                    <p className="text-lg font-medium">{t('pj.noCompleted')}</p>
                                </div>
                            )}

                            {completedJobs.map(job => (
                                <div key={job.job_id}
                                    className="p-4 rounded-2xl border border-neutral-200 dark:border-white/5 bg-neutral-50 dark:bg-black/10 mb-2 flex justify-between items-center">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                                            <span className="font-medium text-sm text-neutral-700 dark:text-neutral-300 truncate">{job.nomenclature_name}</span>
                                        </div>
                                        <div className="flex items-center gap-3 mt-1 text-xs text-neutral-400">
                                            {job.nomenclature_article && <span className="font-mono">{job.nomenclature_article}</span>}
                                            <span className="font-mono">{formatQty(job.quantity, job.quantity_unit)}</span>
                                            {job.batch_number && <span className="flex items-center gap-1"><Hash className="w-3 h-3" />{job.batch_number}</span>}
                                            {job.completed_at && <span>{new Date(job.completed_at).toLocaleDateString('ru-RU')}</span>}
                                        </div>
                                    </div>
                                    <button onClick={(e) => { e.stopPropagation(); handleDeleteJob(job.job_id); }}
                                        className="p-2 hover:bg-red-100 dark:hover:bg-red-900/30 rounded-lg transition-colors ml-3"
                                        title={t('ws.delete')}>
                                        <Trash2 className="w-4 h-4 text-neutral-400 hover:text-red-500" />
                                    </button>
                                </div>
                            ))}
                        </>
                    )}
                </div>
            </div>

            {/* Right Panel — Controls (scrolls if it doesn't fit, so nothing clips on small screens) */}
            <div className="col-span-4 space-y-4 flex flex-col overflow-y-auto min-h-0">
                {activeJob ? (
                    <>
                        {/* Print Button */}
                        <button
                            onClick={activeJob.quantity_unit === 'pcs' ? handlePrintPcsPack : handlePrintKgPack}
                            disabled={!activeJob || !labelDoc || scaleStatus !== 'connected'}
                            className="w-full py-8 bg-violet-600 hover:bg-violet-500 active:bg-violet-700 transition-all rounded-3xl font-bold text-2xl shadow-[0_10px_40px_-10px_rgba(139,92,246,0.5)] flex items-center justify-center gap-3 border-t border-white/10 text-white disabled:opacity-40 disabled:pointer-events-none disabled:shadow-none"
                        >
                            <Printer className="w-8 h-8" /> {t('ws.print')}
                        </button>

                        {/* Action buttons */}
                        <div className="grid grid-cols-2 gap-4">
                            <button onClick={handleRepeat} className="py-8 bg-neutral-100 dark:bg-neutral-800/50 hover:bg-neutral-200 dark:hover:bg-neutral-800 border border-neutral-300 dark:border-white/5 rounded-2xl font-semibold transition-all flex flex-col items-center gap-2 group">
                                <RefreshCw className="w-6 h-6 text-neutral-500 dark:text-neutral-400 group-hover:text-neutral-800 dark:group-hover:text-white transition-colors" />
                                <span className="text-neutral-500 dark:text-neutral-400 group-hover:text-neutral-800 dark:group-hover:text-white uppercase text-xs tracking-widest">{t('ws.reprintSmall')}</span>
                            </button>
                            <button onClick={handleCloseBox} disabled={unitsInBox === 0} className="py-8 bg-neutral-100 dark:bg-neutral-800/50 hover:bg-neutral-200 dark:hover:bg-neutral-800 border border-neutral-300 dark:border-white/5 rounded-2xl font-semibold transition-all flex flex-col items-center gap-2 group disabled:opacity-40 disabled:pointer-events-none">
                                <Box className="w-6 h-6 text-neutral-500 dark:text-neutral-400 group-hover:text-neutral-800 dark:group-hover:text-white transition-colors" />
                                <span className="text-neutral-500 dark:text-neutral-400 group-hover:text-neutral-800 dark:group-hover:text-white uppercase text-xs tracking-widest">{t('ws.closeBox')}</span>
                            </button>
                            <button onClick={() => setIsDeleteModalOpen(true)} className="py-8 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40 border border-red-300 dark:border-red-500/30 hover:border-red-400 dark:hover:border-red-500/50 rounded-2xl font-semibold transition-all flex flex-col items-center gap-2 group col-span-2">
                                <Trash2 className="w-6 h-6 text-red-500 dark:text-red-400 transition-colors" />
                                <span className="text-red-600 dark:text-red-400 uppercase text-xs tracking-widest">{t('ws.delete')}</span>
                            </button>
                            <button onClick={() => setConfirmCompleteJobId(activeJob.job_id)} className="py-8 bg-emerald-50 dark:bg-emerald-500/5 hover:bg-emerald-100 dark:hover:bg-emerald-500/10 border border-emerald-300 dark:border-emerald-500/20 rounded-2xl font-semibold transition-all flex flex-col items-center gap-2 group col-span-2">
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

                <button
                    onClick={() => printPalletSheet({ printerConfig, selectedProduct: product, t, setAlert: setAlertMessage, operatorName: operator?.full_name || '', busyRef: isPalletPrintingRef })}
                    className="w-full py-5 bg-violet-600 hover:bg-violet-500 active:bg-violet-700 transition-all rounded-2xl font-bold text-lg text-white flex items-center justify-center gap-3 shadow-[0_10px_30px_-12px_rgba(124,58,237,0.6)] border-t border-white/10"
                >
                    <Layers className="w-6 h-6" />
                    {t('pallet.printSheet')}
                </button>

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

                        <div className="p-3 bg-neutral-100 dark:bg-white/5 border border-neutral-300 dark:border-white/10 rounded-xl">
                            <div className="flex justify-between items-center mb-1.5">
                                <span className="text-xs uppercase tracking-wider text-neutral-500 font-bold">{t('ws.inBox')}</span>
                                <span className="text-lg font-mono font-bold text-neutral-900 dark:text-white">{unitsInBox}{boxFillLimit > 0 ? ` / ${boxFillLimit}` : ''}</span>
                            </div>
                            {boxFillLimit > 0 && (
                                <div className="h-2 w-full rounded-full bg-neutral-200 dark:bg-white/10 overflow-hidden">
                                    <div className={`h-full rounded-full transition-all duration-300 ${boxFillColor}`} style={{ width: `${boxFillPct}%` }}></div>
                                </div>
                            )}
                        </div>
                        {[
                            { label: t('ws.boxesOnPallet'), value: boxesInPallet },
                            { label: t('ws.totalUnits'), value: totalUnits },
                        ].map((stat, i) => (
                            <div key={i} className="flex justify-between items-center p-3 bg-neutral-100 dark:bg-white/5 border border-neutral-300 dark:border-white/10 rounded-xl">
                                <span className="text-xs uppercase tracking-wider text-neutral-500 font-bold">{stat.label}</span>
                                <span className="text-lg font-mono font-bold text-neutral-900 dark:text-white">{stat.value}</span>
                            </div>
                        ))}
                        {lastPrintInfo && (
                            <div className="flex justify-between text-xs pt-1 text-violet-600 dark:text-violet-400/80">
                                <span className="uppercase tracking-wider">{t('ws.lastPrinted')}</span>
                                <span className="font-mono">#{lastPrintInfo.label} · {lastPrintInfo.time}</span>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Transient print-success toast */}
            {printToast && (
                <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[250] px-6 py-3 rounded-2xl bg-violet-600 text-white font-semibold shadow-[0_10px_30px_-8px_rgba(139,92,246,0.6)] flex items-center gap-2 animate-in fade-in slide-in-from-bottom-2 duration-200">
                    <Printer className="w-5 h-5" />
                    {printToast}
                </div>
            )}

            {/* Complete-job confirmation (prevents accidental taps on a touchscreen) */}
            {confirmCompleteJobId !== null && (
                <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => setConfirmCompleteJobId(null)}>
                    <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-white/10 p-8 rounded-3xl shadow-2xl text-center max-w-md mx-4" onClick={e => e.stopPropagation()}>
                        <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto mb-4" />
                        <p className="text-neutral-900 dark:text-white text-lg mb-6">{t('pj.completeConfirm')}</p>
                        <div className="flex gap-3">
                            <button onClick={() => setConfirmCompleteJobId(null)}
                                className="flex-1 px-6 py-3 bg-neutral-100 dark:bg-white/5 text-neutral-700 dark:text-neutral-300 rounded-2xl font-bold hover:bg-neutral-200 dark:hover:bg-white/10 transition-colors">
                                {t('ws.cancel')}
                            </button>
                            <button onClick={() => { const id = confirmCompleteJobId; setConfirmCompleteJobId(null); if (id !== null) handleCompleteJob(id); }}
                                className="flex-1 px-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl font-bold transition-colors">
                                {t('pj.complete')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

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
