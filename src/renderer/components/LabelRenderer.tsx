import { useRef, useEffect } from 'react';
import { normalizeBarcodeType } from '../../shared/barcodeTypes';

// Resolve a {{key}} cell against one table row.
const resolveCell = (text: string, row: Record<string, any>): string =>
    text.replace(/{{\s*([^{}]+)\s*}}/g, (_m, k) => {
        const key = String(k).trim();
        return row[key] !== undefined ? String(row[key]) : '';
    });

// Word-wrap with hard char-split for over-long words.
const wrapTableText = (ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] => {
    if (!text) return [];
    const out: string[] = [];
    for (const para of String(text).split('\n')) {
        let line = '';
        for (const word of para.split(' ')) {
            if (ctx.measureText(word).width > maxWidth) {
                if (line) { out.push(line); line = ''; }
                let chunk = '';
                for (const ch of word) {
                    if (ctx.measureText(chunk + ch).width > maxWidth && chunk) { out.push(chunk); chunk = ch; }
                    else chunk += ch;
                }
                line = chunk;
                continue;
            }
            const test = line ? line + ' ' + word : word;
            if (ctx.measureText(test).width > maxWidth && line) { out.push(line); line = word; }
            else line = test;
        }
        if (line) out.push(line);
    }
    return out;
};

// Canonical pallet table renderer (Canvas 2D). Draws at the canvas origin (0,0); the caller
// positions the canvas at el.x/el.y. Mirrors the server's drawTable so the printed PDF
// matches the web designer preview (full-colour, so keep the reference grays).
const drawPalletTable = (ctx: CanvasRenderingContext2D, el: any, data: Record<string, any>): void => {
    const w = el.w || 0;
    const h = el.h || 0;
    const columns = el.columns || [];
    const fontSize = el.fontSize || 10;
    const showHeaders = el.showHeaders !== false;
    const showBorders = el.showBorders !== false;
    const fontFamily = el.fontFamily || 'Inter';
    const italic = el.fontStyle === 'italic' ? 'italic ' : '';
    const padding = 4;
    const rowHeight = fontSize * 1.5;
    const lineH = fontSize * 1.1;
    const headerFont = `bold ${fontSize}px ${fontFamily}`;
    const bodyFont = `${italic}${fontSize}px ${fontFamily}`;

    let headerHeight = showHeaders ? rowHeight : 0;
    const headerLines: string[][] = [];
    if (showHeaders) {
        ctx.font = headerFont;
        let maxHeaderLines = 1;
        for (const col of columns) {
            const colWidth = (w * col.widthRatio) / 100;
            const lines = wrapTableText(ctx, col.title, colWidth - padding * 2);
            headerLines.push(lines);
            maxHeaderLines = Math.max(maxHeaderLines, lines.length);
        }
        headerHeight = Math.max(rowHeight, maxHeaderLines * lineH + padding * 2);
        ctx.fillStyle = '#f5f5f5';
        ctx.fillRect(0, 0, w, headerHeight);
        ctx.font = headerFont;
        ctx.fillStyle = '#000000';
        ctx.textBaseline = 'top';
        let cx = 0;
        columns.forEach((col: any, ci: number) => {
            const colWidth = (w * col.widthRatio) / 100;
            headerLines[ci].forEach((line, li) => ctx.fillText(line, cx + padding, padding + li * lineH, colWidth - padding * 2));
            cx += colWidth;
        });
    }

    if (showBorders) {
        ctx.strokeStyle = '#cccccc';
        ctx.lineWidth = 1;
        ctx.strokeRect(0, 0, w, h);
        if (showHeaders) { ctx.beginPath(); ctx.moveTo(0, headerHeight); ctx.lineTo(w, headerHeight); ctx.stroke(); }
        let cx = 0;
        columns.forEach((col: any, idx: number) => {
            if (idx < columns.length - 1) { cx += (w * col.widthRatio) / 100; ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke(); }
        });
    }

    let items: any[] = Array.isArray(data.items) ? [...data.items] : [];
    if (el.sortBy === 'name') items.sort((a, b) => String(a?.name ?? '').localeCompare(String(b?.name ?? ''), 'ru'));
    else if (el.sortBy === 'date') items.sort((a, b) => String(a?.production_date_batch ?? '').localeCompare(String(b?.production_date_batch ?? '')));
    if (el.maxRows && el.maxRows > 0) items = items.slice(0, el.maxRows);

    const totalCount = items.length;
    let drawnCount = 0;
    const footerH = Math.round(rowHeight * 3.0);
    const bodyLimit = h - footerH;
    let currentY = headerHeight;

    const drawDataRow = (item: any): boolean => {
        ctx.font = bodyFont;
        ctx.fillStyle = '#000000';
        ctx.textBaseline = 'top';
        let maxLines = 1;
        const colLines: string[][] = [];
        for (const col of columns) {
            const colWidth = (w * col.widthRatio) / 100;
            const val = resolveCell(`{{${col.key}}}`, item);
            const lines = wrapTableText(ctx, val, colWidth - padding * 2);
            colLines.push(lines);
            maxLines = Math.max(maxLines, lines.length);
        }
        const rh = Math.max(rowHeight, maxLines * lineH + padding * 2);
        if (currentY + rh > bodyLimit) return false;
        let cx = 0;
        columns.forEach((col: any, ci: number) => {
            const colWidth = (w * col.widthRatio) / 100;
            colLines[ci].forEach((line, li) => ctx.fillText(line, cx + padding, currentY + padding + li * lineH, colWidth - padding * 2));
            cx += colWidth;
        });
        if (showBorders) { ctx.strokeStyle = '#cccccc'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, currentY + rh); ctx.lineTo(w, currentY + rh); ctx.stroke(); }
        currentY += rh; drawnCount++; return true;
    };

    const drawGroupHeader = (label: string): boolean => {
        if (currentY + rowHeight > bodyLimit) return false;
        ctx.fillStyle = '#e6e6e6'; ctx.fillRect(0, currentY, w, rowHeight);
        ctx.font = headerFont; ctx.fillStyle = '#000000'; ctx.textBaseline = 'middle';
        ctx.fillText(label, padding, currentY + rowHeight / 2, w - padding * 2);
        if (showBorders) { ctx.strokeStyle = '#cccccc'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, currentY + rowHeight); ctx.lineTo(w, currentY + rowHeight); ctx.stroke(); }
        currentY += rowHeight; return true;
    };

    if (el.groupBy === 'nomenclature' || el.groupBy === 'batch') {
        const groupField = el.groupBy === 'batch' ? 'batch_number' : 'name';
        const order: string[] = [];
        const groups: Record<string, any[]> = {};
        for (const it of items) { const k = String(it?.[groupField] ?? '—'); if (!(k in groups)) { groups[k] = []; order.push(k); } groups[k].push(it); }
        for (const k of order) {
            const gi = groups[k]; const first = gi[0] || {};
            let label: string;
            if (el.groupBy === 'batch') {
                const prod = first.production_date_batch ? ` · Произв.: ${first.production_date_batch}` : '';
                const exp = first.exp_date_full ? ` · Годен до: ${first.exp_date_full}` : '';
                label = `Партия ${k}${prod}${exp}`;
            } else label = String(k);
            if (!drawGroupHeader(label)) break;
            let stop = false;
            for (const it of gi) { if (!drawDataRow(it)) { stop = true; break; } }
            if (stop) break;
        }
    } else {
        for (const it of items) { if (!drawDataRow(it)) break; }
    }

    if (totalCount > 0) {
        const truncated = drawnCount < totalCount;
        const pages = truncated ? Math.max(2, Math.ceil(totalCount / Math.max(1, drawnCount))) : 1;
        const fy = h - footerH;
        ctx.fillStyle = '#ededed'; ctx.fillRect(0, fy, w, footerH);
        ctx.strokeStyle = '#999999'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, fy); ctx.lineTo(w, fy); ctx.stroke();
        ctx.font = `bold ${Math.max(13, Math.round(fontSize * 1.8))}px ${fontFamily}`;
        ctx.fillStyle = '#000000'; ctx.textBaseline = 'middle';
        const txt = truncated
            ? `Стр. 1 / ${pages}   ·   показано ${drawnCount} из ${totalCount} позиций`
            : `Стр. 1 / 1   ·   всего ${totalCount} позиций`;
        ctx.fillText(txt, padding * 2, fy + footerH / 2, w - padding * 4);
    }
};

const TableElement = ({ el, data }: { el: any; data: Record<string, any> }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const w = Math.max(1, Math.round(el.w || 0));
        const h = Math.max(1, Math.round(el.h || 0));
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, w, h);
        drawPalletTable(ctx, el, data);
    }, [el, data]);
    return (
        <canvas
            ref={canvasRef}
            style={{
                position: 'absolute',
                left: `${el.x}px`,
                top: `${el.y}px`,
                width: `${el.w}px`,
                height: `${el.h}px`,
                transform: `rotate(${el.rotation || 0}deg)`,
                transformOrigin: 'center center',
            }}
        />
    );
};

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
            {elements.map((el: any) => el.type === 'table'
                ? <TableElement key={el.id} el={el} data={data} />
                : <LabelElement key={el.id} el={el} processText={processText} />
            )}
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
        console.log(`[LabelRenderer] Rendering text element ${el.id} at (${el.x}, ${el.y}) w=${el.w} h=${el.h}. Text: "${(processText(el.text) || '').substring(0, 30)}..."`);
        const processedText = processText(el.text);

        // In flexDirection: 'column':
        //   justifyContent = controls vertical axis (top/center/bottom of block)
        //   alignItems     = controls horizontal axis (not needed — textAlign handles text direction)
        const getVerticalJustify = (vAlign: string) => {
            if (vAlign === 'middle') return 'center';
            if (vAlign === 'bottom') return 'flex-end';
            return 'flex-start'; // 'top'
        };

        return (
            <div
                style={{
                    ...commonStyle,
                    height: `${el.h}px`, // Fixed height needed for vertical centering
                    fontFamily: el.fontFamily || 'Inter, sans-serif',
                    fontSize: `${el.fontSize}px`,
                    color: el.color || '#000000',
                    fontWeight: el.fontWeight || 400,
                    fontStyle: el.fontStyle || 'normal',
                    textAlign: el.textAlign || 'left', // handles horizontal text align
                    textDecoration: el.textDecoration || 'none',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: getVerticalJustify(el.verticalAlign || 'middle'), // vertical
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
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
        if (!canvasRef.current) return;
        let cancelled = false;

        const rawValue = el.value || '';
        const processedValue = processText(rawValue);
        if (!processedValue || (processedValue === rawValue && rawValue.includes('{{'))) {
            return; // value empty or still has unresolved placeholders
        }

        // Shared with the print path (CanvasBitmapGenerator) so preview and printed
        // label resolve a template's barcodeType identically.
        const bcid = normalizeBarcodeType(el.barcodeType);

        // bwip-js is the heaviest renderer dependency and is ONLY needed here (preview /
        // browser-print). Load it lazily so it isn't bundled into the main app chunk.
        // The pending counter lets PrintView hold 'ready-to-print' until every barcode
        // has actually drawn — a bare double-RAF raced this async chunk load on a cold
        // worker window and could capture the page with blank barcodes.
        (window as any).__pendingBarcodes = ((window as any).__pendingBarcodes || 0) + 1;
        (async () => {
            try {
            let bwipjs: any;
            try {
                bwipjs = (await import('bwip-js')).default;
            } catch (e) {
                console.error('Failed to load bwip-js', e);
                return;
            }
            if (cancelled || !canvasRef.current) return;

            const render = (targetBcid: string, text: string, parseGS1: boolean) => {
                if (!canvasRef.current) return;
                const options: any = {
                    bcid: targetBcid,
                    text,
                    scale: 2,
                    includetext: !!el.showText,
                    textxalign: 'center',
                    parse: parseGS1,
                };
                if (!(targetBcid.includes('qr') || targetBcid.includes('matrix'))) {
                    options.height = 15;
                }
                bwipjs.toCanvas(canvasRef.current, options);
            };

            const isGS1 = bcid.startsWith('gs1') || bcid === 'ean13' || bcid === 'ean8' || processedValue.includes('(');
            try {
                render(bcid, processedValue, isGS1);
            } catch (firstErr) {
                // Progressive fallback (mirrors the main-process raster fallback chain).
                let fallbackBcid = 'qrcode';
                if (bcid.includes('matrix')) fallbackBcid = 'datamatrix';
                else if (bcid === 'ean13' || bcid === 'ean8') fallbackBcid = 'code128';
                const cleanValue = processedValue.replace(/[()]/g, '');
                try {
                    render(fallbackBcid, cleanValue, false);
                } catch {
                    try { render('code128', cleanValue, false); } catch (e) { console.error('Barcode render failed', e); }
                }
            }
            } finally {
                (window as any).__pendingBarcodes = Math.max(0, ((window as any).__pendingBarcodes || 1) - 1);
            }
        })();

        return () => { cancelled = true; };
    }, [el, processText]);

    return (
        <div style={{ ...style, display: 'flex', justifyContent: 'center', alignItems: 'center', overflow: 'hidden' }}>
            <canvas ref={canvasRef} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        </div>
    );
};

export default LabelRenderer;
