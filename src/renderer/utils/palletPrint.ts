// Shared "print pallet sheet" action used by all three stations.
// Validates the pallet printer, resolves the pallet template, fetches aggregated pallet
// render-data from the main process (get-pallet-render-data), and prints to the pallet
// printer. All user-facing text goes through the passed-in translator `t`.

interface PalletPrintArgs {
    printerConfig: any;                 // full printer config (reads .palletPrinter)
    selectedProduct?: any;              // for templates_pallet_label (optional)
    t: (key: string, params?: Record<string, string>) => string;
    setAlert: (msg: string | null) => void;
    operatorName?: string;
    busyRef?: { current: boolean };
}

function hasTarget(p: any): boolean {
    if (!p) return false;
    if (p.connection === 'windows_driver') return !!p.driverName;
    if (p.connection === 'tcp') return !!p.ip;
    if (p.connection === 'serial') return !!p.serialPort;
    return false;
}

export async function printPalletSheet(args: PalletPrintArgs): Promise<void> {
    const { selectedProduct, t, setAlert, operatorName, busyRef } = args;
    if (busyRef?.current) return;
    if (busyRef) busyRef.current = true;
    try {
        // Always read the freshest persisted config — the station's printerConfig state may
        // not include palletPrinter yet (loaded async / via broadcast), which previously
        // caused a false "pallet printer not configured".
        let cfg: any = args.printerConfig;
        try {
            const fresh = await window.electron.invoke('get-printer-config');
            if (fresh) cfg = fresh;
        } catch { /* fall back to passed config */ }

        const palletPrinter = cfg?.palletPrinter;
        if (!hasTarget(palletPrinter)) {
            setAlert(t('pallet.errNoPrinter'));
            return;
        }
        // 1. Resolve the pallet template: prefer the product's templates_pallet_label,
        //    fall back to any label whose canvas.labelType === 'pallet'.
        let palletDoc: any = null;
        if (selectedProduct?.templates_pallet_label) {
            const doc = await window.electron.invoke('get-label', selectedProduct.templates_pallet_label);
            if (doc?.structure) { try { palletDoc = JSON.parse(doc.structure); } catch { /* ignore */ } }
        }
        if (!palletDoc) {
            const all = await window.electron.invoke('get-all-labels');
            const found = (all || []).find((l: any) => {
                try { return JSON.parse(l.structure)?.canvas?.labelType === 'pallet'; } catch { return false; }
            });
            if (found?.structure) { try { palletDoc = JSON.parse(found.structure); } catch { /* ignore */ } }
        }
        if (!palletDoc) { setAlert(t('pallet.errNoTemplate')); return; }

        // 2. Aggregated pallet render-data (current open pallet) from the main process.
        const data = await window.electron.invoke('get-pallet-render-data', { operator_name: operatorName ?? '' });
        if (!data) { setAlert(t('pallet.errNoOpenPallet')); return; }
        // Printing the pallet sheet closes the pallet — all boxes must be closed first.
        if (data.hasOpenBox) { setAlert(t('pallet.errOpenBox')); return; }
        if (!Array.isArray(data.items) || data.items.length === 0) { setAlert(t('pallet.errEmptyPallet')); return; }

        // 3. Print to the pallet printer (role-agnostic print-label IPC).
        const printed = await window.electron.invoke('print-label', {
            silent: true,
            labelDoc: palletDoc,
            data,
            printerConfig: palletPrinter,
        });
        if (printed === false) { setAlert(t('pallet.errPrintFailed')); return; }

        // 4. The sheet is physically printed now. Closing the pallet is bookkeeping — a close
        //    failure must NEVER be reported as a print failure, or the user reprints and we get
        //    a duplicate pallet sheet. So swallow/ log any close error and still report success.
        try {
            const closeRes: any = await window.electron.invoke('close-pallet');
            if (!closeRes?.success) console.warn('close-pallet did not close a pallet', closeRes);
        } catch (closeErr) {
            console.error('close-pallet failed after a successful print', closeErr);
        }
        setAlert(t('pallet.printSent'));
    } catch (err) {
        setAlert(`${t('ws.errorPrefix')}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
        if (busyRef) busyRef.current = false;
    }
}
