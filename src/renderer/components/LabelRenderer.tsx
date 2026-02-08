import { useRef, useEffect } from 'react';
import JsBarcode from 'jsbarcode';

interface LabelRendererProps {
    doc: any; // LabelDoc
    data: Record<string, any>;
    preview?: boolean;
}

const LabelRenderer = ({ doc, data, preview = false }: LabelRendererProps) => {
    if (!doc) return null;

    const { canvas, elements } = doc;
    const zoom = preview ? 0.5 : 1; // Basic zoom for preview, but we might want it responsive

    const processText = (text: string) => {
        return text.replace(/{{\s*([^{}]+)\s*}}/g, (match, key) => {
            const trimmedKey = key.trim();
            return data[trimmedKey] !== undefined ? String(data[trimmedKey]) : match;
        });
    };

    return (
        <div
            style={{
                width: `${canvas.width}px`,
                height: `${canvas.height}px`,
                position: 'relative',
                background: canvas.background,
                overflow: 'hidden',
                boxShadow: preview ? '0 10px 30px rgba(0,0,0,0.3)' : 'none',
                border: preview ? '1px solid rgba(255,255,255,0.1)' : 'none',
                transformOrigin: 'top left',
                transform: preview ? `scale(${zoom})` : 'none',
                margin: preview ? 'auto' : '0',
            }}
            className="label-container"
        >
            {elements.map((el: any) => (
                <LabelElement key={el.id} el={el} processText={processText} />
            ))}
        </div>
    );
};

const LabelElement = ({ el, processText }: { el: any; processText: (t: string) => string }) => {
    const commonStyle: React.CSSProperties = {
        position: 'absolute',
        left: `${el.x}px`,
        top: `${el.y}px`,
        width: `${el.w}px`,
        height: `${el.h}px`,
        transform: `rotate(${el.rotation}deg)`,
        transformOrigin: 'center center',
    };

    if (el.type === 'text') {
        return (
            <div
                style={{
                    ...commonStyle,
                    fontSize: `${el.fontSize}px`,
                    color: el.color,
                    fontWeight: el.fontWeight,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'flex-start',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                }}
            >
                {processText(el.text)}
            </div>
        );
    }

    if (el.type === 'rect') {
        return (
            <div
                style={{
                    ...commonStyle,
                    backgroundColor: el.fill === 'transparent' ? 'transparent' : el.fill,
                    border: el.borderWidth > 0 ? `${el.borderWidth}px solid ${el.borderColor}` : 'none',
                    borderRadius: `${el.borderRadius}px`,
                }}
            />
        );
    }

    if (el.type === 'barcode') {
        return <BarcodeElement el={el} processText={processText} style={commonStyle} />;
    }

    return null;
};

const BarcodeElement = ({ el, processText, style }: { el: any; processText: (t: string) => string; style: React.CSSProperties }) => {
    const svgRef = useRef<SVGSVGElement>(null);

    useEffect(() => {
        if (svgRef.current) {
            try {
                const processedValue = processText(el.value);
                console.log(`Rendering barcode: "${processedValue}" (type: ${el.barcodeType})`);

                if (!processedValue || processedValue === el.value && el.value.includes('{{')) {
                    console.warn('Barcode value still contains placeholders or is empty:', processedValue);
                }

                JsBarcode(svgRef.current, processedValue, {
                    format: el.barcodeType || 'CODE128',
                    width: 2,
                    height: el.h * 0.8,
                    displayValue: el.showText,
                    margin: 0,
                    flat: true,
                    // fontOptions: "bold",
                    valid: (valid) => {
                        if (!valid) console.error('Barcode is invalid for format', el.barcodeType);
                    }
                });
            } catch (err) {
                console.error('Barcode Rendering Error:', err);
            }
        }
    }, [el, processText]);

    return (
        <div style={{ ...style, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
            <svg ref={svgRef} style={{ maxWidth: '100%', maxHeight: '100%' }} />
        </div>
    );
};

export default LabelRenderer;
