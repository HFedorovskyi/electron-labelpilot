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
            // Give it a moment to render (barcodes especially)
            const timer = setTimeout(() => {
                window.electron.send('ready-to-print', {});
            }, 500);
            return () => clearTimeout(timer);
        }
    }, [printData]);

    if (!printData) return <div style={{ color: 'black' }}>Waiting for print data...</div>;

    return (
        <div style={{ background: 'white', display: 'inline-block' }}>
            <LabelRenderer doc={printData.labelDoc} data={printData.data} />
        </div>
    );
};

export default PrintView;
