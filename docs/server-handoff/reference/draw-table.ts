// CANONICAL rendering algorithm — copied from the server's frontend/lib/label/renderer.ts.
// Port `drawTable` into the client's CanvasBitmapGenerator. It uses ONLY the standard
// Canvas 2D API, so it runs unchanged on @napi-rs/canvas (just pass that ctx).
//
// The client already has equivalents of drawText / drawRect / drawBarcode and a
// `processText` placeholder resolver — `processDynamicText` below is the same idea and
// is included so the per-row table-cell resolution matches exactly.

import { TableElement } from "./label-types";

/** Resolve {{key}} placeholders against `data`. For table cells, pass a single ROW as `data`. */
export function processDynamicText(
    text: string,
    data: Record<string, any>,
    opts?: { minLength?: number }
): string {
    return text.replace(/{{\s*([^{}]+)\s*}}/g, (match, key) => {
        const trimmedKey = key.trim();
        let value = data[trimmedKey] !== undefined ? String(data[trimmedKey]) : match;

        if (trimmedKey === "pack_number" || trimmedKey === "box_number") {
            if (/^\d+$/.test(value)) value = value.padStart(12, "0");
        } else if (
            opts?.minLength &&
            (trimmedKey === "pallet_number" || trimmedKey === "pack_counter") &&
            /^\d+$/.test(value)
        ) {
            value = value.padStart(opts.minLength, "0");
        }
        return value;
    });
}

/** Word-wrap with hard char-splitting for over-long words. */
export function wrapText(
    ctx: CanvasRenderingContext2D,
    text: string,
    maxWidth: number
): string[] {
    if (!text) return [];
    const paragraphs = String(text).split("\n");
    const allLines: string[] = [];

    for (const para of paragraphs) {
        const words = para.split(" ");
        let currentLine = "";

        for (const word of words) {
            if (ctx.measureText(word).width > maxWidth) {
                if (currentLine) { allLines.push(currentLine); currentLine = ""; }
                let charLine = "";
                for (const char of word) {
                    if (ctx.measureText(charLine + char).width > maxWidth) {
                        allLines.push(charLine);
                        charLine = char;
                    } else {
                        charLine += char;
                    }
                }
                currentLine = charLine;
                continue;
            }
            const testLine = currentLine ? currentLine + " " + word : word;
            if (ctx.measureText(testLine).width > maxWidth && currentLine) {
                allLines.push(currentLine);
                currentLine = word;
            } else {
                currentLine = testLine;
            }
        }
        if (currentLine) allLines.push(currentLine);
    }
    return allLines;
}

/**
 * Draw a pallet table. Rows come from `previewData.items` (array of row objects).
 * Supports: wrapped column headers, sort, group-by (batch/nomenclature) with group
 * header bands carrying shared batch dates, per-cell wrap, maxRows, and an always-on
 * page/total footer band ("Стр. 1/N · показано X из Y").
 *
 * Coordinates are local — the caller must `ctx.translate(el.x, el.y)` first OR you can
 * keep the internal `ctx.translate` below (it already does it). Keep ONE of them.
 */
export function drawTable(
    ctx: CanvasRenderingContext2D,
    el: TableElement,
    previewData: Record<string, any>
) {
    const { x, y, w, h, columns, fontSize, showHeaders, showBorders, fontFamily, fontStyle } = el;

    ctx.save();
    ctx.translate(x, y);

    const rowHeight = fontSize * 1.5;
    const padding = 4;
    const lineH = fontSize * 1.1;

    // --- Header (wrapped multi-line titles) ---
    let headerHeight = showHeaders ? rowHeight : 0;
    const headerLines: string[][] = [];
    if (showHeaders) {
        ctx.font = `bold ${fontSize}px ${fontFamily || "Inter"}`;
        let maxHeaderLines = 1;
        columns.forEach((col) => {
            const colWidth = (w * col.widthRatio) / 100;
            const lines = wrapText(ctx, col.title, colWidth - padding * 2);
            headerLines.push(lines);
            maxHeaderLines = Math.max(maxHeaderLines, lines.length);
        });
        headerHeight = Math.max(rowHeight, maxHeaderLines * lineH + padding * 2);
    }

    if (showHeaders) {
        ctx.fillStyle = "#f8fafc";
        ctx.fillRect(0, 0, w, headerHeight);
        ctx.font = `bold ${fontSize}px ${fontFamily || "Inter"}`;
        ctx.fillStyle = "#000000";
        ctx.textBaseline = "top";
        let currentX = 0;
        columns.forEach((col, ci) => {
            const colWidth = (w * col.widthRatio) / 100;
            headerLines[ci].forEach((line, li) => {
                ctx.fillText(line, currentX + padding, padding + li * lineH, colWidth - padding * 2);
            });
            currentX += colWidth;
        });
    }

    // --- Borders ---
    if (showBorders) {
        ctx.strokeStyle = "#cbd5e1";
        ctx.lineWidth = 1;
        ctx.strokeRect(0, 0, w, h);
        if (showHeaders) {
            ctx.beginPath();
            ctx.moveTo(0, headerHeight);
            ctx.lineTo(w, headerHeight);
            ctx.stroke();
        }
        let currentX = 0;
        columns.forEach((col, idx) => {
            if (idx < columns.length - 1) {
                currentX += (w * col.widthRatio) / 100;
                ctx.beginPath();
                ctx.moveTo(currentX, 0);
                ctx.lineTo(currentX, h);
                ctx.stroke();
            }
        });
    }

    // --- Rows: collect, sort, group, draw ---
    let items: any[] = Array.isArray(previewData.items) ? [...previewData.items] : [previewData];

    if (el.sortBy === "name") {
        items.sort((a, b) => String(a?.name ?? "").localeCompare(String(b?.name ?? ""), "ru"));
    } else if (el.sortBy === "date") {
        items.sort((a, b) => String(a?.production_date_batch ?? "").localeCompare(String(b?.production_date_batch ?? "")));
    }

    if (el.maxRows && el.maxRows > 0) {
        items = items.slice(0, el.maxRows);
    }

    const totalCount = items.length;
    let drawnCount = 0;
    const footerH = Math.round(rowHeight * 3.0);
    const bodyLimit = h - footerH;

    let currentY = headerHeight;

    const drawDataRow = (item: any): boolean => {
        ctx.font = `${fontStyle === "italic" ? "italic " : ""}${fontSize}px ${fontFamily || "Inter"}`;
        ctx.fillStyle = "#000000";
        ctx.textBaseline = "top";

        let maxLines = 1;
        const colLines: string[][] = [];
        columns.forEach((col) => {
            const colWidth = (w * col.widthRatio) / 100;
            const val = String(processDynamicText(`{{ ${col.key} }}`, item));
            const lines = wrapText(ctx, val, colWidth - padding * 2);
            colLines.push(lines);
            maxLines = Math.max(maxLines, lines.length);
        });

        const currentRowHeight = Math.max(rowHeight, maxLines * (fontSize * 1.1) + padding * 2);
        if (currentY + currentRowHeight > bodyLimit) return false;

        let currentX = 0;
        columns.forEach((col, colIdx) => {
            const colWidth = (w * col.widthRatio) / 100;
            colLines[colIdx].forEach((line, lineIdx) => {
                const lineY = currentY + padding + lineIdx * (fontSize * 1.1);
                ctx.fillText(line, currentX + padding, lineY, colWidth - padding * 2);
            });
            currentX += colWidth;
        });

        if (showBorders) {
            ctx.strokeStyle = "#cbd5e1";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, currentY + currentRowHeight);
            ctx.lineTo(w, currentY + currentRowHeight);
            ctx.stroke();
        }
        currentY += currentRowHeight;
        drawnCount++;
        return true;
    };

    const drawGroupHeader = (label: string): boolean => {
        if (currentY + rowHeight > bodyLimit) return false;
        ctx.fillStyle = "#e8edf3";
        ctx.fillRect(0, currentY, w, rowHeight);
        ctx.font = `bold ${fontSize}px ${fontFamily || "Inter"}`;
        ctx.fillStyle = "#0f172a";
        ctx.textBaseline = "middle";
        ctx.fillText(label, padding, currentY + rowHeight / 2, w - padding * 2);
        if (showBorders) {
            ctx.strokeStyle = "#cbd5e1";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, currentY + rowHeight);
            ctx.lineTo(w, currentY + rowHeight);
            ctx.stroke();
        }
        currentY += rowHeight;
        return true;
    };

    if (el.groupBy === "nomenclature" || el.groupBy === "batch") {
        const groupField = el.groupBy === "batch" ? "batch_number" : "name";
        const order: string[] = [];
        const groups: Record<string, any[]> = {};
        items.forEach((it) => {
            const k = String(it?.[groupField] ?? "—");
            if (!(k in groups)) { groups[k] = []; order.push(k); }
            groups[k].push(it);
        });

        for (const k of order) {
            const groupItems = groups[k];
            const first = groupItems[0] || {};
            let label: string;
            if (el.groupBy === "batch") {
                const prod = first.production_date_batch ? ` · Произв.: ${first.production_date_batch}` : "";
                const exp = first.exp_date_full ? ` · Годен до: ${first.exp_date_full}` : "";
                label = `Партия ${k}${prod}${exp}`;
            } else {
                label = String(k);
            }
            if (!drawGroupHeader(label)) break;
            let stop = false;
            for (const item of groupItems) {
                if (!drawDataRow(item)) { stop = true; break; }
            }
            if (stop) break;
        }
    } else {
        for (const item of items) {
            if (!drawDataRow(item)) break;
        }
    }

    // --- Page / total footer (always shown when there are rows) ---
    if (totalCount > 0) {
        const truncated = drawnCount < totalCount;
        const pages = truncated ? Math.max(2, Math.ceil(totalCount / Math.max(1, drawnCount))) : 1;
        const fy = h - footerH;
        ctx.fillStyle = "#e2e8f0";
        ctx.fillRect(0, fy, w, footerH);
        ctx.strokeStyle = "#94a3b8";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, fy);
        ctx.lineTo(w, fy);
        ctx.stroke();
        ctx.font = `bold ${Math.max(13, Math.round(fontSize * 1.8))}px ${fontFamily || "Inter"}`;
        ctx.fillStyle = "#1e293b";
        ctx.textBaseline = "middle";
        const txt = truncated
            ? `Стр. 1 / ${pages}   ·   показано ${drawnCount} из ${totalCount} позиций`
            : `Стр. 1 / 1   ·   всего ${totalCount} позиций`;
        ctx.fillText(txt, padding * 2, fy + footerH / 2, w - padding * 4);
    }

    ctx.restore();
}
