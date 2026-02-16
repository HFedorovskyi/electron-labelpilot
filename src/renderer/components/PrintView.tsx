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
    const widthMm = labelDoc.widthMm || (labelDoc.canvas.width / 3.78).toFixed(1); // fallback to pixels conversion if missing
    const heightMm = labelDoc.heightMm || (labelDoc.canvas.height / 3.78).toFixed(1);

    return (
        <>
            <style>
                {`
                    @page {
                        size: ${widthMm}mm ${heightMm}mm;
                        margin: 0;
                    }
                    body {
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
            <div style={{ background: 'white', display: 'inline-block' }}>
                <LabelRenderer doc={printData.labelDoc} data={printData.data} />
            </div>
        </>
    );
};

export default PrintView;
