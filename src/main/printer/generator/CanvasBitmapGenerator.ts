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

import log from '../../logger';
import path from 'path';
import { app } from 'electron';
import type { ILabelGenerator, LabelDoc, GeneratorOptions, LabelElement } from './types';
import { createCanvas, type SKRSContext2D, GlobalFonts } from '@napi-rs/canvas';

// Register custom fonts
try {
    const isDev = !app.isPackaged;
    const resourcesPath = isDev
        ? path.join(process.cwd(), 'resources', 'fonts')
        : path.join(process.resourcesPath, 'fonts');

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
        const serverFontPath = path.join(resourcesPath, 'server_fonts', font.file);
        const rootFontPath = path.join(resourcesPath, font.file);

        const finalPath = fs.existsSync(serverFontPath) ? serverFontPath : rootFontPath;

        if (fs.existsSync(finalPath)) {
            // @ts-ignore
            GlobalFonts.registerFromPath(finalPath, font.name);
            log.info(`[CanvasBitmapGenerator] Registered font "${font.name}" (${font.weight}) from ${finalPath}`);
        } else {
            log.warn(`[CanvasBitmapGenerator] Font file not found for "${font.name}": searched in ${serverFontPath} and ${rootFontPath}`);
        }
    }

} catch (e) {
    log.error(`[CanvasBitmapGenerator] Failed to register fonts:`, e);
}

export class CanvasBitmapGenerator implements ILabelGenerator {
    // Session cache for backgrounds, move to global to ensure persistence across re-instantiations
    private static get uploadedBackgrounds(): Set<string> {
        if (!(global as any).zplBackgroundCache) {
            (global as any).zplBackgroundCache = new Set<string>();
        }
        return (global as any).zplBackgroundCache;
    }

    async generate(doc: LabelDoc, data: Record<string, any>, options: GeneratorOptions): Promise<Buffer> {
        const t0 = Date.now();

        const dpi = doc.dpi || options.dpi || 203;
        const srcDpi = doc.canvas?.dpi || 96;

        // ── Physical dimensions (mm → dots) ──────────────────────────
        let targetWidthMm = doc.widthMm || options.widthMm;
        let targetHeightMm = doc.heightMm || options.heightMm;

        if (!targetWidthMm && doc.canvas?.widthCm) targetWidthMm = doc.canvas.widthCm * 10;
        if (!targetHeightMm && doc.canvas?.heightCm) targetHeightMm = doc.canvas.heightCm * 10;

        let printWidth: number;
        let labelLength: number;
        let scaleX: number = 1;
        let scaleY: number = 1;

        if (targetWidthMm) {
            printWidth = Math.round(targetWidthMm * dpi / 25.4);

            // If canvas width is provided, it defines the source coordinate system.
            // If it's missing, we assume elements are in mm and need to be scaled to dots.
            if (doc.canvas.width > 0) {
                scaleX = printWidth / doc.canvas.width;
            } else {
                scaleX = dpi / 25.4; // 1mm -> X dots
            }
        } else {
            scaleX = dpi / srcDpi;
            printWidth = Math.round(doc.canvas.width * scaleX);
        }

        if (targetHeightMm) {
            labelLength = Math.round(targetHeightMm * dpi / 25.4);
            if (doc.canvas.height > 0) {
                scaleY = labelLength / doc.canvas.height;
            } else {
                scaleY = dpi / 25.4;
            }
        } else {
            scaleY = scaleX;
            labelLength = Math.round((doc.canvas.height || (doc.canvas.width * 0.5)) * scaleY);
        }

        log.info(`[CanvasBitmapGenerator] FULL DATA OBJECT: ${JSON.stringify(data)}`);

        const t2 = Date.now();
        const hasVariables = (text: string) => /\{\{\s*[^{}]+\s*\}\}/.test(text);

        // ── Split elements into static vs dynamic ─────────────────────
        const staticElements: LabelElement[] = [];
        const dynamicElements: LabelElement[] = [];

        for (const el of doc.elements) {
            const isDynamic =
                (el.type === 'text' && hasVariables(el.text || '')) ||
                (el.type === 'barcode' && hasVariables(el.value || el.text || '')) ||
                (el.type === 'barcode'); // Treat all barcodes as dynamic to be safe

            if (isDynamic) {
                dynamicElements.push(el);
            } else {
                staticElements.push(el);
            }
        }

        // ── Render Static Layer ──────────────────────────────────────
        const staticCanvas = createCanvas(printWidth, labelLength);
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

        // Simple hash for background identification
        const bgHash = this.getSimpleHash(staticMono);
        const bgName = `R:BG${bgHash.substring(0, 6).toUpperCase()}.GRF`;

        const t3 = Date.now();

        // ── Render Dynamic Elements & Collect Native Barcodes ────────
        const barcodeCommands: string[] = [];
        const dynamicCanvas = createCanvas(printWidth, labelLength);
        const dctx = dynamicCanvas.getContext('2d');
        // Dynamic canvas is transparent
        dctx.clearRect(0, 0, printWidth, labelLength);

        for (const el of dynamicElements) {
            if (el.type === 'barcode' && (el.value || el.text)) {
                const barcodeZpl = this.processBarcodeAsZpl(el, data, scaleX, scaleY);
                if (barcodeZpl) barcodeCommands.push(barcodeZpl);
            } else {
                dctx.save();
                this.applyRotation(dctx, el, scaleX, scaleY);
                await this.renderElement(dctx, el, data, scaleX, scaleY);
                dctx.restore();
            }
        }

        const dynamicImageData = dctx.getImageData(0, 0, printWidth, labelLength);
        const dynamicMono = this.rgbaToMono(dynamicImageData.data, printWidth, labelLength, bytesPerRow);
        const hasDynamicBits = dynamicMono.some(b => b !== 0);

        const t4 = Date.now();

        // ── Build ZPL with Caching ──────────────────────────────────
        let zpl = '';

        // ~DG (Download Graphics) only if background is NOT in session cache
        const staticCompressed = this.compressZplRLE(staticMono, bytesPerRow, labelLength);
        const cacheKey = `${bgName}_${totalBytes}`;

        if (!CanvasBitmapGenerator.uploadedBackgrounds.has(cacheKey)) {
            zpl += `~DG${bgName},${totalBytes},${bytesPerRow},${staticCompressed}\n`;
            CanvasBitmapGenerator.uploadedBackgrounds.add(cacheKey);
            log.info(`[CanvasBitmapGenerator] Uploading NEW background to printer memory: ${bgName}`);
        } else {
            log.info(`[CanvasBitmapGenerator] Using cached background in printer memory: ${bgName}`);
        }

        zpl += '^XA\n';
        zpl += `^PW${printWidth}\n`;
        zpl += `^LL${labelLength}\n`;
        zpl += '^PON\n';

        if (options.darkness !== undefined) zpl += `^MD${options.darkness}\n`;
        if (options.printSpeed !== undefined) zpl += `^PR${options.printSpeed}\n`;

        // Recall Background
        zpl += `^FO0,0^XG${bgName},1,1^FS\n`;

        // Overlay Dynamic Bits (if any)
        if (hasDynamicBits) {
            const dynamicCompressed = this.compressZplRLE(dynamicMono, bytesPerRow, labelLength);
            // We use ^GFA for dynamic bits as they change every time
            zpl += `^FO0,0^GFA,${totalBytes},${totalBytes},${bytesPerRow},${dynamicCompressed}^FS\n`;
        }

        // Overlay Native Barcodes
        for (const bc of barcodeCommands) {
            zpl += bc;
        }

        zpl += '^XZ';

        const buf = Buffer.from(zpl, 'utf-8');
        const t5 = Date.now();

        log.info(`[CanvasBitmapGenerator] Optimized Timing: static=${t3 - (t2 as any)}ms dynamic=${t4 - (t3 as any)}ms zpl=${t5 - (t4 as any)}ms TOTAL=${t5 - t0}ms`);
        log.info(`[CanvasBitmapGenerator] Layered ZPL: Background=${bgName}, Static=${staticCompressed.length}chars, DynamicBits=${hasDynamicBits}, NativeBC=${barcodeCommands.length}`);

        return buf;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Variable substitution
    // ═══════════════════════════════════════════════════════════════════

    private processText(text: string, data: Record<string, any>): string {
        if (!text) return '';

        // Prepare a lowercase map for case-insensitive lookup
        const lowerData: Record<string, any> = {};
        for (const [key, val] of Object.entries(data)) {
            lowerData[key.toLowerCase()] = val;
        }

        return text.replace(/\{\{\s*([^{}]+)\s*\}\}/g, (_, key) => {
            const k = key.trim();
            const lowerK = k.toLowerCase();

            // Priority: 
            // 1. Exact match
            // 2. Case-insensitive match
            if (data[k] !== undefined) return String(data[k]);
            if (lowerData[lowerK] !== undefined) return String(lowerData[lowerK]);

            return `{{${k}}}`;
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Canvas element rendering (text + rect only, NO barcodes)
    // ═══════════════════════════════════════════════════════════════════

    private async renderElement(ctx: SKRSContext2D, el: LabelElement, data: Record<string, any>, scaleX: number, scaleY: number): Promise<void> {
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

    private drawText(ctx: SKRSContext2D, el: LabelElement, data: Record<string, any>, scaleX: number, scaleY: number): void {
        const text = this.processText(el.text || '', data);
        if (!text) return;

        const x = Math.round(el.x * scaleX);
        const y = Math.round(el.y * scaleY);
        const w = el.w ? Math.round(el.w * scaleX) : undefined;
        const h = el.h ? Math.round(el.h * scaleY) : undefined;

        let fontSize = Math.round((el.fontSize || 12) * scaleY);
        const fontFamily = el.fontFamily || 'Arial';
        const weight = el.fontWeight ? (typeof el.fontWeight === 'number' && el.fontWeight >= 600 ? 'bold' : (el.fontWeight === 'bold' ? 'bold' : 'normal')) : 'normal';
        const style = el.fontStyle || 'normal';

        // Initial font setup
        ctx.font = `${style} ${weight} ${fontSize}px "${fontFamily}", "Arial", sans-serif`;

        // ADAPTIVE SCALING: Check if text fits in width. If not, reduce font size up to 70% of original.
        // This handles cases where server font (Arial) is wider than client font (Inter).
        if (w) {
            const originalFontSize = fontSize;
            let textWidth = ctx.measureText(text).width;

            // Heuristic: If it's overflowing but not massively (max 1.5x), try to shrink it.
            // If it's huge overflow (like ingredients), we probably want wrapping.
            if (textWidth > w && textWidth < w * 1.5) {
                log.info(`[CanvasBitmapGenerator] Text "${el.id}" overflow: ${textWidth.toFixed(1)} > ${w}. Attempting to shrink...`);
                while (textWidth > w && fontSize > originalFontSize * 0.7) {
                    fontSize--;
                    ctx.font = `${style} ${weight} ${fontSize}px "${fontFamily}", "Arial", sans-serif`;
                    textWidth = ctx.measureText(text).width;
                }
                log.info(`[CanvasBitmapGenerator] Shrunk "${el.id}" to ${fontSize}px (was ${originalFontSize}px). New width: ${textWidth.toFixed(1)}`);
            }
        }

        ctx.font = `${style} ${weight} ${fontSize}px "${fontFamily}", "Arial", sans-serif`;
        ctx.fillStyle = '#000000';
        ctx.textBaseline = 'top';

        // Alignment
        let textX = x;
        if (el.textAlign === 'center' && w) {
            ctx.textAlign = 'center';
            textX = x + w / 2;
        } else if (el.textAlign === 'right' && w) {
            ctx.textAlign = 'right';
            textX = x + w;
        } else {
            ctx.textAlign = 'left';
        }

        console.log(`[CanvasBitmapGenerator] Drawing element "${el.id}" at (${x}, ${y}) w=${w} h=${h}. Text: "${text.substring(0, 30)}..."`);

        // TIGHTENING HACK: Node-Canvas often renders text slightly wider than browsers.
        // We gently squeeze the horizontal scale to 98% to simulate tighter tracking/kerning.
        ctx.save();
        ctx.translate(textX, y);
        ctx.scale(0.98, 1);
        // Since we translated to textX, we draw at x=0 (relative)
        const drawX = 0;

        // Word wrapping needs to account for the scale:
        // effectiveWidth = w / 0.98
        const maxWidth = w ? (w / 0.98) : 9999;
        const lines = this.wrapText(ctx, text, maxWidth);

        // Line height: 1.15 multiplier matches tight label requirements
        const lineHeight = Math.round(fontSize * 1.15);

        for (let i = 0; i < lines.length; i++) {
            const ly = i * lineHeight;
            ctx.fillText(lines[i], drawX, ly);
        }
        ctx.restore();
    }

    private wrapText(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
        const paragraphs = text.split("\n");
        const allLines: string[] = [];

        for (const para of paragraphs) {
            const words = para.split(" ");
            let currentLine = "";

            for (const word of words) {
                const testLine = currentLine ? currentLine + " " + word : word;
                const metrics = ctx.measureText(testLine);
                if (metrics.width > maxWidth && currentLine) {
                    allLines.push(currentLine);
                    currentLine = word;
                } else {
                    currentLine = testLine;
                }
            }
            allLines.push(currentLine);
        }
        return allLines;
    }

    // ── RECT ─────────────────────────────────────────────────────────

    private drawRect(ctx: SKRSContext2D, el: LabelElement, scaleX: number, scaleY: number): void {
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
        } else {
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

    private imageCache = new Map<string, any>();

    private async drawBarcodeImage(ctx: SKRSContext2D, el: LabelElement, scaleX: number, scaleY: number): Promise<void> {
        if (!el.imageData) return;

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
        } catch (e) {
            log.error(`[CanvasBitmapGenerator] Failed to draw barcode image:`, e);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  BARCODE — Native ZPL commands (from ZplGenerator)
    //  This gives pixel-perfect barcodes without any external library.
    // ═══════════════════════════════════════════════════════════════════

    private processBarcodeAsZpl(el: LabelElement, data: Record<string, any>, scaleX: number, scaleY: number): string {
        const bcVal = this.processText(el.value || el.text || '', data);
        if (!bcVal) return '';

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
                if (bestMw > 0) moduleWidth = bestMw;
            } else if (type.includes('128')) {
                // Code 128: ~11 modules per char + quiet zones
                const estimatedModules = bcVal.length * 11 + 22;
                const bestMw = Math.floor(width / estimatedModules);
                if (bestMw > 0) moduleWidth = bestMw;
            }
        }

        log.info(`[CanvasBitmapGenerator] Barcode "${el.id}" (${type}): ` +
            `box_h=${el.h} -> dots_h=${height}, box_w=${el.w} -> dots_w=${width}, ` +
            `mw=${moduleWidth}, scales=(${scaleX.toFixed(2)},${scaleY.toFixed(2)}), val="${bcVal}"`);

        // Rotation mapping
        let orient = 'N';
        const rot = el.rotation || 0;
        if (rot === 90) orient = 'R';
        else if (rot === 180) orient = 'I';
        else if (rot === 270) orient = 'B';

        let cmd = `^FO${x},${y}`;

        if (type.includes('code128')) {
            const showText = el.showText ? 'Y' : 'N';
            cmd += `^BY${moduleWidth},3.0,${height}`;
            cmd += `^BC${orient},${height},${showText},N,N^FD${bcVal}^FS\n`;
        } else if (type.includes('qr') || type === 'gs-1') {
            const mag = el.moduleWidth || Math.max(3, Math.round(scaleX * 2));
            cmd += `^BQ${orient},2,${mag}`;
            cmd += `^FDQA,${bcVal}^FS\n`;
        } else if (type.includes('ean13')) {
            const showText = el.showText ? 'Y' : 'N';
            cmd += `^BY${moduleWidth},3.0,${height}`;
            cmd += `^BE${orient},${height},${showText},N^FD${bcVal}^FS\n`;
        } else if (type.includes('datamatrix')) {
            const mag = el.moduleWidth || Math.max(3, Math.round(scaleX * 2));
            cmd += `^BX${orient},${mag},200`;
            cmd += `^FD${bcVal}^FS\n`;
        } else {
            const showText = el.showText ? 'Y' : 'N';
            cmd += `^BY${moduleWidth},3.0,${height}`;
            cmd += `^BC${orient},${height},${showText},N,N^FD${bcVal}^FS\n`;
        }

        return cmd;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Monochrome conversion (improved threshold for thermal printers)
    // ═══════════════════════════════════════════════════════════════════

    private rgbaToMono(rgba: Uint8ClampedArray, width: number, height: number, bytesPerRow: number): Uint8Array {
        const mono = new Uint8Array(bytesPerRow * height);

        for (let row = 0; row < height; row++) {
            const rowOffset = row * bytesPerRow;
            const rgbaRowOffset = row * width * 4;

            for (let col = 0; col < width; col++) {
                const idx = rgbaRowOffset + col * 4;

                // Transparency check: if alpha is low, treat as white (ignore)
                if (rgba[idx + 3] < 128) continue;

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

    private compressZplRLE(mono: Uint8Array, bytesPerRow: number, height: number): string {
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

    private compressRowRLE(hex: string): string {
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
            } else {
                result += ch;
            }
            i += count;
        }

        return result;
    }

    private encodeRepeatCount(count: number): string {
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

    private applyRotation(ctx: SKRSContext2D, el: LabelElement, scaleX: number, scaleY: number) {
        if (el.rotation) {
            const centerX = (el.x + (el.w || 0) / 2) * scaleX;
            const centerY = (el.y + (el.h || 0) / 2) * scaleY;
            ctx.translate(centerX, centerY);
            ctx.rotate((el.rotation * Math.PI) / 180);
            ctx.translate(-centerX, -centerY);
        }
    }

    private getSimpleHash(data: Uint8Array): string {
        const crypto = require('crypto');
        return crypto.createHash('md5').update(data).digest('hex');
    }
}
