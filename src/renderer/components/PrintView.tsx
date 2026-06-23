import { useEffect, useState } from 'react';
import LabelRenderer from './LabelRenderer';

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
        if (printData) {
            // Double RAF ensures the browser has painted the barcode and text
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    window.electron.send('ready-to-print', {});
                });
            });
        }
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
