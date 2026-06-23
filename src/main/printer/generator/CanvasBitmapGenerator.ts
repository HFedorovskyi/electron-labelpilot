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
import type { ILabelGenerator, LabelDoc, GeneratorOptions, LabelElement, TableColumn } from './types';
import { createCanvas, type SKRSContext2D, GlobalFonts } from '@napi-rs/canvas';
import { normalizeBarcodeType, shouldRasterizeBarcode, needsGs1Parse } from '../../../shared/barcodeTypes';

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
            // Not bundled. On Windows/macOS @napi-rs/canvas resolves standard families
            // (Arial, Times New Roman, Courier New, Georgia, Verdana) from system fonts,
            // so this is benign there — only debug-level noise, not a real failure.
            log.debug(`[CanvasBitmapGenerator] Font "${font.name}" not bundled; will use a system font if available (searched ${serverFontPath})`);
        }
    }

} catch (e) {
    log.error(`[CanvasBitmapGenerator] Failed to register fonts:`, e);
}

// Cached compressed static layer for the 'inline' path. Holds the already-RLE-encoded
// hex string so we don't re-canvas the static layer on every print when the printer
// can't keep the GRF on its own RAM-drive.
interface InlineStaticEntry {
    compressed: string;
    totalBytes: number;
    bytesPerRow: number;
}

// Memoized structural part of a layout — everything that depends only on the template
// and its physical dimensions (not on the per-print data or per-printer cache state).
// Computing this (element split + dimension math + MD5 structural hash) on every print
// is wasted work; it never changes for a given template+size.
interface StructuralLayout {
    printWidth: number; labelLength: number; scaleX: number; scaleY: number;
    staticElements: LabelElement[]; dynamicElements: LabelElement[];
    bytesPerRow: number; totalBytes: number;
    bgHash: string; bgName: string;
}

// 256-entry uppercase hex lookup table — replaces per-byte toString(16).padStart in the
// RLE/hex hot path (tens of thousands of calls per full-label bitmap on a weak CPU).
const BYTE_HEX: string[] = (() => {
    const t = new Array<string>(256);
    for (let i = 0; i < 256; i++) t[i] = i.toString(16).padStart(2, '0').toUpperCase();
    return t;
})();

export class CanvasBitmapGenerator implements ILabelGenerator {
    // ── RAM-cache path ────────────────────────────────────────────────
    // Tracks which `~DG R:<file>.GRF` hashes are already on each printer's RAM-drive.
    // Stored on `global` so it survives HMR / re-instantiation.
    // Scoped per printer so a hash uploaded to printer A isn't assumed present on printer B.
    private static get uploadedBackgrounds(): Map<string, Set<string>> {
        const g = global as any;
        if (!(g.zplBackgroundCache instanceof Map)) {
            // Replace any legacy Set with a fresh Map.
            g.zplBackgroundCache = new Map<string, Set<string>>();
        }
        return g.zplBackgroundCache;
    }

    private static getCacheForPrinter(printerId: string): Set<string> {
        const map = CanvasBitmapGenerator.uploadedBackgrounds;
        let set = map.get(printerId);
        if (!set) {
            set = new Set<string>();
            map.set(printerId, set);
        }
        return set;
    }

    // ── Inline-cache path ─────────────────────────────────────────────
    // Holds the compressed static-layer hex per cache key, so the inline path
    // doesn't re-render/compress the static layer on every print. The payload
    // still travels in every job — we just skip the canvas + RLE work.
    private static get inlineStaticCache(): Map<string, Map<string, InlineStaticEntry>> {
        const g = global as any;
        if (!(g.zplInlineStaticCache instanceof Map)) {
            g.zplInlineStaticCache = new Map<string, Map<string, InlineStaticEntry>>();
        }
        return g.zplInlineStaticCache;
    }

    private static getInlineCacheForPrinter(printerId: string): Map<string, InlineStaticEntry> {
        const map = CanvasBitmapGenerator.inlineStaticCache;
        let m = map.get(printerId);
        if (!m) {
            m = new Map<string, InlineStaticEntry>();
            map.set(printerId, m);
        }
        return m;
    }

    private static isCacheDisabled(): boolean {
        return process.env.LABELPILOT_DISABLE_BG_CACHE === '1';
    }

    // ── Barcode raster path ───────────────────────────────────────────
    // bwip-js node build, lazily required. The explicit '/node' subpath avoids the
    // package's 'electron' export condition resolving to the DOM/browser build.
    private static _bwip: any = null;
    private static getBwip(): any {
        if (!CanvasBitmapGenerator._bwip) {
            CanvasBitmapGenerator._bwip = require('bwip-js/node');
        }
        return CanvasBitmapGenerator._bwip;
    }

    // Cache of fully-rendered ^GFA barcode commands keyed by (bcid|value|size|text|rot).
    // Rasterizing a barcode (bwip-js → PNG → canvas → mono → RLE) is expensive on a weak
    // CPU; production runs repeat dates/articles/weights, so this turns repeats into a
    // string lookup. Bounded to BARCODE_CACHE_MAX entries (oldest evicted first).
    private static readonly BARCODE_CACHE_MAX = 500;
    private static get barcodeGfaCache(): Map<string, string> {
        const g = global as any;
        if (!(g.zplBarcodeGfaCache instanceof Map)) {
            g.zplBarcodeGfaCache = new Map<string, string>();
        }
        return g.zplBarcodeGfaCache;
    }

    private static cacheBarcodeGfa(key: string, value: string): void {
        const cache = CanvasBitmapGenerator.barcodeGfaCache;
        cache.set(key, value);
        if (cache.size > CanvasBitmapGenerator.BARCODE_CACHE_MAX) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
        }
    }

    // ── Structural layout cache ───────────────────────────────────────
    // Keyed by the doc object (WeakMap → GC-friendly) then by a layout-affecting options
    // key. Holds the result of the expensive element split + dimension math + MD5 hash so
    // cached prints skip all of it. A re-synced template is a NEW object → automatic miss.
    private static structuralCache: WeakMap<object, Map<string, StructuralLayout>> = new WeakMap();

    // ── Dynamic text clip cache ───────────────────────────────────────
    // Caches the final '^FO..^GFA..^FS' command per (element identity + substituted text +
    // scale). Production runs repeat dates/articles/weights, turning a canvas raster + RLE
    // into a string lookup. Bounded; oldest evicted first. global-backed to survive HMR.
    private static readonly CLIP_CACHE_MAX = 800;
    private static get clipGfaCache(): Map<string, string> {
        const g = global as any;
        if (!(g.zplClipGfaCache instanceof Map)) {
            g.zplClipGfaCache = new Map<string, string>();
        }
        return g.zplClipGfaCache;
    }

    private static cacheClipGfa(key: string, value: string): void {
        const cache = CanvasBitmapGenerator.clipGfaCache;
        cache.set(key, value);
        if (cache.size > CanvasBitmapGenerator.CLIP_CACHE_MAX) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
        }
    }

    /**
     * Clear the background cache (both RAM tracking and inline static cache).
     * - With no argument: clear all printers (call after data sync — templates may have changed).
     * - With a printerId: clear only that printer (call on reconnect — printer may have rebooted
     *   and lost its RAM-stored graphics, or its RAM-cache decision was invalidated).
     */
    static clearBackgroundCache(printerId?: string): void {
        const ramMap = CanvasBitmapGenerator.uploadedBackgrounds;
        const inlineMap = CanvasBitmapGenerator.inlineStaticCache;
        if (printerId) {
            const ramSize = ramMap.get(printerId)?.size || 0;
            const inlineSize = inlineMap.get(printerId)?.size || 0;
            ramMap.delete(printerId);
            inlineMap.delete(printerId);
            log.info(`[CanvasBitmapGenerator] BG cache cleared for printer "${printerId}" (ram=${ramSize}, inline=${inlineSize})`);
        } else {
            let ramTotal = 0;
            let inlineTotal = 0;
            for (const s of ramMap.values()) ramTotal += s.size;
            for (const m of inlineMap.values()) inlineTotal += m.size;
            ramMap.clear();
            inlineMap.clear();
            const bcSize = CanvasBitmapGenerator.barcodeGfaCache.size;
            CanvasBitmapGenerator.barcodeGfaCache.clear();
            log.info(`[CanvasBitmapGenerator] BG cache cleared globally (ram=${ramTotal}, inline=${inlineTotal}, barcode=${bcSize})`);
        }
    }

    /**
     * Compute the structural part of the layout (dimensions, static/dynamic split,
     * structural MD5 hash → bgName). Pure and data-independent, so it is memoized per
     * (doc object, layout-affecting options) and reused across every print of a template.
     */
    private computeStructure(doc: LabelDoc, options: GeneratorOptions): StructuralLayout {
        const dpi = options.dpi || doc.dpi || 203;
        const optsKey = `${dpi}|${options.widthMm ?? ''}|${options.heightMm ?? ''}`;

        let perDoc = CanvasBitmapGenerator.structuralCache.get(doc as object);
        if (perDoc) {
            const hit = perDoc.get(optsKey);
            if (hit) return hit;
        } else {
            perDoc = new Map<string, StructuralLayout>();
            CanvasBitmapGenerator.structuralCache.set(doc as object, perDoc);
        }

        const srcDpi = doc.canvas?.dpi || 96;

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
            if (doc.canvas.width > 0) scaleX = printWidth / doc.canvas.width;
            else scaleX = dpi / 25.4;
        } else {
            scaleX = dpi / srcDpi;
            printWidth = Math.round(doc.canvas.width * scaleX);
        }

        if (targetHeightMm) {
            labelLength = Math.round(targetHeightMm * dpi / 25.4);
            if (doc.canvas.height > 0) scaleY = labelLength / doc.canvas.height;
            else scaleY = dpi / 25.4;
        } else {
            scaleY = scaleX;
            labelLength = Math.round((doc.canvas.height || (doc.canvas.width * 0.5)) * scaleY);
        }

        const hasVariables = (text: string) => /\{\{\s*[^{}]+\s*\}\}/.test(text);
        const staticElements: LabelElement[] = [];
        const dynamicElements: LabelElement[] = [];

        for (const el of doc.elements) {
            const isDynamic =
                (el.type === 'text' && hasVariables(el.text || '')) ||
                (el.type === 'barcode') ||
                (el.type === 'table'); // tables read data.items → never bake into the cached static layer
            if (isDynamic) dynamicElements.push(el);
            else staticElements.push(el);
        }

        const bytesPerRow = Math.ceil(printWidth / 8);
        const totalBytes = bytesPerRow * labelLength;
        const bgHash = this.getStructuralHash(staticElements, printWidth, labelLength);
        const bgName = `R:BG${bgHash.substring(0, 6).toUpperCase()}.GRF`;

        const result: StructuralLayout = {
            printWidth, labelLength, scaleX, scaleY,
            staticElements, dynamicElements,
            bytesPerRow, totalBytes, bgHash, bgName,
        };
        perDoc.set(optsKey, result);
        return result;
    }

    /**
     * Build the full per-print layout: the memoized structural part plus the cheap,
     * per-printer/live cache state (cacheKey, printerCache, bgCached). Only the structural
     * part is expensive, and it comes from cache after the first print of a template.
     */
    private prepareLayout(doc: LabelDoc, options: GeneratorOptions): StructuralLayout & {
        cacheKey: string; printerId: string;
        cacheDisabled: boolean; printerCache: Set<string> | null; bgCached: boolean;
    } {
        const s = this.computeStructure(doc, options);
        const cacheKey = `${s.bgName}_${s.totalBytes}`;
        const printerId = options.printerId || '__default__';
        const cacheDisabled = CanvasBitmapGenerator.isCacheDisabled();
        const printerCache = cacheDisabled ? null : CanvasBitmapGenerator.getCacheForPrinter(printerId);
        const bgCached = !!printerCache && printerCache.has(cacheKey);

        return { ...s, cacheKey, printerId, cacheDisabled, printerCache, bgCached };
    }

    /**
     * Canvas-renders the static layer and produces a compressed RLE string.
     * Shared by both the RAM (~DG) and inline (^GFA) paths.
     */
    private async renderStaticCompressed(
        layout: ReturnType<CanvasBitmapGenerator['prepareLayout']>,
        data: Record<string, any>,
    ): Promise<string> {
        const { printWidth, labelLength, scaleX, scaleY, staticElements, bytesPerRow } = layout;

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

        const staticImageData = sctx.getImageData(0, 0, printWidth, labelLength);
        const staticMono = this.rgbaToMono(staticImageData.data, printWidth, labelLength, bytesPerRow);
        return this.compressZplRLE(staticMono, bytesPerRow, labelLength);
    }

    /**
     * Render the static layer to a `~DG` (Download Graphics) command. Pure data — no print
     * framing, so sending this to the printer just stores the bitmap in its RAM.
     */
    private async renderStaticDgCommand(
        layout: ReturnType<CanvasBitmapGenerator['prepareLayout']>,
        data: Record<string, any>,
    ): Promise<{ dg: string; compressedLen: number }> {
        const { bytesPerRow, totalBytes, bgName } = layout;
        const compressed = await this.renderStaticCompressed(layout, data);
        return {
            dg: `~DG${bgName},${totalBytes},${bytesPerRow},${compressed}\n`,
            compressedLen: compressed.length,
        };
    }

    /**
     * Inline path: returns the cached compressed static layer for this printer/template,
     * rendering and caching on first miss. The compressed string travels in every print
     * job but the expensive canvas+RLE work is amortized across prints.
     */
    private async getOrRenderInlineStatic(
        layout: ReturnType<CanvasBitmapGenerator['prepareLayout']>,
        data: Record<string, any>,
    ): Promise<{ entry: InlineStaticEntry; fromCache: boolean }> {
        const { cacheKey, printerId, bytesPerRow, totalBytes, cacheDisabled } = layout;
        const cache = cacheDisabled ? null : CanvasBitmapGenerator.getInlineCacheForPrinter(printerId);
        const hit = cache?.get(cacheKey);
        if (hit) return { entry: hit, fromCache: true };

        const compressed = await this.renderStaticCompressed(layout, data);
        const entry: InlineStaticEntry = { compressed, totalBytes, bytesPerRow };
        if (cache) cache.set(cacheKey, entry);
        return { entry, fromCache: false };
    }

    /**
     * Pre-uploads the static background to the printer — no `^XA…^XZ`, so no label is printed.
     * Returns null if already cached for this printer (caller should skip the send) or if
     * the printer is on the inline path (no pre-upload is meaningful — bitmap travels in every job).
     */
    public async generateBackgroundUpload(doc: LabelDoc, options: GeneratorOptions): Promise<Buffer | null> {
        if (options.cacheMode === 'inline') return null;
        const layout = this.prepareLayout(doc, options);
        if (layout.bgCached) return null;

        const { dg } = await this.renderStaticDgCommand(layout, {});
        if (layout.printerCache) layout.printerCache.add(layout.cacheKey);
        return Buffer.from(dg, 'utf-8');
    }

    async generate(doc: LabelDoc, data: Record<string, any>, options: GeneratorOptions): Promise<Buffer> {
        const t0 = Date.now();
        const layout = this.prepareLayout(doc, options);
        const {
            printWidth, labelLength, scaleX, scaleY,
            dynamicElements, bgName, printerId, cacheDisabled, printerCache, bgCached,
        } = layout;
        const cacheMode = options.cacheMode || 'ram';

        // ── Render Static Layer ─────────────────────────────────────
        // RAM path: emit ~DG once, then ^XG to recall. Subsequent prints skip the upload.
        // Inline path: embed ^GFA in every job (no printer RAM-drive needed). The compressed
        // string is cached in JS memory so we don't re-canvas/RLE on every print.
        let staticDgCommand = '';     // RAM path only
        let inlineGfaCommand = '';    // Inline path only
        let staticCompressedLen = 0;
        let inlineFromCache = false;
        const t2 = Date.now();

        if (cacheMode === 'inline') {
            const { entry, fromCache } = await this.getOrRenderInlineStatic(layout, data);
            inlineFromCache = fromCache;
            staticCompressedLen = entry.compressed.length;
            inlineGfaCommand =
                `^FO0,0^GFA,${entry.totalBytes},${entry.totalBytes},${entry.bytesPerRow},${entry.compressed}^FS\n`;
        } else if (!bgCached) {
            const result = await this.renderStaticDgCommand(layout, data);
            staticDgCommand = result.dg;
            staticCompressedLen = result.compressedLen;
            if (printerCache) printerCache.add(layout.cacheKey);
        }

        const t3 = Date.now();

        // ── Render Dynamic Elements — Per-Element Clips ──────────────
        // Instead of rendering ALL dynamic text on a full-label canvas (~18KB),
        // each dynamic text element gets its own tiny canvas (just its bounding box).
        // This reduces dynamic payload from ~18KB to ~1-3KB total.
        const barcodeCommands: string[] = [];
        const dynamicClipCommands: string[] = [];

        for (const el of dynamicElements) {
            if (el.type === 'barcode' && (el.value || el.text)) {
                const barcodeZpl = await this.renderBarcode(el, data, scaleX, scaleY);
                if (barcodeZpl) barcodeCommands.push(barcodeZpl);
            } else if (el.type === 'text') {
                const clipZpl = this.renderDynamicTextClip(el, data, scaleX, scaleY);
                if (clipZpl) dynamicClipCommands.push(clipZpl);
            } else if (el.type === 'table') {
                const tableZpl = await this.renderTableGfa(el, data, scaleX, scaleY);
                if (tableZpl) dynamicClipCommands.push(tableZpl);
            }
        }

        const t4 = Date.now();

        // ── Assemble ZPL ─────────────────────────────────────────────
        let zpl = staticDgCommand; // empty on inline path
        zpl += '^XA\n';
        zpl += `^PW${printWidth}\n`;
        zpl += `^LL${labelLength}\n`;
        zpl += '^PON\n';

        if (options.darkness !== undefined) zpl += `^MD${options.darkness}\n`;
        if (options.printSpeed !== undefined) zpl += `^PR${options.printSpeed}\n`;

        // Recall Background (RAM path) or embed it inline (^GFA path).
        if (cacheMode === 'inline') {
            zpl += inlineGfaCommand;
        } else {
            zpl += `^FO0,0^XG${bgName},1,1^FS\n`;
        }

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

        let bgStatus: string;
        if (cacheMode === 'inline') {
            bgStatus = inlineFromCache
                ? `INLINE CACHED[${printerId}] ${staticCompressedLen}c`
                : `INLINE RENDER ${staticCompressedLen}c [${printerId}]`;
        } else if (cacheDisabled) {
            bgStatus = `RAM UPLOAD ${staticCompressedLen}c (cache-disabled)`;
        } else {
            bgStatus = bgCached ? `RAM CACHED[${printerId}]` : `RAM UPLOAD ${staticCompressedLen}c [${printerId}]`;
        }
        log.info(`[CanvasBitmapGenerator] Timing: static=${t3 - t2}ms clips=${t4 - t3}ms zpl=${t5 - t4}ms TOTAL=${t5 - t0}ms BG=${bgStatus} clips=${dynamicClipCommands.length}x(${dynamicClipTotalSize}c) bc=${barcodeCommands.length} buf=${buf.length}B`);

        // Optional ZPL dump (off by default — set LABELPILOT_DEBUG_ZPL=1 to enable)
        if (process.env.LABELPILOT_DEBUG_ZPL === '1') {
            try {
                const fs = require('fs');
                const debugPath = path.join(app.getPath('logs'), `debug_label_${Date.now()}.zpl`);
                fs.promises.writeFile(debugPath, zpl).catch(() => { /* fire-and-forget */ });
            } catch (e) {
                log.error(`[CanvasBitmapGenerator] DEBUG: Failed to dump ZPL`, e);
            }
        }

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
            case 'table':
                // Tables are dynamic-only (rendered per-print via renderTableGfa); never
                // baked into the cached static layer. No-op here documents that invariant.
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
        } else if (el.textAlign === 'right' && w) {
            ctx.textAlign = 'right';
            textX = x + w;
        } else {
            ctx.textAlign = 'left';
        }

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
            } else if (verticalAlign === 'bottom') {
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

    private static imageCache: Map<string, any> = new Map();

    private async drawBarcodeImage(ctx: SKRSContext2D, el: LabelElement, scaleX: number, scaleY: number): Promise<void> {
        if (!el.imageData) return;

        const { loadImage } = require('@napi-rs/canvas');
        const src = `data:image/png;base64,${el.imageData}`;

        try {
            let img = CanvasBitmapGenerator.imageCache.get(src);
            if (!img) {
                img = await loadImage(src);
                CanvasBitmapGenerator.imageCache.set(src, img);
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
    //  BARCODE — Hybrid: native ZPL commands for the universal set,
    //  bwip-js → ^GFA raster for everything else (GS1, DataBar, PDF417,
    //  Aztec, exotic 1D). Native = fast + sharp (printer firmware); raster
    //  = identical to the renderer/preview and portable to any ZPL printer.
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Route a barcode element to the native-ZPL or raster path and return its ZPL.
     * NATIVE_SAFE symbologies without GS1 AIs → native command; all else → ^GFA raster.
     */
    private async renderBarcode(el: LabelElement, data: Record<string, any>, scaleX: number, scaleY: number): Promise<string> {
        const value = this.processText(el.value || el.text || '', data);
        if (!value) return '';

        const bcid = normalizeBarcodeType(el.barcodeType);

        if (shouldRasterizeBarcode(bcid, value)) {
            return await this.renderBarcodeGfa(el, bcid, value, scaleX, scaleY);
        }
        return this.nativeBarcodeZpl(el, bcid, value, scaleX, scaleY);
    }

    /**
     * Emit a native ZPL barcode command. Only called for the universal NATIVE_SAFE
     * symbology set (code128, ean13, ean8, upca, upce, qrcode, datamatrix) — every
     * one of these has a command supported across Zebra / TSC / Honeywell ZPL.
     */
    private nativeBarcodeZpl(el: LabelElement, bcid: string, bcVal: string, scaleX: number, scaleY: number): string {
        const x = Math.round(el.x * scaleX);
        const y = Math.round(el.y * scaleY);
        const width = Math.round(el.w * scaleX);
        const height = Math.round(el.h * scaleY);
        const showText = el.showText ? 'Y' : 'N';

        // Rotation mapping (N=0, R=90, I=180, B=270)
        let orient = 'N';
        const rot = el.rotation || 0;
        if (rot === 90) orient = 'R';
        else if (rot === 180) orient = 'I';
        else if (rot === 270) orient = 'B';

        // Module width: fit the symbology's module count into the element width.
        let moduleWidth = el.moduleWidth || 2;
        const fitModules = (modules: number) => {
            if (width > 0 && modules > 0) {
                const best = Math.round(width / modules);
                if (best > 0) moduleWidth = best;
            }
        };

        let cmd = `^FO${x},${y}`;

        switch (bcid) {
            case 'code128': {
                if (width > 0) {
                    const estimatedModules = bcVal.length * 11 + 22;
                    const best = Math.floor(width / estimatedModules);
                    if (best > 0) moduleWidth = best;
                }
                cmd += `^BY${moduleWidth},3.0,${height}`;
                cmd += `^BC${orient},${height},${showText},N,N^FD${bcVal}^FS\n`;
                break;
            }
            case 'ean13': {
                fitModules(95);
                cmd += `^BY${moduleWidth},3.0,${height}`;
                cmd += `^BE${orient},${height},${showText},N^FD${bcVal}^FS\n`;
                break;
            }
            case 'ean8': {
                fitModules(67);
                cmd += `^BY${moduleWidth},3.0,${height}`;
                cmd += `^B8${orient},${height},${showText},N^FD${bcVal}^FS\n`;
                break;
            }
            case 'upca': {
                fitModules(95);
                cmd += `^BY${moduleWidth},3.0,${height}`;
                cmd += `^BU${orient},${height},${showText},N,Y^FD${bcVal}^FS\n`;
                break;
            }
            case 'upce': {
                fitModules(51);
                cmd += `^BY${moduleWidth},3.0,${height}`;
                cmd += `^B9${orient},${height},${showText},N,Y^FD${bcVal}^FS\n`;
                break;
            }
            case 'qrcode': {
                const mag = el.moduleWidth || Math.max(3, Math.round(scaleX * 2));
                cmd += `^BQ${orient},2,${mag}`;
                cmd += `^FDQA,${bcVal}^FS\n`;
                break;
            }
            case 'datamatrix': {
                const mag = el.moduleWidth || Math.max(3, Math.round(scaleX * 2));
                cmd += `^BX${orient},${mag},200`;
                cmd += `^FD${bcVal}^FS\n`;
                break;
            }
            default: {
                // Defensive — the router only sends NATIVE_SAFE here.
                cmd += `^BY${moduleWidth},3.0,${height}`;
                cmd += `^BC${orient},${height},${showText},N,N^FD${bcVal}^FS\n`;
            }
        }

        return cmd;
    }

    /**
     * Raster path: render the barcode with bwip-js (same engine/options as the
     * renderer preview), scale it into the element box, and emit a ^GFA bitmap.
     * Portable to any ZPL printer and supports the full bwip-js symbology set.
     * Result is cached by (bcid|value|size|text|rotation).
     */
    private async renderBarcodeGfa(el: LabelElement, bcid: string, value: string, scaleX: number, scaleY: number): Promise<string> {
        const x = Math.round(el.x * scaleX);
        const y = Math.round(el.y * scaleY);
        const w = Math.max(1, Math.round(el.w * scaleX));
        const h = Math.max(1, Math.round(el.h * scaleY));
        const rotation = el.rotation || 0;
        const showText = !!el.showText;

        const cacheKey = `${bcid}|${value}|${w}x${h}|t${showText ? 1 : 0}|r${rotation}`;
        const cached = CanvasBitmapGenerator.barcodeGfaCache.get(cacheKey);
        if (cached !== undefined) return cached;

        try {
            const png = await this.rasterizeBarcodePng(bcid, value, showText);
            const { loadImage } = require('@napi-rs/canvas');
            const img = await loadImage(png);

            // For 90/270 the on-label bounding box swaps to h×w (same approach as text clips).
            let clipW = w, clipH = h, foX = x, foY = y;
            if (rotation === 90 || rotation === 270) {
                clipW = h; clipH = w;
                const cx = x + w / 2, cy = y + h / 2;
                foX = Math.round(cx - clipW / 2);
                foY = Math.round(cy - clipH / 2);
            }

            const canvas = createCanvas(clipW, clipH);
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, clipW, clipH);
            ctx.imageSmoothingEnabled = false; // keep bars/cells crisp when scaling

            if (rotation) {
                ctx.translate(clipW / 2, clipH / 2);
                ctx.rotate((rotation * Math.PI) / 180);
                ctx.translate(-clipW / 2, -clipH / 2);
                if (rotation === 90 || rotation === 270) {
                    const offX = (clipW - w) / 2, offY = (clipH - h) / 2;
                    ctx.drawImage(img, offX, offY, w, h);
                } else {
                    ctx.drawImage(img, 0, 0, clipW, clipH); // 180°: same dimensions
                }
            } else {
                ctx.drawImage(img, 0, 0, w, h);
            }

            const imageData = ctx.getImageData(0, 0, clipW, clipH);
            const bytesPerRow = Math.ceil(clipW / 8);
            const mono = this.rgbaToMono(imageData.data, clipW, clipH, bytesPerRow);
            const compressed = this.compressZplRLE(mono, bytesPerRow, clipH);
            const totalBytes = bytesPerRow * clipH;

            const result = `^FO${Math.max(0, foX)},${Math.max(0, foY)}^GFA,${totalBytes},${totalBytes},${bytesPerRow},${compressed}^FS\n`;
            CanvasBitmapGenerator.cacheBarcodeGfa(cacheKey, result);
            return result;
        } catch (e) {
            log.error(`[CanvasBitmapGenerator] barcode raster failed for bcid="${bcid}" value="${value}":`, e);
            return ''; // Never emit a wrong-but-scannable fallback — skip instead.
        }
    }

    /**
     * Rasterize a barcode to a PNG buffer via bwip-js (node build). Mirrors the
     * renderer's option set and progressive-fallback chain so the printed bitmap
     * matches the on-screen preview exactly.
     */
    private async rasterizeBarcodePng(bcid: string, value: string, showText: boolean): Promise<Buffer> {
        const bwip = CanvasBitmapGenerator.getBwip();
        const parse = needsGs1Parse(bcid, value);

        const oneD = ['code128', 'gs1-128', 'ean13', 'ean8', 'upca', 'upce', 'interleaved2of5', 'code39'];
        const opts: any = {
            bcid,
            text: value,
            scale: 3,
            includetext: showText,
            textxalign: 'center',
            parse,
            backgroundcolor: 'FFFFFF',
            barcolor: '000000',
        };
        if (oneD.includes(bcid)) opts.height = 15;

        try {
            return await bwip.toBuffer(opts);
        } catch (firstErr) {
            log.warn(`[CanvasBitmapGenerator] bwip-js primary render failed for ${bcid} "${value}": ${firstErr}`);
            const clean = value.replace(/[()]/g, '');
            let fallback = 'code128';
            if (bcid.includes('matrix')) fallback = 'datamatrix';
            else if (bcid.includes('qr')) fallback = 'qrcode';
            try {
                return await bwip.toBuffer({ ...opts, bcid: fallback, text: clean, parse: false });
            } catch (secondErr) {
                log.warn(`[CanvasBitmapGenerator] bwip-js fallback ${fallback} failed: ${secondErr} — using code128`);
                return await bwip.toBuffer({
                    bcid: 'code128', text: clean, scale: 3, height: 15,
                    includetext: showText, textxalign: 'center',
                    backgroundcolor: 'FFFFFF', barcolor: '000000',
                });
            }
        }
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

    /**
     * Single-pass mono conversion + bounding box. Used for dynamic text clips
     * where we want to auto-crop empty borders. Avoids a second full-pixel scan.
     */
    private rgbaToMonoWithBBox(
        rgba: Uint8ClampedArray,
        width: number,
        height: number,
        bytesPerRow: number,
    ): { mono: Uint8Array; minRow: number; maxRow: number; minCol: number; maxCol: number } {
        const mono = new Uint8Array(bytesPerRow * height);
        let minRow = height, maxRow = -1, minCol = width, maxCol = -1;

        for (let row = 0; row < height; row++) {
            const rowOffset = row * bytesPerRow;
            const rgbaRowOffset = row * width * 4;
            let rowHadPixel = false;
            let rowMinCol = width;
            let rowMaxCol = -1;

            for (let col = 0; col < width; col++) {
                const idx = rgbaRowOffset + col * 4;

                if (rgba[idx + 3] < 128) continue;

                const lum = (rgba[idx] * 77 + rgba[idx + 1] * 150 + rgba[idx + 2] * 29) >> 8;

                if (lum <= 180) {
                    mono[rowOffset + (col >> 3)] |= (0x80 >> (col & 7));
                    rowHadPixel = true;
                    if (col < rowMinCol) rowMinCol = col;
                    if (col > rowMaxCol) rowMaxCol = col;
                }
            }

            if (rowHadPixel) {
                if (row < minRow) minRow = row;
                if (row > maxRow) maxRow = row;
                if (rowMinCol < minCol) minCol = rowMinCol;
                if (rowMaxCol > maxCol) maxCol = rowMaxCol;
            }
        }

        return { mono, minRow, maxRow, minCol, maxCol };
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ZPL Compression (Run-Length Encoding for ^GFA)
    // ═══════════════════════════════════════════════════════════════════

    private compressZplRLE(mono: Uint8Array, bytesPerRow: number, height: number): string {
        const out: string[] = [];
        let prevRowHex = '';

        for (let row = 0; row < height; row++) {
            const offset = row * bytesPerRow;

            // Build the row hex (via the byte→hex LUT) and detect all-white / all-black
            // in the SAME pass — avoids both per-byte toString(16) and a second .every() scan.
            let rowHex = '';
            let allZero = true;
            let allOnes = true;
            for (let i = 0; i < bytesPerRow; i++) {
                const b = mono[offset + i];
                rowHex += BYTE_HEX[b];
                if (b !== 0) allZero = false;
                if (b !== 0xFF) allOnes = false;
            }

            if (row > 0 && rowHex === prevRowHex) {
                out.push(':'); // Same as previous row
                continue;
            }
            if (allZero) { out.push(','); prevRowHex = rowHex; continue; }   // white row
            if (allOnes) { out.push('!'); prevRowHex = rowHex; continue; }   // black row

            out.push(this.compressRowRLE(rowHex));
            prevRowHex = rowHex;
        }

        return out.join('');
    }

    private compressRowRLE(hex: string): string {
        const out: string[] = [];
        let i = 0;

        while (i < hex.length) {
            const ch = hex[i];
            let count = 1;
            while (i + count < hex.length && hex[i + count] === ch) {
                count++;
            }

            if (count >= 2) {
                out.push(this.encodeRepeatCount(count), ch);
            } else {
                out.push(ch);
            }
            i += count;
        }

        return out.join('');
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

    // ═══════════════════════════════════════════════════════════════════
    //  Per-Element Dynamic Text Clip
    //  Renders a single dynamic text element on a tiny canvas matching
    //  its bounding box, producing a small ^GFA command (~200-500 bytes)
    //  instead of a full-label bitmap (~18KB).
    // ═══════════════════════════════════════════════════════════════════

    private renderDynamicTextClip(
        el: LabelElement,
        data: Record<string, any>,
        scaleX: number,
        scaleY: number
    ): string {
        const text = this.processText(el.text || '', data);
        if (!text) return '';

        // Cache the final ^GFA command per (element identity + substituted text + scale).
        // Repeated values (dates, articles, often weights) become a string lookup instead
        // of a canvas raster + mono + RLE — the main steady-state CPU cost on a weak machine.
        const cacheKey = `${el.id}|${text}|${el.x},${el.y},${el.w},${el.h}|${el.fontSize}|${el.fontFamily}|${el.fontWeight}|${el.fontStyle}|${el.textAlign}|${el.verticalAlign}|${el.rotation}|${scaleX.toFixed(4)}x${scaleY.toFixed(4)}`;
        const cached = CanvasBitmapGenerator.clipGfaCache.get(cacheKey);
        if (cached !== undefined) return cached;

        const result = this.renderDynamicTextClipUncached(el, text, scaleX, scaleY);
        CanvasBitmapGenerator.cacheClipGfa(cacheKey, result);
        return result;
    }

    private renderDynamicTextClipUncached(
        el: LabelElement,
        text: string,
        scaleX: number,
        scaleY: number
    ): string {
        // Element position and size in printer dots
        const x = Math.round(el.x * scaleX);
        const y = Math.round(el.y * scaleY);
        const w = el.w ? Math.round(el.w * scaleX) : 400;
        const h = el.h ? Math.round(el.h * scaleY) : 100;

        if (w <= 0 || h <= 0) return '';

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
        const clipCanvas = createCanvas(clipW, clipH);
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
            } else {
                // 180° — same dimensions, just rotated
                this.drawTextOnClip(ctx, el, text, 0, 0, clipW, clipH);
            }
        } else {
            // No rotation — straightforward
            this.drawTextOnClip(ctx, el, text, 0, 0, w, h);
        }

        // Convert to mono
        const imageData = ctx.getImageData(0, 0, clipW, clipH);
        const clipBytesPerRow = Math.ceil(clipW / 8);
        const { mono, minRow: bbMinRow, maxRow: bbMaxRow, minCol: bbMinCol, maxCol: bbMaxCol } =
            this.rgbaToMonoWithBBox(imageData.data, clipW, clipH, clipBytesPerRow);

        // Skip if empty
        if (bbMaxRow < 0) return '';

        // Add 1px padding to avoid edge clipping
        const minRow = Math.max(0, bbMinRow - 1);
        const maxRow = Math.min(clipH - 1, bbMaxRow + 1);
        const minCol = Math.max(0, bbMinCol - 1);
        const maxCol = Math.min(clipW - 1, bbMaxCol + 1);

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

        return `^FO${adjustedX},${adjustedY}^GFA,${cropTotalBytes},${cropTotalBytes},${cropBytesPerRow},${compressed}^FS\n`;
    }

    /**
     * Draws text at a given origin within a clip canvas.
     * Reuses the same font/alignment logic as drawText but at arbitrary position.
     */
    private drawTextOnClip(
        ctx: SKRSContext2D,
        el: LabelElement,
        text: string,
        originX: number,
        originY: number,
        w: number,
        h: number
    ): void {
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
        } else if (el.textAlign === 'right') {
            ctx.textAlign = 'right';
            textX = originX + w;
        } else {
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
        } else if (verticalAlign === 'bottom') {
            startY = originY + h - totalTextHeight;
        }

        for (let i = 0; i < lines.length; i++) {
            ctx.fillText(lines[i], textX, startY + i * lineHeight);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Pallet TABLE (labelType 'pallet') — faithful port of the server's
    //  canonical drawTable. Data-driven (data.items) → always rendered as a
    //  dynamic ^GFA overlay, never baked into the cached static layer.
    // ═══════════════════════════════════════════════════════════════════

    /** Word-wrap that also hard-splits over-long words (matches the server wrapText). */
    private wrapTextHard(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
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
    }

    /**
     * Render a table element to its own clip canvas and emit a ^GFA overlay command.
     * Box + fontSize are scaled to printer dots (the reference renders in canvas px since
     * designer canvas == render canvas; the client renders in dots — this scaling is the
     * key fidelity step). Cells resolve per-row via processText({{col.key}}, item).
     */
    private async renderTableGfa(el: LabelElement, data: Record<string, any>, scaleX: number, scaleY: number): Promise<string> {
        const columns = el.columns || [];
        if (!columns.length) return '';

        const x = Math.round(el.x * scaleX);
        const y = Math.round(el.y * scaleY);
        const wDots = Math.max(1, Math.round((el.w || 0) * scaleX));
        const hDots = Math.max(1, Math.round((el.h || 0) * scaleY));
        const rotation = el.rotation || 0;

        let clipW = wDots, clipH = hDots, foX = x, foY = y;
        if (rotation === 90 || rotation === 270) {
            clipW = hDots; clipH = wDots;
            const cx = x + wDots / 2, cy = y + hDots / 2;
            foX = Math.round(cx - clipW / 2);
            foY = Math.round(cy - clipH / 2);
        }

        const canvas = createCanvas(clipW, clipH);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, clipW, clipH);

        ctx.save();
        if (rotation) {
            ctx.translate(clipW / 2, clipH / 2);
            ctx.rotate((rotation * Math.PI) / 180);
            ctx.translate(-clipW / 2, -clipH / 2);
            if (rotation === 90 || rotation === 270) ctx.translate((clipW - wDots) / 2, (clipH - hDots) / 2);
        }
        ctx.scale(scaleX, scaleY); // map source px → printer dots; draw in source coords below
        this.drawTableLocal(ctx, el, data, columns);
        ctx.restore();

        const imageData = ctx.getImageData(0, 0, clipW, clipH);
        const bytesPerRow = Math.ceil(clipW / 8);
        const mono = this.rgbaToMono(imageData.data, clipW, clipH, bytesPerRow);
        const compressed = this.compressZplRLE(mono, bytesPerRow, clipH);
        const totalBytes = bytesPerRow * clipH;
        return `^FO${Math.max(0, foX)},${Math.max(0, foY)}^GFA,${totalBytes},${totalBytes},${bytesPerRow},${compressed}^FS\n`;
    }

    /** drawTable body in LOCAL source coordinates (origin 0,0). Caller applies scale + ^FO. */
    private drawTableLocal(ctx: SKRSContext2D, el: LabelElement, data: Record<string, any>, columns: TableColumn[]): void {
        const w = el.w || 0;
        const h = el.h || 0;
        const fontSize = el.fontSize || 10;
        const showHeaders = el.showHeaders !== false;
        const showBorders = el.showBorders !== false;
        const fontFamily = el.fontFamily || 'Inter';
        const italic = el.fontStyle === 'italic' ? 'italic ' : '';
        const padding = 4;
        const rowHeight = fontSize * 1.5;
        const lineH = fontSize * 1.1;
        // Grid lines: the reference uses light gray (#cbd5e1) for screen; on a 1-bit thermal
        // printer that thresholds to white (invisible). Use a dark line so the grid prints.
        const LINE = '#334155';

        const headerFont = `bold ${fontSize}px "${fontFamily}", "Arial", sans-serif`;
        const bodyFont = `${italic}${fontSize}px "${fontFamily}", "Arial", sans-serif`;

        let headerHeight = showHeaders ? rowHeight : 0;
        const headerLines: string[][] = [];
        if (showHeaders) {
            ctx.font = headerFont;
            let maxHeaderLines = 1;
            for (const col of columns) {
                const colWidth = (w * col.widthRatio) / 100;
                const lines = this.wrapTextHard(ctx, col.title, colWidth - padding * 2);
                headerLines.push(lines);
                maxHeaderLines = Math.max(maxHeaderLines, lines.length);
            }
            headerHeight = Math.max(rowHeight, maxHeaderLines * lineH + padding * 2);

            ctx.fillStyle = '#f8fafc';
            ctx.fillRect(0, 0, w, headerHeight);
            ctx.font = headerFont;
            ctx.fillStyle = '#000000';
            ctx.textBaseline = 'top';
            let cx = 0;
            columns.forEach((col, ci) => {
                const colWidth = (w * col.widthRatio) / 100;
                headerLines[ci].forEach((line, li) => {
                    ctx.fillText(line, cx + padding, padding + li * lineH, colWidth - padding * 2);
                });
                cx += colWidth;
            });
        }

        if (showBorders) {
            ctx.strokeStyle = LINE;
            ctx.lineWidth = 1;
            ctx.strokeRect(0, 0, w, h);
            if (showHeaders) {
                ctx.beginPath(); ctx.moveTo(0, headerHeight); ctx.lineTo(w, headerHeight); ctx.stroke();
            }
            let cx = 0;
            columns.forEach((col, idx) => {
                if (idx < columns.length - 1) {
                    cx += (w * col.widthRatio) / 100;
                    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
                }
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
                const val = this.processText(`{{ ${col.key} }}`, item);
                const lines = this.wrapTextHard(ctx, val, colWidth - padding * 2);
                colLines.push(lines);
                maxLines = Math.max(maxLines, lines.length);
            }
            const rh = Math.max(rowHeight, maxLines * lineH + padding * 2);
            if (currentY + rh > bodyLimit) return false;
            let cx = 0;
            columns.forEach((col, ci) => {
                const colWidth = (w * col.widthRatio) / 100;
                colLines[ci].forEach((line, li) => {
                    ctx.fillText(line, cx + padding, currentY + padding + li * lineH, colWidth - padding * 2);
                });
                cx += colWidth;
            });
            if (showBorders) {
                ctx.strokeStyle = LINE; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(0, currentY + rh); ctx.lineTo(w, currentY + rh); ctx.stroke();
            }
            currentY += rh; drawnCount++; return true;
        };

        const drawGroupHeader = (label: string): boolean => {
            if (currentY + rowHeight > bodyLimit) return false;
            ctx.fillStyle = '#e8edf3'; ctx.fillRect(0, currentY, w, rowHeight);
            ctx.font = headerFont; ctx.fillStyle = '#0f172a'; ctx.textBaseline = 'middle';
            ctx.fillText(label, padding, currentY + rowHeight / 2, w - padding * 2);
            if (showBorders) {
                ctx.strokeStyle = LINE; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(0, currentY + rowHeight); ctx.lineTo(w, currentY + rowHeight); ctx.stroke();
            }
            currentY += rowHeight; return true;
        };

        if (el.groupBy === 'nomenclature' || el.groupBy === 'batch') {
            const groupField = el.groupBy === 'batch' ? 'batch_number' : 'name';
            const order: string[] = [];
            const groups: Record<string, any[]> = {};
            for (const it of items) {
                const k = String(it?.[groupField] ?? '—');
                if (!(k in groups)) { groups[k] = []; order.push(k); }
                groups[k].push(it);
            }
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
            ctx.fillStyle = '#e2e8f0'; ctx.fillRect(0, fy, w, footerH);
            ctx.strokeStyle = LINE; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(0, fy); ctx.lineTo(w, fy); ctx.stroke();
            ctx.font = `bold ${Math.max(13, Math.round(fontSize * 1.8))}px "${fontFamily}", "Arial", sans-serif`;
            ctx.fillStyle = '#1e293b'; ctx.textBaseline = 'middle';
            const txt = truncated
                ? `Стр. 1 / ${pages}   ·   показано ${drawnCount} из ${totalCount} позиций`
                : `Стр. 1 / 1   ·   всего ${totalCount} позиций`;
            ctx.fillText(txt, padding * 2, fy + footerH / 2, w - padding * 4);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Structural Hash — deterministic based on element properties,
    //  not canvas bitmap (which can vary due to floating-point rounding)
    // ═══════════════════════════════════════════════════════════════════

    private getStructuralHash(elements: LabelElement[], canvasW: number, canvasH: number): string {
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
