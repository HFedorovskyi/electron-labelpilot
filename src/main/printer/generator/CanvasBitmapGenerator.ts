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

import type { ILabelGenerator, LabelDoc, GeneratorOptions, LabelElement } from './types';
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';

export class CanvasBitmapGenerator implements ILabelGenerator {

    async generate(doc: LabelDoc, data: Record<string, any>, options: GeneratorOptions): Promise<Buffer> {
        const t0 = Date.now();

        const dpi = doc.dpi || options.dpi || 203;

        // ── Physical dimensions (mm → dots) ──────────────────────────
        let targetWidthMm = doc.widthMm || options.widthMm;
        let targetHeightMm = doc.heightMm || options.heightMm;

        if (!targetWidthMm && doc.canvas?.widthCm) targetWidthMm = doc.canvas.widthCm * 10;
        if (!targetHeightMm && doc.canvas?.heightCm) targetHeightMm = doc.canvas.heightCm * 10;

        let printWidth: number;
        let labelLength: number;
        let scale: number = 1;

        if (targetWidthMm) {
            printWidth = Math.round(targetWidthMm * dpi / 25.4);
            if (doc.canvas.width > 0) scale = printWidth / doc.canvas.width;
        } else {
            const srcDpi = doc.canvas?.dpi || 96;
            scale = dpi / srcDpi;
            printWidth = Math.round(doc.canvas.width * scale);
        }

        labelLength = targetHeightMm
            ? Math.round(targetHeightMm * dpi / 25.4)
            : Math.round(doc.canvas.height * scale);

        const t1 = Date.now();

        // ── Create single canvas for entire label ────────────────────
        const canvas = createCanvas(printWidth, labelLength);
        const ctx = canvas.getContext('2d');

        // White background
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, printWidth, labelLength);

        const t2 = Date.now();

        // ── Collect barcode elements for native ZPL rendering ────────
        const barcodeCommands: string[] = [];

        // ── Render NON-BARCODE elements onto canvas ──────────────────
        for (const el of doc.elements) {
            if (el.type === 'barcode') {
                // Barcodes → native ZPL (after ^GF)
                const barcodeZpl = this.processBarcodeAsZpl(el, data, scale);
                if (barcodeZpl) barcodeCommands.push(barcodeZpl);
            } else {
                // Text + Rect → canvas
                this.renderElement(ctx, el, data, scale);
            }
        }

        const t3 = Date.now();

        // ── Convert to monochrome 1bpp ───────────────────────────────
        const imageData = ctx.getImageData(0, 0, printWidth, labelLength);
        const bytesPerRow = Math.ceil(printWidth / 8);
        const totalBytes = bytesPerRow * labelLength;
        const monoData = this.rgbaToMono(imageData.data, printWidth, labelLength, bytesPerRow);

        const t4 = Date.now();

        // ── Compress with ZPL run-length encoding ────────────────────
        const compressedData = this.compressZplRLE(monoData, bytesPerRow, labelLength);

        const t5 = Date.now();

        // ── Build ZPL ────────────────────────────────────────────────
        let zpl = '^XA\n';
        zpl += `^PW${printWidth}\n`;
        zpl += `^LL${labelLength}\n`;
        zpl += '^PON\n';

        if (options.darkness !== undefined) zpl += `^MD${options.darkness}\n`;
        if (options.printSpeed !== undefined) zpl += `^PR${options.printSpeed}\n`;

        // Bitmap layer: text + rects
        zpl += `^FO0,0`;
        zpl += `^GFA,${totalBytes},${totalBytes},${bytesPerRow},${compressedData}`;
        zpl += '^FS\n';

        // Native barcode layer: overlaid on top of bitmap
        for (const bc of barcodeCommands) {
            zpl += bc;
        }

        zpl += '^XZ';

        const buf = Buffer.from(zpl, 'utf-8');
        const t6 = Date.now();

        console.log(`[CanvasBitmapGenerator] Timing: setup=${t1 - t0}ms canvas=${t2 - t1}ms render=${t3 - t2}ms mono=${t4 - t3}ms compress=${t5 - t4}ms zpl=${t6 - t5}ms TOTAL=${t6 - t0}ms`);
        console.log(`[CanvasBitmapGenerator] Label: ${printWidth}x${labelLength}px, mono=${totalBytes}B, compressed=${compressedData.length}chars, zpl=${buf.length}B, barcodes=${barcodeCommands.length}`);

        return buf;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Variable substitution
    // ═══════════════════════════════════════════════════════════════════

    private processText(text: string, data: Record<string, any>): string {
        if (!text) return '';
        return text.replace(/\{\{\s*([^{}]+)\s*\}\}/g, (_, key) => {
            const k = key.trim();
            return data[k] !== undefined ? String(data[k]) : `{{${k}}}`;
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Canvas element rendering (text + rect only, NO barcodes)
    // ═══════════════════════════════════════════════════════════════════

    private renderElement(ctx: SKRSContext2D, el: LabelElement, data: Record<string, any>, scale: number): void {
        switch (el.type) {
            case 'text':
                this.drawText(ctx, el, data, scale);
                break;
            case 'rect':
                this.drawRect(ctx, el, scale);
                break;
        }
    }

    // ── TEXT ──────────────────────────────────────────────────────────

    private drawText(ctx: SKRSContext2D, el: LabelElement, data: Record<string, any>, scale: number): void {
        const text = this.processText(el.text || '', data);
        if (!text) return;

        const x = Math.round(el.x * scale);
        const y = Math.round(el.y * scale);
        const w = el.w ? Math.round(el.w * scale) : undefined;
        const h = el.h ? Math.round(el.h * scale) : undefined;

        const fontSize = Math.round((el.fontSize || 12) * scale);
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
        } else if (el.textAlign === 'right' && w) {
            ctx.textAlign = 'right';
            textX = x + w;
        } else {
            ctx.textAlign = 'left';
        }

        // Word wrapping
        const maxWidth = w || 9999;
        const lines = this.wrapText(ctx, text, maxWidth);
        const lineHeight = Math.round(fontSize * 1.2);

        for (let i = 0; i < lines.length; i++) {
            const ly = y + i * lineHeight;
            if (h && (ly - y + lineHeight) > h) break;
            ctx.fillText(lines[i], textX, ly);
        }
    }

    private wrapText(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
        const result: string[] = [];
        for (const paragraph of text.split('\n')) {
            const words = paragraph.split(/\s+/).filter(Boolean);
            if (words.length === 0) { result.push(''); continue; }

            let line = '';
            for (const word of words) {
                const test = line ? `${line} ${word}` : word;
                if (ctx.measureText(test).width > maxWidth && line) {
                    result.push(line);
                    line = word;
                } else {
                    line = test;
                }
            }
            if (line) result.push(line);
        }
        return result;
    }

    // ── RECT ─────────────────────────────────────────────────────────

    private drawRect(ctx: SKRSContext2D, el: LabelElement, scale: number): void {
        const x = Math.round(el.x * scale);
        const y = Math.round(el.y * scale);
        const w = Math.round(el.w * scale);
        const h = Math.round(el.h * scale);
        const border = Math.round((el.borderWidth || 1) * scale) || 1;
        const radius = Math.round((el.borderRadius || 0) * scale);

        ctx.lineWidth = border;
        ctx.strokeStyle = el.borderColor || '#000000';

        if (el.fill && el.fill !== 'transparent') {
            ctx.fillStyle = el.fill;
            if (radius > 0) {
                this.roundRect(ctx, x, y, w, h, radius);
                ctx.fill();
            } else {
                ctx.fillRect(x, y, w, h);
            }
        }

        if (el.borderWidth && el.borderWidth > 0) {
            if (radius > 0) {
                this.roundRect(ctx, x, y, w, h, radius);
                ctx.stroke();
            } else {
                ctx.strokeRect(x, y, w, h);
            }
        }
    }

    private roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.arcTo(x + w, y, x + w, y + r, r);
        ctx.lineTo(x + w, y + h - r);
        ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
        ctx.lineTo(x + r, y + h);
        ctx.arcTo(x, y + h, x, y + h - r, r);
        ctx.lineTo(x, y + r);
        ctx.arcTo(x, y, x + r, y, r);
        ctx.closePath();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  BARCODE — Native ZPL commands (from ZplGenerator)
    //  This gives pixel-perfect barcodes without any external library.
    // ═══════════════════════════════════════════════════════════════════

    private processBarcodeAsZpl(el: LabelElement, data: Record<string, any>, scale: number): string {
        const bcVal = this.processText(el.value || '', data);
        if (!bcVal) return '';

        const x = Math.round(el.x * scale);
        const y = Math.round(el.y * scale);
        const height = Math.round(el.h * scale);
        const moduleWidth = Math.max(2, Math.round(2 * (scale / 2.1)));

        // Rotation mapping
        let orient = 'N';
        if (el.rotation === 90) orient = 'R';
        else if (el.rotation === 180) orient = 'I';
        else if (el.rotation === 270) orient = 'B';

        let cmd = `^FO${x},${y}`;

        const type = (el.barcodeType || 'code128').toLowerCase();

        if (type.includes('code128')) {
            const showText = el.showText ? 'Y' : 'N';
            cmd += `^BY${moduleWidth},3.0,${height}`;
            cmd += `^BC${orient},${height},${showText},N,N^FD${bcVal}^FS\n`;
        } else if (type.includes('qr') || type === 'gs-1') {
            const magnification = Math.max(3, Math.round(scale * 2));
            cmd += `^BQ${orient},2,${magnification}`;
            cmd += `^FDQA,${bcVal}^FS\n`;
        } else if (type.includes('ean13')) {
            const showText = el.showText ? 'Y' : 'N';
            cmd += `^BY${moduleWidth},3.0,${height}`;
            cmd += `^BE${orient},${height},${showText},N^FD${bcVal}^FS\n`;
        } else if (type.includes('datamatrix')) {
            const mag = Math.max(3, Math.round(scale * 2));
            cmd += `^BX${orient},${mag},200`;
            cmd += `^FD${bcVal}^FS\n`;
        } else {
            // Fallback to Code 128
            cmd += `^BY${moduleWidth},3.0,${height}`;
            cmd += `^BC${orient},${height},Y,N,N^FD${bcVal}^FS\n`;
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
                // Fast luminance: (r*77 + g*150 + b*29) >> 8
                const lum = (rgba[idx] * 77 + rgba[idx + 1] * 150 + rgba[idx + 2] * 29) >> 8;

                // Threshold 180 (vs 128) catches antialiased gray pixels from canvas
                // rendering, producing crisper text on thermal printers.
                // Pixels with luminance <= 180 are treated as "dark enough to print".
                if (lum <= 180) {
                    mono[rowOffset + (col >> 3)] |= (0x80 >> (col & 7));
                }
            }
        }

        return mono;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ZPL Compression (Run-Length Encoding for ^GFA)
    //
    //  ZPL compression rules:
    //  - Each row is encoded independently
    //  - Hex chars (0-9, A-F) represent nibbles
    //  - Repeat counts: G=1, H=2, ..., Y=19, Z=20
    //                   g=20, h=40, i=60, ..., z=400
    //  - ',' = row is all zeros (white)
    //  - '!' = row is all ones (black) 
    //  - ':' = row is same as previous row
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
}
