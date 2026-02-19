import { useRef, useEffect } from 'react';
import bwipjs from 'bwip-js';

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
        if (!text) return '';

        // Prepare lowercase data map
        const lowerData: Record<string, any> = {};
        for (const [key, val] of Object.entries(data)) {
            lowerData[key.toLowerCase()] = val;
        }

        return text.replace(/{{\s*([^{}]+)\s*}}/g, (match, key) => {
            const trimmedKey = key.trim();
            const lowerK = trimmedKey.toLowerCase();

            if (data[trimmedKey] !== undefined) return String(data[trimmedKey]);
            if (lowerData[lowerK] !== undefined) return String(lowerData[lowerK]);

            return match;
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
        const getJustifyContent = (align: string) => {
            if (align === 'center') return 'center';
            if (align === 'right') return 'flex-end';
            return 'flex-start';
        };

        console.log(`[LabelRenderer] Rendering text element ${el.id} at (${el.x}, ${el.y}) w=${el.w} h=${el.h}. Text: "${(processText(el.text) || '').substring(0, 30)}..."`);
        const processedText = processText(el.text);

        return (
            <div
                style={{
                    ...commonStyle,
                    height: 'auto', // Allow it to grow
                    minHeight: `${el.h}px`,
                    fontFamily: el.fontFamily || 'Inter, sans-serif',
                    fontSize: `${el.fontSize}px`,
                    color: el.color || '#000000',
                    fontWeight: el.fontWeight || 400,
                    fontStyle: el.fontStyle || 'normal',
                    textAlign: el.textAlign || 'left',
                    textDecoration: el.textDecoration || 'none',
                    display: 'flex',
                    alignItems: 'flex-start', // Top alignment is safer for overflow
                    justifyContent: getJustifyContent(el.textAlign),
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    // Explicitly set tight line-height for label accuracy
                    lineHeight: '1.2',
                    overflow: 'visible',
                }}
            >
                {processedText}
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
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        if (canvasRef.current) {
            let processedValue = '';
            let rawValue = '';
            let bcid = 'code128';

            try {
                rawValue = el.value || '';
                processedValue = processText(rawValue);

                if (!processedValue || (processedValue === rawValue && rawValue.includes('{{'))) {
                    console.warn('Barcode value empty or still contains placeholders:', processedValue);
                    return;
                }

                const getBwipType = (type: any) => {
                    const t = String(type).toLowerCase();
                    if (t === '21' || t === 'ean13') return 'ean13';
                    if (t === '22' || t === 'ean8') return 'ean8';
                    if (t === '23' || t === 'code128') return 'code128';
                    if (t === 'qr' || t === 'qrcode') return 'qrcode';
                    if (t === 'datamatrix') return 'datamatrix';
                    if (t === 'gs1datamatrix') return 'gs1datamatrix';
                    if (t === 'gs1qr' || t === 'gs1qrcode' || t === 'qrdatabar' || t === 'gs-1') return 'gs1qrcode';
                    if (t === 'gs1databar' || t === 'databar') return 'gs1databarexpandedstacked';
                    return t || 'code128';
                };

                bcid = getBwipType(el.barcodeType);
                const logMsg = `BWIP-JS Rendering Pipeline: RawType="${el.barcodeType}" -> BCID="${bcid}", Value="${processedValue}"`;
                console.log(logMsg);
                (window as any).electron.send('log-to-main', logMsg);

                const render = (targetBcid: string, text: string, parseGS1: boolean) => {
                    if (!canvasRef.current) return;
                    const options: any = {
                        bcid: targetBcid,
                        text: text,
                        scale: 2,
                        includetext: !!el.showText,
                        textxalign: 'center',
                        parse: parseGS1,
                    };

                    // Only add height for 1D barcodes
                    if (!(targetBcid.includes('qr') || targetBcid.includes('matrix'))) {
                        options.height = 15;
                    }

                    bwipjs.toCanvas(canvasRef.current, options);
                };

                const isGS1 = bcid.startsWith('gs1') || bcid === 'ean13' || bcid === 'ean8' || processedValue.includes('(');

                try {
                    render(bcid, processedValue, isGS1);
                } catch (firstErr) {
                    const errMsg = `[Barcode Error] Primary render failed for ${bcid} with value "${processedValue}": ${firstErr instanceof Error ? firstErr.message : String(firstErr)}`;
                    console.error(errMsg, firstErr);
                    (window as any).electron.send('log-to-main', errMsg);

                    console.warn(`Primary render failed for ${bcid}. Trying non-GS1 fallback.`, firstErr);

                    // Progressive Fallbacks
                    let fallbackBcid = 'qrcode';
                    if (bcid.includes('matrix')) fallbackBcid = 'datamatrix';
                    else if (bcid === 'ean13' || bcid === 'ean8') fallbackBcid = 'code128';

                    const cleanValue = processedValue.replace(/[()]/g, '');

                    try {
                        render(fallbackBcid, cleanValue, false);
                    } catch (secondErr) {
                        console.warn(`Secondary fallback ${fallbackBcid} failed. Trying CODE128.`, secondErr);
                        render('code128', cleanValue, false);
                    }
                }

            } catch (err) {
                console.error('Critical Barcode Rendering Error:', err);
            }
        }
    }, [el, processText]);

    return (
        <div style={{ ...style, display: 'flex', justifyContent: 'center', alignItems: 'center', overflow: 'hidden' }}>
            <canvas ref={canvasRef} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        </div>
    );
};

export default LabelRenderer;
