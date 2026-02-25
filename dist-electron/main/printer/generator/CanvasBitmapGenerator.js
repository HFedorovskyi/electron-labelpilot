"use strict";
/**
 * CanvasBitmapGenerator — Hybrid ZPL generator.
 *
 * HYBRID APPROACH:
 *   Text + Rects  → rendered on canvas → single ^GFA bitmap (any font, Cyrillic)
 *   Barcodes       → native ZPL commands (pixel-perfect, no extra dependency)
 *
 * Optimizations:
 *   1. Single canvas = single ^GF command (no per-element overhead)
 *   2. ZPL compression reduces hex data by 60-80%
 *   3. Barcodes are native ZPL — compact, accurate, fast
 *   4. Lowered luminance threshold for crisper text on thermal printers
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CanvasBitmapGenerator = void 0;
const logger_1 = __importDefault(require("../../logger"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
const canvas_1 = require("@napi-rs/canvas");
// Register custom fonts
try {
    const isDev = !electron_1.app.isPackaged;
    const resourcesPath = isDev
        ? path_1.default.join(process.cwd(), 'resources', 'fonts')
        : path_1.default.join(process.resourcesPath, 'fonts');
    const fonts = [
        { name: 'Inter', file: 'Inter-Regular.ttf', weight: 'normal' },
        { name: 'Inter', file: 'Inter-Bold.ttf', weight: 'bold' },
        { name: 'Roboto', file: 'Roboto-Variable.ttf', weight: 'normal' },
        { name: 'Roboto', file: 'Roboto-Bold.ttf', weight: 'bold' }, // In case it exists or for fallback
        { name: 'Montserrat', file: 'Montserrat-Variable.ttf', weight: 'normal' },
        { name: 'Montserrat', file: 'Montserrat-Bold.ttf', weight: 'bold' },
        { name: 'Ubuntu', file: 'Ubuntu-Regular.ttf', weight: 'normal' },
        { name: 'Ubuntu', file: 'Ubuntu-Bold.ttf', weight: 'bold' },
        { name: 'Arial', file: 'Arial.ttf', weight: 'normal' },
        { name: 'Arial', file: 'Arial-Bold.ttf', weight: 'bold' },
        { name: 'Times New Roman', file: 'Times-New-Roman.ttf', weight: 'normal' },
        { name: 'Times New Roman', file: 'Times-New-Roman-Bold.ttf', weight: 'bold' },
        { name: 'Courier New', file: 'Courier-New.ttf', weight: 'normal' },
        { name: 'Courier New', file: 'Courier-New-Bold.ttf', weight: 'bold' },
        { name: 'Georgia', file: 'Georgia.ttf', weight: 'normal' },
        { name: 'Georgia', file: 'Georgia-Bold.ttf', weight: 'bold' },
        { name: 'Verdana', file: 'Verdana.ttf', weight: 'normal' },
        { name: 'Verdana', file: 'Verdana-Bold.ttf', weight: 'bold' }
    ];
    const fs = require('fs');
    for (const font of fonts) {
        // Try server_fonts subfolder first for 100% parity
        const serverFontPath = path_1.default.join(resourcesPath, 'server_fonts', font.file);
        const rootFontPath = path_1.default.join(resourcesPath, font.file);
        const finalPath = fs.existsSync(serverFontPath) ? serverFontPath : rootFontPath;
        if (fs.existsSync(finalPath)) {
            // @ts-ignore
            canvas_1.GlobalFonts.registerFromPath(finalPath, font.name);
            logger_1.default.info(`[CanvasBitmapGenerator] Registered font "${font.name}" (${font.weight}) from ${finalPath}`);
        }
        else {
            logger_1.default.warn(`[CanvasBitmapGenerator] Font file not found for "${font.name}": searched in ${serverFontPath} and ${rootFontPath}`);
        }
    }
}
catch (e) {
    logger_1.default.error(`[CanvasBitmapGenerator] Failed to register fonts:`, e);
}
class CanvasBitmapGenerator {
    // Session cache for backgrounds, move to global to ensure persistence across re-instantiations
    static get uploadedBackgrounds() {
        if (!global.zplBackgroundCache) {
            global.zplBackgroundCache = new Set();
        }
        return global.zplBackgroundCache;
    }
    /**
     * Clear the background GRF cache. Call after data sync to ensure
     * updated label templates get fresh backgrounds uploaded to the printer.
     */
    static clearBackgroundCache() {
        const cache = CanvasBitmapGenerator.uploadedBackgrounds;
        const size = cache.size;
        cache.clear();
        logger_1.default.info(`[CanvasBitmapGenerator] Background cache cleared (${size} entries removed)`);
    }
    async generate(doc, data, options) {
        const t0 = Date.now();
        const dpi = options.dpi || doc.dpi || 203;
        const srcDpi = doc.canvas?.dpi || 96;
        // ── Physical dimensions (mm → dots) ──────────────────────────
        let targetWidthMm = doc.widthMm || options.widthMm;
        let targetHeightMm = doc.heightMm || options.heightMm;
        if (!targetWidthMm && doc.canvas?.widthCm)
            targetWidthMm = doc.canvas.widthCm * 10;
        if (!targetHeightMm && doc.canvas?.heightCm)
            targetHeightMm = doc.canvas.heightCm * 10;
        let printWidth;
        let labelLength;
        let scaleX = 1;
        let scaleY = 1;
        if (targetWidthMm) {
            printWidth = Math.round(targetWidthMm * dpi / 25.4);
            // If canvas width is provided, it defines the source coordinate system.
            // If it's missing, we assume elements are in mm and need to be scaled to dots.
            if (doc.canvas.width > 0) {
                scaleX = printWidth / doc.canvas.width;
            }
            else {
                scaleX = dpi / 25.4; // 1mm -> X dots
            }
        }
        else {
            scaleX = dpi / srcDpi;
            printWidth = Math.round(doc.canvas.width * scaleX);
        }
        if (targetHeightMm) {
            labelLength = Math.round(targetHeightMm * dpi / 25.4);
            if (doc.canvas.height > 0) {
                scaleY = labelLength / doc.canvas.height;
            }
            else {
                scaleY = dpi / 25.4;
            }
        }
        else {
            scaleY = scaleX;
            labelLength = Math.round((doc.canvas.height || (doc.canvas.width * 0.5)) * scaleY);
        }
        logger_1.default.info(`[CanvasBitmapGenerator] FULL DATA OBJECT: ${JSON.stringify(data)}`);
        logger_1.default.info(`[CanvasBitmapGenerator] BARCODE FIELDS: barcode="${data.barcode}" article="${data.article}" Код_ШК="${data['Код ШК']}"`);
        const t2 = Date.now();
        const hasVariables = (text) => /\{\{\s*[^{}]+\s*\}\}/.test(text);
        // ── Split elements into static vs dynamic ─────────────────────
        const staticElements = [];
        const dynamicElements = [];
        for (const el of doc.elements) {
            const isDynamic = (el.type === 'text' && hasVariables(el.text || '')) ||
                (el.type === 'barcode' && hasVariables(el.value || el.text || '')) ||
                (el.type === 'barcode'); // Treat all barcodes as dynamic to be safe
            if (isDynamic) {
                dynamicElements.push(el);
            }
            else {
                staticElements.push(el);
            }
        }
        // ── Render Static Layer ──────────────────────────────────────
        const staticCanvas = (0, canvas_1.createCanvas)(printWidth, labelLength);
        const sctx = staticCanvas.getContext('2d');
        sctx.fillStyle = '#FFFFFF';
        sctx.fillRect(0, 0, printWidth, labelLength);
        for (const el of staticElements) {
            sctx.save();
            this.applyRotation(sctx, el, scaleX, scaleY);
            await this.renderElement(sctx, el, data, scaleX, scaleY);
            sctx.restore();
        }
        // Convert static layer to mono and hash it
        const staticImageData = sctx.getImageData(0, 0, printWidth, labelLength);
        const bytesPerRow = Math.ceil(printWidth / 8);
        const totalBytes = bytesPerRow * labelLength;
        const staticMono = this.rgbaToMono(staticImageData.data, printWidth, labelLength, bytesPerRow);
        // Structural hash for background — deterministic regardless of canvas rendering nuances
        const bgHash = this.getStructuralHash(staticElements, printWidth, labelLength);
        const bgName = `R:BG${bgHash.substring(0, 6).toUpperCase()}.GRF`;
        const t3 = Date.now();
        // ── Render Dynamic Elements — Per-Element Clips ──────────────
        // Instead of rendering ALL dynamic text on a full-label canvas (~18KB),
        // each dynamic text element gets its own tiny canvas (just its bounding box).
        // This reduces dynamic payload from ~18KB to ~1-3KB total.
        const barcodeCommands = [];
        const dynamicClipCommands = [];
        for (const el of dynamicElements) {
            if (el.type === 'barcode' && (el.value || el.text)) {
                const barcodeZpl = this.processBarcodeAsZpl(el, data, scaleX, scaleY);
                if (barcodeZpl)
                    barcodeCommands.push(barcodeZpl);
            }
            else if (el.type === 'text') {
                const clipZpl = this.renderDynamicTextClip(el, data, scaleX, scaleY);
                if (clipZpl)
                    dynamicClipCommands.push(clipZpl);
            }
        }
        const t4 = Date.now();
        // ── Build ZPL with Caching ──────────────────────────────────
        let zpl = '';
        // ~DG (Download Graphics) only if background is NOT in session cache
        const staticCompressed = this.compressZplRLE(staticMono, bytesPerRow, labelLength);
        const cacheKey = `${bgName}_${totalBytes}`;
        if (!CanvasBitmapGenerator.uploadedBackgrounds.has(cacheKey)) {
            zpl += `~DG${bgName},${totalBytes},${bytesPerRow},${staticCompressed}\n`;
            CanvasBitmapGenerator.uploadedBackgrounds.add(cacheKey);
            logger_1.default.info(`[CanvasBitmapGenerator] Uploading NEW background to printer: ${bgName} (${staticCompressed.length} chars)`);
        }
        else {
            logger_1.default.info(`[CanvasBitmapGenerator] CACHE HIT — background already in printer: ${bgName}`);
        }
        zpl += '^XA\n';
        zpl += `^PW${printWidth}\n`;
        zpl += `^LL${labelLength}\n`;
        zpl += '^PON\n';
        if (options.darkness !== undefined)
            zpl += `^MD${options.darkness}\n`;
        if (options.printSpeed !== undefined)
            zpl += `^PR${options.printSpeed}\n`;
        // Recall Background
        zpl += `^FO0,0^XG${bgName},1,1^FS\n`;
        // Overlay Per-Element Dynamic Text Clips
        let dynamicClipTotalSize = 0;
        for (const clip of dynamicClipCommands) {
            zpl += clip;
            dynamicClipTotalSize += clip.length;
        }
        // Overlay Native Barcodes
        for (const bc of barcodeCommands) {
            zpl += bc;
        }
        zpl += '^XZ';
        const buf = Buffer.from(zpl, 'utf-8');
        const t5 = Date.now();
        logger_1.default.info(`[CanvasBitmapGenerator] Timing: static=${t3 - t2}ms clips=${t4 - t3}ms zpl=${t5 - t4}ms TOTAL=${t5 - t0}ms`);
        logger_1.default.info(`[CanvasBitmapGenerator] Payload: BG=${staticCompressed.length}chars (cached=${CanvasBitmapGenerator.uploadedBackgrounds.has(cacheKey)}), Clips=${dynamicClipCommands.length}x (${dynamicClipTotalSize}chars), BC=${barcodeCommands.length}, TOTAL=${buf.length}bytes`);
        // ── DEBUG: Dump ZPL to file ──────────────────────────────────
        try {
            const fs = require('fs');
            const debugPath = path_1.default.join(electron_1.app.getPath('logs'), `debug_label_${Date.now()}.zpl`);
            fs.writeFileSync(debugPath, zpl);
            logger_1.default.info(`[CanvasBitmapGenerator] DEBUG: Dumped generated ZPL to ${debugPath}`);
        }
        catch (e) {
            logger_1.default.error(`[CanvasBitmapGenerator] DEBUG: Failed to dump ZPL`, e);
        }
        return buf;
    }
    // ═══════════════════════════════════════════════════════════════════
    //  Variable substitution
    // ═══════════════════════════════════════════════════════════════════
    processText(text, data) {
        if (!text)
            return '';
        // Prepare a lowercase map for case-insensitive lookup
        const lowerData = {};
        for (const [key, val] of Object.entries(data)) {
            lowerData[key.toLowerCase()] = val;
        }
        return text.replace(/\{\{\s*([^{}]+)\s*\}\}/g, (_, key) => {
            const k = key.trim();
            const lowerK = k.toLowerCase();
            // Priority: 
            // 1. Exact match
            // 2. Case-insensitive match
            if (data[k] !== undefined)
                return String(data[k]);
            if (lowerData[lowerK] !== undefined)
                return String(lowerData[lowerK]);
            return `{{${k}}}`;
        });
    }
    // ═══════════════════════════════════════════════════════════════════
    //  Canvas element rendering (text + rect only, NO barcodes)
    // ═══════════════════════════════════════════════════════════════════
    async renderElement(ctx, el, data, scaleX, scaleY) {
        switch (el.type) {
            case 'text':
                this.drawText(ctx, el, data, scaleX, scaleY);
                break;
            case 'rect':
                this.drawRect(ctx, el, scaleX, scaleY);
                break;
            case 'barcode':
                await this.drawBarcodeImage(ctx, el, scaleX, scaleY);
                break;
        }
    }
    // ── TEXT ──────────────────────────────────────────────────────────
    drawText(ctx, el, data, scaleX, scaleY) {
        const text = this.processText(el.text || '', data);
        if (!text)
            return;
        const x = Math.round(el.x * scaleX);
        const y = Math.round(el.y * scaleY);
        const w = el.w ? Math.round(el.w * scaleX) : undefined;
        const h = el.h ? Math.round(el.h * scaleY) : undefined;
        let fontSize = (el.fontSize || 12) * scaleY;
        const fontFamily = el.fontFamily || 'Arial';
        const weight = el.fontWeight ? (typeof el.fontWeight === 'number' && el.fontWeight >= 600 ? 'bold' : (el.fontWeight === 'bold' ? 'bold' : 'normal')) : 'normal';
        const style = el.fontStyle || 'normal';
        ctx.font = `${style} ${weight} ${fontSize}px "${fontFamily}", "Arial", sans-serif`;
        ctx.fillStyle = '#000000';
        ctx.textBaseline = 'top';
        // Alignment
        let textX = x;
        if (el.textAlign === 'center' && w) {
            ctx.textAlign = 'center';
            textX = x + w / 2;
        }
        else if (el.textAlign === 'right' && w) {
            ctx.textAlign = 'right';
            textX = x + w;
        }
        else {
            ctx.textAlign = 'left';
        }
        console.log(`[CanvasBitmapGenerator] Drawing element "${el.id}" at (${x}, ${y}) w=${w} h=${h}. Text: "${text.substring(0, 30)}..."`);
        // Draw at x=0 relative to the translated origin
        ctx.save();
        ctx.translate(textX, y);
        const drawX = 0;
        // maxWidth matches element width exactly — same as browser
        const maxWidth = w ?? 9999;
        const lines = this.wrapText(ctx, text, maxWidth);
        // lineHeight 1.2 matches browser CSS lineHeight in LabelRenderer.tsx
        const lineHeight = fontSize * 1.2;
        const totalTextHeight = lines.length * lineHeight;
        // Vertical alignment within the element box
        // Default is 'middle' — matches the label designer's default behavior
        const verticalAlign = el.verticalAlign || 'middle';
        let startY = 0;
        if (h !== undefined) {
            if (verticalAlign === 'middle') {
                startY = (h - totalTextHeight) / 2;
            }
            else if (verticalAlign === 'bottom') {
                startY = h - totalTextHeight;
            }
            // 'top' → startY = 0 (default)
        }
        for (let i = 0; i < lines.length; i++) {
            const ly = startY + i * lineHeight;
            ctx.fillText(lines[i], drawX, ly);
        }
        ctx.restore();
    }
    wrapText(ctx, text, maxWidth) {
        const paragraphs = text.split("\n");
        const allLines = [];
        for (const para of paragraphs) {
            const words = para.split(" ");
            let currentLine = "";
            for (const word of words) {
                const testLine = currentLine ? currentLine + " " + word : word;
                const metrics = ctx.measureText(testLine);
                if (metrics.width > maxWidth && currentLine) {
                    allLines.push(currentLine);
                    currentLine = word;
                }
                else {
                    currentLine = testLine;
                }
            }
            allLines.push(currentLine);
        }
        return allLines;
    }
    // ── RECT ─────────────────────────────────────────────────────────
    drawRect(ctx, el, scaleX, scaleY) {
        const x = Math.round(el.x * scaleX);
        const y = Math.round(el.y * scaleY);
        const w = Math.round(el.w * scaleX);
        const h = Math.round(el.h * scaleY);
        const borderWidth = Math.round((el.borderWidth || 0) * scaleX);
        const borderRadius = Math.round((el.borderRadius || 0) * scaleX);
        const fill = el.fill;
        const borderColor = el.borderColor || '#000000';
        ctx.beginPath();
        if (borderRadius > 0) {
            const r = Math.min(borderRadius, w / 2, h / 2);
            ctx.moveTo(x + r, y);
            ctx.lineTo(x + w - r, y);
            ctx.quadraticCurveTo(x + w, y, x + w, y + r);
            ctx.lineTo(x + w, y + h - r);
            ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
            ctx.lineTo(x + r, y + h);
            ctx.quadraticCurveTo(x, y + h, x, y + h - r);
            ctx.lineTo(x, y + r);
            ctx.quadraticCurveTo(x, y, x + r, y);
        }
        else {
            ctx.rect(x, y, w, h);
        }
        ctx.closePath();
        if (fill && fill !== "transparent") {
            ctx.fillStyle = fill;
            ctx.fill();
        }
        if (borderWidth > 0) {
            ctx.strokeStyle = borderColor;
            ctx.lineWidth = borderWidth;
            ctx.stroke();
        }
    }
    imageCache = new Map();
    async drawBarcodeImage(ctx, el, scaleX, scaleY) {
        if (!el.imageData)
            return;
        const { loadImage } = require('@napi-rs/canvas');
        const src = `data:image/png;base64,${el.imageData}`;
        try {
            let img = this.imageCache.get(src);
            if (!img) {
                img = await loadImage(src);
                this.imageCache.set(src, img);
            }
            const x = Math.round(el.x * scaleX);
            const y = Math.round(el.y * scaleY);
            const w = Math.round(el.w * scaleX);
            const h = Math.round(el.h * scaleY);
            ctx.drawImage(img, x, y, w, h);
        }
        catch (e) {
            logger_1.default.error(`[CanvasBitmapGenerator] Failed to draw barcode image:`, e);
        }
    }
    // ═══════════════════════════════════════════════════════════════════
    //  BARCODE — Native ZPL commands (from ZplGenerator)
    //  This gives pixel-perfect barcodes without any external library.
    // ═══════════════════════════════════════════════════════════════════
    processBarcodeAsZpl(el, data, scaleX, scaleY) {
        const bcVal = this.processText(el.value || el.text || '', data);
        logger_1.default.info(`[CanvasBitmapGenerator] Barcode resolve: el.value="${el.value}" el.text="${el.text}" -> bcVal="${bcVal}" | data.barcode="${data.barcode}" data.article="${data.article}" data['Код ШК']="${data['Код ШК']}"`);
        if (!bcVal)
            return '';
        const x = Math.round(el.x * scaleX);
        const y = Math.round(el.y * scaleY);
        const width = Math.round(el.w * scaleX);
        const height = Math.round(el.h * scaleY);
        const type = (el.barcodeType || 'code128').toLowerCase();
        /**
         * Module Width (mw) Calculation:
         * EAN-13: 95 modules + room for quiet zones (standard ~115 modules total).
         */
        let moduleWidth = el.moduleWidth || 2;
        if (width > 0) {
            if (type.includes('ean13')) {
                // EAN-13: 95 modules. Since the designer now snaps to 95-module multiples, 
                // we trust the width and use Math.round to get the intended mw.
                const bestMw = Math.round(width / 95);
                if (bestMw > 0)
                    moduleWidth = bestMw;
            }
            else if (type.includes('128')) {
                // Code 128: ~11 modules per char + quiet zones
                const estimatedModules = bcVal.length * 11 + 22;
                const bestMw = Math.floor(width / estimatedModules);
                if (bestMw > 0)
                    moduleWidth = bestMw;
            }
        }
        logger_1.default.info(`[CanvasBitmapGenerator] Barcode "${el.id}" (${type}): ` +
            `box_h=${el.h} -> dots_h=${height}, box_w=${el.w} -> dots_w=${width}, ` +
            `mw=${moduleWidth}, scales=(${scaleX.toFixed(2)},${scaleY.toFixed(2)}), val="${bcVal}"`);
        // Rotation mapping
        let orient = 'N';
        const rot = el.rotation || 0;
        if (rot === 90)
            orient = 'R';
        else if (rot === 180)
            orient = 'I';
        else if (rot === 270)
            orient = 'B';
        let cmd = `^FO${x},${y}`;
        if (type.includes('code128')) {
            const showText = el.showText ? 'Y' : 'N';
            cmd += `^BY${moduleWidth},3.0,${height}`;
            cmd += `^BC${orient},${height},${showText},N,N^FD${bcVal}^FS\n`;
        }
        else if (type.includes('qr') || type === 'gs-1') {
            const mag = el.moduleWidth || Math.max(3, Math.round(scaleX * 2));
            cmd += `^BQ${orient},2,${mag}`;
            cmd += `^FDQA,${bcVal}^FS\n`;
        }
        else if (type.includes('ean13') || type.includes('ean13_kz')) {
            const showText = el.showText ? 'Y' : 'N';
            cmd += `^BY${moduleWidth},3.0,${height}`;
            cmd += `^BE${orient},${height},${showText},N^FD${bcVal}^FS\n`;
        }
        else if (type.includes('datamatrix')) {
            const mag = el.moduleWidth || Math.max(3, Math.round(scaleX * 2));
            cmd += `^BX${orient},${mag},200`;
            cmd += `^FD${bcVal}^FS\n`;
        }
        else {
            const showText = el.showText ? 'Y' : 'N';
            cmd += `^BY${moduleWidth},3.0,${height}`;
            cmd += `^BC${orient},${height},${showText},N,N^FD${bcVal}^FS\n`;
        }
        return cmd;
    }
    // ═══════════════════════════════════════════════════════════════════
    //  Monochrome conversion (improved threshold for thermal printers)
    // ═══════════════════════════════════════════════════════════════════
    rgbaToMono(rgba, width, height, bytesPerRow) {
        const mono = new Uint8Array(bytesPerRow * height);
        for (let row = 0; row < height; row++) {
            const rowOffset = row * bytesPerRow;
            const rgbaRowOffset = row * width * 4;
            for (let col = 0; col < width; col++) {
                const idx = rgbaRowOffset + col * 4;
                // Transparency check: if alpha is low, treat as white (ignore)
                if (rgba[idx + 3] < 128)
                    continue;
                // Fast luminance: (r*77 + g*150 + b*29) >> 8
                const lum = (rgba[idx] * 77 + rgba[idx + 1] * 150 + rgba[idx + 2] * 29) >> 8;
                // Threshold 180 (vs 128) catches antialiased gray pixels from canvas
                // rendering, producing crisper text on thermal printers.
                if (lum <= 180) {
                    mono[rowOffset + (col >> 3)] |= (0x80 >> (col & 7));
                }
            }
        }
        return mono;
    }
    // ═══════════════════════════════════════════════════════════════════
    //  ZPL Compression (Run-Length Encoding for ^GFA)
    // ═══════════════════════════════════════════════════════════════════
    compressZplRLE(mono, bytesPerRow, height) {
        let result = '';
        let prevRowHex = '';
        for (let row = 0; row < height; row++) {
            const offset = row * bytesPerRow;
            const rowBytes = mono.subarray(offset, offset + bytesPerRow);
            // Convert row to hex string
            let rowHex = '';
            for (let i = 0; i < rowBytes.length; i++) {
                rowHex += rowBytes[i].toString(16).padStart(2, '0').toUpperCase();
            }
            // Check special cases
            if (row > 0 && rowHex === prevRowHex) {
                result += ':'; // Same as previous
                continue;
            }
            // Check all zeros (white row)
            if (rowBytes.every(b => b === 0)) {
                result += ',';
                prevRowHex = rowHex;
                continue;
            }
            // Check all ones (black row)
            if (rowBytes.every(b => b === 0xFF)) {
                result += '!';
                prevRowHex = rowHex;
                continue;
            }
            // RLE compress the hex string
            result += this.compressRowRLE(rowHex);
            prevRowHex = rowHex;
        }
        return result;
    }
    compressRowRLE(hex) {
        let result = '';
        let i = 0;
        while (i < hex.length) {
            const ch = hex[i];
            let count = 1;
            while (i + count < hex.length && hex[i + count] === ch) {
                count++;
            }
            if (count >= 2) {
                result += this.encodeRepeatCount(count) + ch;
            }
            else {
                result += ch;
            }
            i += count;
        }
        return result;
    }
    encodeRepeatCount(count) {
        let result = '';
        // High counts: g=20, h=40, ..., z=400
        while (count >= 20) {
            const highMultiple = Math.min(Math.floor(count / 20), 20); // max z=400
            result += String.fromCharCode('f'.charCodeAt(0) + highMultiple); // g=20, h=40, ...
            count -= highMultiple * 20;
        }
        // Low counts: G=1, H=2, ..., Y=19, Z=20
        if (count >= 1) {
            result += String.fromCharCode('F'.charCodeAt(0) + count); // G=1, H=2, ...
        }
        return result;
    }
    applyRotation(ctx, el, scaleX, scaleY) {
        if (el.rotation) {
            const centerX = (el.x + (el.w || 0) / 2) * scaleX;
            const centerY = (el.y + (el.h || 0) / 2) * scaleY;
            ctx.translate(centerX, centerY);
            ctx.rotate((el.rotation * Math.PI) / 180);
            ctx.translate(-centerX, -centerY);
        }
    }
    // ═══════════════════════════════════════════════════════════════════
    //  Per-Element Dynamic Text Clip
    //  Renders a single dynamic text element on a tiny canvas matching
    //  its bounding box, producing a small ^GFA command (~200-500 bytes)
    //  instead of a full-label bitmap (~18KB).
    // ═══════════════════════════════════════════════════════════════════
    renderDynamicTextClip(el, data, scaleX, scaleY) {
        const text = this.processText(el.text || '', data);
        if (!text)
            return '';
        // Element position and size in printer dots
        const x = Math.round(el.x * scaleX);
        const y = Math.round(el.y * scaleY);
        const w = el.w ? Math.round(el.w * scaleX) : 400;
        const h = el.h ? Math.round(el.h * scaleY) : 100;
        if (w <= 0 || h <= 0)
            return '';
        // For rotated elements, calculate expanded bounding box
        const rotation = el.rotation || 0;
        let clipW = w;
        let clipH = h;
        let foX = x;
        let foY = y;
        if (rotation === 90 || rotation === 270) {
            // Swap dimensions for 90/270 rotation
            clipW = h;
            clipH = w;
            // Adjust field origin to account for rotated bounding box
            const cx = x + w / 2;
            const cy = y + h / 2;
            foX = Math.round(cx - clipW / 2);
            foY = Math.round(cy - clipH / 2);
        }
        // Create small canvas just for this element
        const clipCanvas = (0, canvas_1.createCanvas)(clipW, clipH);
        const ctx = clipCanvas.getContext('2d');
        ctx.clearRect(0, 0, clipW, clipH);
        // Apply rotation within the clip canvas
        if (rotation) {
            const cx = clipW / 2;
            const cy = clipH / 2;
            ctx.translate(cx, cy);
            ctx.rotate((rotation * Math.PI) / 180);
            ctx.translate(-cx, -cy);
            // After rotation, draw text in the original (pre-rotation) bounding box
            // centered within the clip canvas
            if (rotation === 90 || rotation === 270) {
                // The text's original w×h is swapped vs clip dimensions
                const offsetX = (clipW - w) / 2;
                const offsetY = (clipH - h) / 2;
                this.drawTextOnClip(ctx, el, text, offsetX, offsetY, w, h);
            }
            else {
                // 180° — same dimensions, just rotated
                this.drawTextOnClip(ctx, el, text, 0, 0, clipW, clipH);
            }
        }
        else {
            // No rotation — straightforward
            this.drawTextOnClip(ctx, el, text, 0, 0, w, h);
        }
        // Convert to mono
        const imageData = ctx.getImageData(0, 0, clipW, clipH);
        const clipBytesPerRow = Math.ceil(clipW / 8);
        const mono = this.rgbaToMono(imageData.data, clipW, clipH, clipBytesPerRow);
        // ── Auto-crop: trim empty rows & columns ──────────────────
        // Find bounding box of actual content within the clip
        let minRow = clipH, maxRow = -1;
        let minCol = clipW, maxCol = -1;
        for (let row = 0; row < clipH; row++) {
            const rowOffset = row * clipBytesPerRow;
            for (let col = 0; col < clipW; col++) {
                if (mono[rowOffset + (col >> 3)] & (0x80 >> (col & 7))) {
                    if (row < minRow)
                        minRow = row;
                    if (row > maxRow)
                        maxRow = row;
                    if (col < minCol)
                        minCol = col;
                    if (col > maxCol)
                        maxCol = col;
                }
            }
        }
        // Skip if empty
        if (maxRow < 0)
            return '';
        // Add 1px padding to avoid edge clipping
        minRow = Math.max(0, minRow - 1);
        maxRow = Math.min(clipH - 1, maxRow + 1);
        minCol = Math.max(0, minCol - 1);
        maxCol = Math.min(clipW - 1, maxCol + 1);
        const cropW = maxCol - minCol + 1;
        const cropH = maxRow - minRow + 1;
        const cropBytesPerRow = Math.ceil(cropW / 8);
        const cropTotalBytes = cropBytesPerRow * cropH;
        // Extract cropped region
        const croppedMono = new Uint8Array(cropTotalBytes);
        for (let r = 0; r < cropH; r++) {
            const srcRow = minRow + r;
            for (let c = 0; c < cropW; c++) {
                const srcCol = minCol + c;
                if (mono[srcRow * clipBytesPerRow + (srcCol >> 3)] & (0x80 >> (srcCol & 7))) {
                    croppedMono[r * cropBytesPerRow + (c >> 3)] |= (0x80 >> (c & 7));
                }
            }
        }
        const compressed = this.compressZplRLE(croppedMono, cropBytesPerRow, cropH);
        const adjustedX = Math.max(0, foX + minCol);
        const adjustedY = Math.max(0, foY + minRow);
        const origBytes = clipBytesPerRow * clipH;
        logger_1.default.info(`[CanvasBitmapGenerator] Clip "${el.id}": ${clipW}x${clipH} (${origBytes}B) -> CROPPED ${cropW}x${cropH} (${cropTotalBytes}B, ${compressed.length}chars) saved ${Math.round((1 - cropTotalBytes / origBytes) * 100)}%`);
        return `^FO${adjustedX},${adjustedY}^GFA,${cropTotalBytes},${cropTotalBytes},${cropBytesPerRow},${compressed}^FS\n`;
    }
    /**
     * Draws text at a given origin within a clip canvas.
     * Reuses the same font/alignment logic as drawText but at arbitrary position.
     */
    drawTextOnClip(ctx, el, text, originX, originY, w, h) {
        // Font setup — use raw pixel sizes (already in printer dots)
        const fontSize = (el.fontSize || 12) * (h / (el.h || h)); // Scale fontSize proportionally
        const fontFamily = el.fontFamily || 'Arial';
        const weight = el.fontWeight
            ? (typeof el.fontWeight === 'number' && el.fontWeight >= 600 ? 'bold'
                : (el.fontWeight === 'bold' ? 'bold' : 'normal'))
            : 'normal';
        const style = el.fontStyle || 'normal';
        ctx.font = `${style} ${weight} ${fontSize}px "${fontFamily}", "Arial", sans-serif`;
        ctx.fillStyle = '#000000';
        ctx.textBaseline = 'top';
        // Alignment
        let textX = originX;
        if (el.textAlign === 'center') {
            ctx.textAlign = 'center';
            textX = originX + w / 2;
        }
        else if (el.textAlign === 'right') {
            ctx.textAlign = 'right';
            textX = originX + w;
        }
        else {
            ctx.textAlign = 'left';
        }
        const lines = this.wrapText(ctx, text, w);
        const lineHeight = fontSize * 1.2;
        const totalTextHeight = lines.length * lineHeight;
        // Vertical alignment
        const verticalAlign = el.verticalAlign || 'middle';
        let startY = originY;
        if (verticalAlign === 'middle') {
            startY = originY + (h - totalTextHeight) / 2;
        }
        else if (verticalAlign === 'bottom') {
            startY = originY + h - totalTextHeight;
        }
        for (let i = 0; i < lines.length; i++) {
            ctx.fillText(lines[i], textX, startY + i * lineHeight);
        }
    }
    // ═══════════════════════════════════════════════════════════════════
    //  Structural Hash — deterministic based on element properties,
    //  not canvas bitmap (which can vary due to floating-point rounding)
    // ═══════════════════════════════════════════════════════════════════
    getStructuralHash(elements, canvasW, canvasH) {
        const crypto = require('crypto');
        const struct = JSON.stringify({
            cw: canvasW, ch: canvasH,
            els: elements.map(e => ({
                t: e.type, x: e.x, y: e.y, w: e.w, h: e.h,
                txt: e.text, fs: e.fontSize, ff: e.fontFamily,
                fw: e.fontWeight, ta: e.textAlign, va: e.verticalAlign,
                f: e.fill, bw: e.borderWidth, bc: e.borderColor,
                br: e.borderRadius, r: e.rotation
            }))
        });
        return crypto.createHash('md5').update(struct).digest('hex');
    }
}
exports.CanvasBitmapGenerator = CanvasBitmapGenerator;
