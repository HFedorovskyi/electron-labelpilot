import { useEffect, useState } from 'react';
import LabelRenderer from './LabelRenderer';

// Warm the bwip-js chunk as soon as the print worker window boots. Barcode elements
// lazy-import it, and on a cold worker the chunk fetch + parse would otherwise start
// only when print-data arrives — pure added latency before the first label.
if (typeof window !== 'undefined' && window.location.search.includes('print=true')) {
    import('bwip-js').catch(() => { /* barcode elements will retry and log */ });
}

const PrintView = () => {
    const [printData, setPrintData] = useState<{ labelDoc: any; data: any } | null>(null);

    useEffect(() => {
        const removeListener = window.electron.on('print-data', (data: any) => {
            console.log('PrintView: Received data', data);
            setPrintData(data);
        });

        return () => removeListener();
    }, []);

    useEffect(() => {
        if (!printData) return;
        let cancelled = false;
        const startedAt = Date.now();
        const MAX_WAIT_MS = 5000; // the main process keeps its own 15s backstop

        // Wait until every barcode canvas finished its async render (bwip-js is lazy-
        // loaded — a bare double RAF raced the chunk load on a cold worker window and
        // could capture blank barcodes), then give the browser two frames to paint.
        const check = () => {
            if (cancelled) return;
            const pending = (window as any).__pendingBarcodes || 0;
            if (pending > 0 && Date.now() - startedAt < MAX_WAIT_MS) {
                setTimeout(check, 16);
                return;
            }
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    if (!cancelled) window.electron.send('ready-to-print', {});
                });
            });
        };
        check();
        return () => { cancelled = true; };
    }, [printData]);

    if (!printData) return <div style={{ color: 'black' }}>Waiting for print data...</div>;

    const { labelDoc } = printData;
    const cv = labelDoc.canvas || {};
    const dpi = cv.dpi || 203;
    // Physical size: prefer explicit mm, then cm, then derive from canvas px at the label's
    // OWN dpi (NOT 96) — canvas.width was computed at 203 dpi, so the old `px/3.78` fallback
    // wildly overestimated the page (e.g. 313mm instead of 148mm) and spilled onto a 2nd page.
    const widthMm = Number(labelDoc.widthMm) || (cv.widthCm ? cv.widthCm * 10 : (cv.width / dpi) * 25.4);
    const heightMm = Number(labelDoc.heightMm) || (cv.heightCm ? cv.heightCm * 10 : (cv.height / dpi) * 25.4);
    // The label is rendered at cv.width CSS px; scale it so it occupies exactly widthMm at
    // 96 CSS dpi → content matches the page → correct size and no trailing blank page.
    const pxPerMm = 96 / 25.4;
    const scale = cv.width > 0 ? (widthMm * pxPerMm) / cv.width : 1;

    return (
        <>
            <style>
                {`
                    @page {
                        size: ${widthMm}mm ${heightMm}mm;
                        margin: 0;
                    }
                    html, body {
                        margin: 0;
                        padding: 0;
                        background: white;
                    }
                    .label-container {
                        box-shadow: none !important;
                        border: none !important;
                    }
                `}
            </style>
            <div style={{ width: `${widthMm}mm`, height: `${heightMm}mm`, overflow: 'hidden', background: 'white' }}>
                <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}>
                    <LabelRenderer doc={printData.labelDoc} data={printData.data} />
                </div>
            </div>
        </>
    );
};

export default PrintView;
