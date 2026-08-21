import { needsGs1Parse, normalizeBarcodeType } from '../../shared/barcodeTypes';
import { portableNativeLinearSpec } from '../../shared/barcodePrintMatrix';
import { labelFontStack, normalizeLabelFontFamily } from '../../shared/labelFonts';

const MAX_ELEMENTS = 1_024;
const MAX_BITMAP_PIXELS = 9_000_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface TauriBitmapRequest {
    config: Record<string, unknown>;
    doc: Record<string, unknown>;
    data: Record<string, unknown>;
}

export interface TauriRenderedBitmap {
    widthDots: number;
    heightDots: number;
    bytesPerRow: number;
    mono: Uint8Array;
    renderMs: number;
}

let bwipPromise: Promise<any> | undefined;

function record(value: unknown, label: string): Record<string, any> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Record<string, any>;
}

function finite(value: unknown, fallback = 0): number {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function interpolate(template: unknown, data: Record<string, unknown>): string {
    const text = String(template ?? '');
    const lower = new Map(Object.entries(data).map(([key, value]) => [key.toLowerCase(), value]));
    return text.replace(/{{\s*([^{}]+)\s*}}/g, (match, rawKey: string) => {
        const key = rawKey.trim();
        const value = Object.prototype.hasOwnProperty.call(data, key) ? data[key] : lower.get(key.toLowerCase());
        return value === undefined ? match : String(value);
    });
}

function geometry(request: TauriBitmapRequest) {
    const config = request.config;
    const doc = request.doc;
    const canvas = record(doc.canvas, 'label canvas');
    const dpi = finite(config.dpi ?? doc.dpi ?? canvas.dpi, 203);
    if (![203, 300, 600].includes(dpi)) throw new Error(`unsupported printer DPI: ${dpi}`);
    const sourceDpi = finite(canvas.dpi, 96) || 96;
    const widthMm = finite(doc.widthMm ?? config.widthMm)
        || finite(canvas.widthCm) * 10
        || finite(canvas.width) * 25.4 / sourceDpi;
    const heightMm = finite(doc.heightMm ?? config.heightMm)
        || finite(canvas.heightCm) * 10
        || finite(canvas.height) * 25.4 / sourceDpi;
    const sourceWidth = finite(canvas.width);
    const sourceHeight = finite(canvas.height);
    if (widthMm <= 0 || heightMm <= 0 || sourceWidth <= 0 || sourceHeight <= 0) {
        throw new Error('label dimensions and canvas dimensions must be positive');
    }
    const widthDots = Math.max(1, Math.round(widthMm * dpi / 25.4));
    const heightDots = Math.max(1, Math.round(heightMm * dpi / 25.4));
    if (widthDots * heightDots > MAX_BITMAP_PIXELS) {
        throw new Error(`bitmap fallback exceeds ${MAX_BITMAP_PIXELS} pixels`);
    }
    return {
        dpi,
        widthMm,
        heightMm,
        widthDots,
        heightDots,
        sourceWidth,
        sourceHeight,
        scaleX: widthDots / sourceWidth,
        scaleY: heightDots / sourceHeight,
    };
}

function wrapText(context: CanvasRenderingContext2D, text: string, width: number): string[] {
    const lines: string[] = [];
    for (const paragraph of text.split('\n')) {
        let current = '';
        // Deliberately split on a literal space. This matches the previous
        // CanvasBitmapGenerator and preserves authored spacing in legacy labels.
        for (const word of paragraph.split(' ')) {
            const candidate = current ? current + ' ' + word : word;
            if (current && context.measureText(candidate).width > width) {
                lines.push(current);
                current = word;
            } else {
                current = candidate;
            }
        }
        lines.push(current);
    }
    return lines;
}

async function ensureLabelFonts(elements: unknown[]): Promise<void> {
    if (!document.fonts) return;
    const requests = new Set<string>();
    for (const raw of elements) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const element = raw as Record<string, any>;
        if (element.type !== 'text' && element.type !== 'table') continue;
        const family = normalizeLabelFontFamily(element.fontFamily, 'Arial');
        const weight = String(element.fontWeight || 'normal');
        const style = element.fontStyle === 'italic' ? 'italic' : 'normal';
        requests.add(style + ' ' + weight + ' 16px "' + family + '"');
    }
    await Promise.all([...requests].map(specification => document.fonts.load(specification)));
    await document.fonts.ready;
}

function drawText(
    context: CanvasRenderingContext2D,
    element: Record<string, any>,
    data: Record<string, unknown>,
    scaleX: number,
    scaleY: number,
): void {
    const x = Math.round(finite(element.x) * scaleX);
    const y = Math.round(finite(element.y) * scaleY);
    const width = Math.max(1, Math.round(finite(element.w) * scaleX));
    const height = Math.max(1, Math.round(finite(element.h) * scaleY));
    const fontSize = Math.max(1, finite(element.fontSize, 12) * scaleY);
    const rawWeight = element.fontWeight ?? 400;
    const fontWeight = /^(?:[1-9]00|normal|bold)$/.test(String(rawWeight)) ? String(rawWeight) : '400';
    const italic = element.fontStyle === 'italic' ? 'italic ' : '';
    const family = labelFontStack(element.fontFamily, 'Arial');
    context.font = `${italic}${fontWeight} ${fontSize}px ${family}`;
    context.fillStyle = String(element.color || '#000000');
    context.textBaseline = 'top';
    const align = ['center', 'right'].includes(element.textAlign) ? element.textAlign : 'left';
    context.textAlign = align;
    const lines = wrapText(context, interpolate(element.text, data), width);
    const lineHeight = fontSize * 1.2;
    const blockHeight = lines.length * lineHeight;
    const vertical = String(element.verticalAlign || 'middle');
    const startY = vertical === 'bottom' ? y + height - blockHeight
        : vertical === 'top' ? y
            : y + (height - blockHeight) / 2;
    const textX = align === 'center' ? x + width / 2 : align === 'right' ? x + width : x;
    lines.forEach((line, index) => {
        const lineY = startY + index * lineHeight;
        context.fillText(line, textX, lineY);
        if (String(element.textDecoration || '').includes('underline')) {
            const measured = Math.min(width, context.measureText(line).width);
            const left = align === 'center' ? textX - measured / 2 : align === 'right' ? textX - measured : textX;
            context.fillRect(left, lineY + fontSize + Math.max(1, scaleY), measured, Math.max(1, scaleY));
        }
    });
}

function roundedRectPath(context: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number) {
    const r = Math.max(0, Math.min(radius, w / 2, h / 2));
    context.beginPath();
    context.moveTo(x + r, y);
    context.lineTo(x + w - r, y);
    context.quadraticCurveTo(x + w, y, x + w, y + r);
    context.lineTo(x + w, y + h - r);
    context.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    context.lineTo(x + r, y + h);
    context.quadraticCurveTo(x, y + h, x, y + h - r);
    context.lineTo(x, y + r);
    context.quadraticCurveTo(x, y, x + r, y);
    context.closePath();
}

function drawRect(context: CanvasRenderingContext2D, element: Record<string, any>, scaleX: number, scaleY: number) {
    const x = finite(element.x) * scaleX;
    const y = finite(element.y) * scaleY;
    const width = Math.max(1, finite(element.w) * scaleX);
    const height = Math.max(1, finite(element.h) * scaleY);
    roundedRectPath(context, x, y, width, height, finite(element.borderRadius) * Math.min(scaleX, scaleY));
    if (element.fill && element.fill !== 'transparent') {
        context.fillStyle = String(element.fill);
        context.fill();
    }
    if (finite(element.borderWidth) > 0) {
        context.lineWidth = Math.max(1, finite(element.borderWidth) * Math.min(scaleX, scaleY));
        context.strokeStyle = String(element.borderColor || '#000000');
        context.stroke();
    }
}

export function normalizeTauriImageSource(source: string): string {
    const trimmed = source.trim();
    if (!trimmed || /^(?:data:|blob:|https?:|asset:|tauri:)/i.test(trimmed)) return trimmed;
    const compact = trimmed.replace(/\s+/g, '');
    if (!/^[a-z0-9+/]+={0,2}$/i.test(compact) || compact.length < 32) return trimmed;
    const mime = compact.startsWith('/9j/') ? 'image/jpeg'
        : compact.startsWith('R0lGOD') ? 'image/gif'
            : compact.startsWith('UklGR') ? 'image/webp'
                : compact.startsWith('Qk') ? 'image/bmp'
                    : compact.startsWith('PHN2Zy') || compact.startsWith('PD94bWwg') ? 'image/svg+xml'
                        : 'image/png';
    return `data:${mime};base64,${compact}`;
}

function imageFromSource(source: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('failed to decode label image'));
        image.src = normalizeTauriImageSource(source);
    });
}

export interface NativeZplBarcodePlan {
    command: string;
    bcid: string;
    orientation: 'N' | 'R' | 'I' | 'B';
    fieldX: number;
    fieldY: number;
    fieldWidth: number;
    fieldHeight: number;
    symbolX: number;
    symbolY: number;
    symbolWidth: number;
    symbolHeight: number;
    moduleWidth: number;
    modules: number;
    barHeight: number;
    showText: boolean;
}

function nativeZplBarcodePlan(
    element: Record<string, any>,
    data: Record<string, unknown>,
    scaleX: number,
    scaleY: number,
): NativeZplBarcodePlan | null {
    if (String(element.type || '') !== 'barcode') return null;
    const value = interpolate(element.value ?? element.text, data);
    if (!value || value.includes('{{')) return null;
    const bcid = normalizeBarcodeType(element.barcodeType);
    const nativeSpec = portableNativeLinearSpec(bcid, value);
    if (!nativeSpec) return null;

    const rotation = ((Math.round(finite(element.rotation)) % 360) + 360) % 360;
    if (![0, 90, 180, 270].includes(rotation)) return null;
    const orientation: NativeZplBarcodePlan['orientation'] = rotation === 90 ? 'R'
        : rotation === 180 ? 'I'
            : rotation === 270 ? 'B'
                : 'N';
    const vertical = orientation === 'R' || orientation === 'B';
    const fieldX = Math.round(finite(element.x) * scaleX);
    const fieldY = Math.round(finite(element.y) * scaleY);
    const fieldWidth = Math.max(1, Math.round(finite(element.w) * scaleX));
    const fieldHeight = Math.max(1, Math.round(finite(element.h) * scaleY));
    let symbolX = fieldX;
    let symbolY = fieldY;
    const symbolAxis = vertical ? fieldHeight : fieldWidth;
    if (symbolAxis < nativeSpec.modules) return null;
    const maximumFittingModule = Math.max(1, Math.floor(symbolAxis / nativeSpec.modules));
    const requestedModule = finite(element.moduleWidth);
    const desiredModule = requestedModule > 0 ? Math.round(requestedModule) : maximumFittingModule;
    const moduleWidth = Math.max(1, Math.min(10, maximumFittingModule, desiredModule));
    const actualSymbolAxis = nativeSpec.modules * moduleWidth;
    const primaryOffset = Math.max(0, Math.floor((symbolAxis - actualSymbolAxis) / 2));
    if (vertical) symbolY += primaryOffset;
    else symbolX += primaryOffset;

    const showText = !!element.showText;
    const totalHeight = vertical ? fieldWidth : fieldHeight;
    const textReserve = showText
        ? Math.min(totalHeight - 1, Math.max(12, Math.round(20 * Math.min(scaleX, scaleY))))
        : 0;
    const barHeight = Math.max(1, totalHeight - textReserve);
    const human = showText ? 'Y' : 'N';
    let barcode: string;
    switch (nativeSpec.command) {
        case 'ean13': barcode = `^BE${orientation},${barHeight},${human},N`; break;
        case 'ean8': barcode = `^B8${orientation},${barHeight},${human},N`; break;
        case 'upca': barcode = `^BU${orientation},${barHeight},${human},N,Y`; break;
        case 'upce': barcode = `^B9${orientation},${barHeight},${human},N,Y`; break;
        default: barcode = `^BC${orientation},${barHeight},${human},N,N`;
    }
    const command = `^FO${Math.max(0, symbolX)},${Math.max(0, symbolY)}^BY${moduleWidth},3.0,${barHeight}${barcode}^FD${value}^FS\n`;
    return {
        command,
        bcid,
        orientation,
        fieldX,
        fieldY,
        fieldWidth,
        fieldHeight,
        symbolX,
        symbolY,
        symbolWidth: vertical ? totalHeight : actualSymbolAxis,
        symbolHeight: vertical ? actualSymbolAxis : totalHeight,
        moduleWidth,
        modules: nativeSpec.modules,
        barHeight,
        showText,
    };
}

export function collectNativeZplBarcodePlans(requestValue: TauriBitmapRequest): NativeZplBarcodePlan[] {
    const request = {
        config: record(requestValue.config, 'printer config'),
        doc: record(requestValue.doc, 'label document'),
        data: record(requestValue.data, 'label data'),
    };
    const layout = geometry(request);
    const elements = request.doc.elements;
    if (!Array.isArray(elements) || elements.length > MAX_ELEMENTS) {
        throw new Error(`label elements must contain 0..${MAX_ELEMENTS} items`);
    }
    const plans: NativeZplBarcodePlan[] = [];
    for (const rawElement of elements) {
        const plan = nativeZplBarcodePlan(
            record(rawElement, 'label element'), request.data, layout.scaleX, layout.scaleY,
        );
        if (plan) plans.push(plan);
    }
    return plans;
}

export function collectNativeZplBarcodeCommands(requestValue: TauriBitmapRequest): string[] {
    return collectNativeZplBarcodePlans(requestValue).map(plan => plan.command);
}

function drawFitted(
    context: CanvasRenderingContext2D,
    source: CanvasImageSource,
    sourceWidth: number,
    sourceHeight: number,
    x: number,
    y: number,
    width: number,
    height: number,
) {
    const scale = Math.min(width / sourceWidth, height / sourceHeight);
    const targetWidth = Math.max(1, sourceWidth * scale);
    const targetHeight = Math.max(1, sourceHeight * scale);
    context.drawImage(source, x + (width - targetWidth) / 2, y + (height - targetHeight) / 2, targetWidth, targetHeight);
}

async function drawBarcode(
    context: CanvasRenderingContext2D,
    element: Record<string, any>,
    data: Record<string, unknown>,
    scaleX: number,
    scaleY: number,
) {
    const x = finite(element.x) * scaleX;
    const y = finite(element.y) * scaleY;
    const width = Math.max(1, finite(element.w) * scaleX);
    const height = Math.max(1, finite(element.h) * scaleY);
    const value = interpolate(element.value ?? element.text, data);
    if (!value || value.includes('{{')) {
        if (element.imageData) {
            const image = await imageFromSource(String(element.imageData));
            context.imageSmoothingEnabled = false;
            context.drawImage(image, x, y, width, height);
            return;
        }
        throw new Error(`barcode ${element.id || ''} has unresolved data`);
    }
    bwipPromise ??= import('bwip-js').then(module => module.default);
    const bwip = await bwipPromise;
    const barcodeCanvas = document.createElement('canvas');
    const bcid = normalizeBarcodeType(element.barcodeType);
    const render = (target: string, text: string, parse: boolean) => {
        const options: Record<string, unknown> = {
            bcid: target,
            text,
            scale: Math.max(2, Math.min(5, Math.round(Math.min(width, height) / 45))),
            includetext: !!element.showText,
            textxalign: 'center',
            parse,
        };
        if (!target.includes('qr') && !target.includes('matrix') && target !== 'azteccode') options.height = 15;
        bwip.toCanvas(barcodeCanvas, options);
    };
    try {
        render(bcid, value, needsGs1Parse(bcid, value));
    } catch {
        const clean = value.replace(/[()]/g, '');
        const fallback = bcid.includes('matrix') ? 'datamatrix' : bcid.includes('qr') ? 'qrcode' : 'code128';
        render(fallback, clean, false);
    }
    context.imageSmoothingEnabled = false;
    context.drawImage(barcodeCanvas, x, y, width, height);
}

function tableRows(element: Record<string, any>, data: Record<string, unknown>): Record<string, any>[] {
    let items = Array.isArray(data.items) ? [...data.items] : [];
    if (element.sortBy === 'name') items.sort((a, b) => String(a?.name ?? '').localeCompare(String(b?.name ?? ''), 'ru'));
    if (element.sortBy === 'date') items.sort((a, b) => String(a?.production_date_batch ?? '').localeCompare(String(b?.production_date_batch ?? '')));
    if (finite(element.maxRows) > 0) items = items.slice(0, finite(element.maxRows));
    return items;
}

function drawTable(
    context: CanvasRenderingContext2D,
    element: Record<string, any>,
    data: Record<string, unknown>,
    scaleX: number,
    scaleY: number,
) {
    const x = finite(element.x) * scaleX;
    const y = finite(element.y) * scaleY;
    const width = Math.max(1, finite(element.w) * scaleX);
    const height = Math.max(1, finite(element.h) * scaleY);
    const columns = Array.isArray(element.columns) ? element.columns : [];
    if (!columns.length) throw new Error(`table ${element.id || ''} has no columns`);
    const fontSize = Math.max(6, finite(element.fontSize, 10) * scaleY);
    const padding = Math.max(2, 4 * Math.min(scaleX, scaleY));
    const lineHeight = fontSize * 1.2;
    const showHeaders = element.showHeaders !== false;
    const showBorders = element.showBorders !== false;
    let currentY = y;
    context.textBaseline = 'top';
    if (showHeaders) {
        context.fillStyle = '#f5f5f5';
        context.fillRect(x, currentY, width, lineHeight + padding * 2);
        context.fillStyle = '#000000';
        context.font = `bold ${fontSize}px ${labelFontStack(element.fontFamily, 'Arial')}`;
        let currentX = x;
        for (const column of columns) {
            const columnWidth = width * finite(column.widthRatio, 100 / columns.length) / 100;
            context.fillText(String(column.title ?? column.key ?? ''), currentX + padding, currentY + padding, columnWidth - padding * 2);
            currentX += columnWidth;
        }
        currentY += lineHeight + padding * 2;
    }
    context.font = `${element.fontStyle === 'italic' ? 'italic ' : ''}${fontSize}px ${labelFontStack(element.fontFamily, 'Arial')}`;
    const rows = tableRows(element, data);
    const rowHeight = lineHeight + padding * 2;
    for (const item of rows) {
        if (currentY + rowHeight > y + height) break;
        let currentX = x;
        for (const column of columns) {
            const columnWidth = width * finite(column.widthRatio, 100 / columns.length) / 100;
            const cell = interpolate(`{{${String(column.key || '')}}}`, item);
            context.fillStyle = '#000000';
            context.fillText(cell, currentX + padding, currentY + padding, columnWidth - padding * 2);
            if (showBorders) {
                context.strokeStyle = '#999999';
                context.lineWidth = 1;
                context.strokeRect(currentX, currentY, columnWidth, rowHeight);
            }
            currentX += columnWidth;
        }
        currentY += rowHeight;
    }
    if (showBorders) {
        context.strokeStyle = '#000000';
        context.lineWidth = Math.max(1, Math.min(scaleX, scaleY));
        context.strokeRect(x, y, width, height);
    }
}

async function drawElement(
    context: CanvasRenderingContext2D,
    element: Record<string, any>,
    data: Record<string, unknown>,
    scaleX: number,
    scaleY: number,
) {
    await withTransformAsync(context, element, scaleX, scaleY, async () => {
        switch (String(element.type || '')) {
            case 'text': drawText(context, element, data, scaleX, scaleY); break;
            case 'rect': drawRect(context, element, scaleX, scaleY); break;
            case 'barcode': await drawBarcode(context, element, data, scaleX, scaleY); break;
            case 'table': drawTable(context, element, data, scaleX, scaleY); break;
            case 'image': {
                const source = String(element.imageData || element.src || '');
                if (!source) throw new Error(`image ${element.id || ''} has no source`);
                const image = await imageFromSource(source);
                drawFitted(
                    context, image, image.naturalWidth, image.naturalHeight,
                    finite(element.x) * scaleX, finite(element.y) * scaleY,
                    Math.max(1, finite(element.w) * scaleX), Math.max(1, finite(element.h) * scaleY),
                );
                break;
            }
            default: throw new Error(`unsupported bitmap element: ${String(element.type || '<empty>')}`);
        }
    });
}

async function withTransformAsync(
    context: CanvasRenderingContext2D,
    element: Record<string, any>,
    scaleX: number,
    scaleY: number,
    draw: () => Promise<void>,
) {
    context.save();
    const rotation = finite(element.rotation);
    if (rotation) {
        const centerX = (finite(element.x) + finite(element.w) / 2) * scaleX;
        const centerY = (finite(element.y) + finite(element.h) / 2) * scaleY;
        context.translate(centerX, centerY);
        context.rotate(rotation * Math.PI / 180);
        context.translate(-centerX, -centerY);
    }
    try { await draw(); } finally { context.restore(); }
}

function canvasToMono(context: CanvasRenderingContext2D, width: number, height: number) {
    const rgba = context.getImageData(0, 0, width, height).data;
    const bytesPerRow = Math.ceil(width / 8);
    const mono = new Uint8Array(bytesPerRow * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const offset = (y * width + x) * 4;
            const alpha = rgba[offset + 3];
            const luminance = rgba[offset] * 0.299 + rgba[offset + 1] * 0.587 + rgba[offset + 2] * 0.114;
            if (alpha > 32 && luminance < 180) mono[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
        }
    }
    return { mono, bytesPerRow };
}

export async function renderTauriBitmap(
    requestValue: TauriBitmapRequest,
    options: { omitNativeZplBarcodes?: boolean } = {},
): Promise<TauriRenderedBitmap> {
    const started = performance.now();
    const request = {
        config: record(requestValue.config, 'printer config'),
        doc: record(requestValue.doc, 'label document'),
        data: record(requestValue.data, 'label data'),
    };
    const layout = geometry(request);
    const elements = request.doc.elements;
    if (!Array.isArray(elements) || elements.length > MAX_ELEMENTS) {
        throw new Error(`label elements must contain 0..${MAX_ELEMENTS} items`);
    }
    await ensureLabelFonts(elements);
    const canvas = document.createElement('canvas');
    canvas.width = layout.widthDots;
    canvas.height = layout.heightDots;
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!context) throw new Error('Canvas 2D context is unavailable');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (const rawElement of elements) {
        const element = record(rawElement, 'label element');
        if (options.omitNativeZplBarcodes
            && nativeZplBarcodePlan(element, request.data, layout.scaleX, layout.scaleY)) {
            continue;
        }
        await drawElement(context, element, request.data, layout.scaleX, layout.scaleY);
    }
    const { mono, bytesPerRow } = canvasToMono(context, canvas.width, canvas.height);
    return {
        widthDots: layout.widthDots,
        heightDots: layout.heightDots,
        bytesPerRow,
        mono,
        renderMs: Math.max(0, performance.now() - started),
    };
}

const HEX = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, '0').toUpperCase());

function repeatCount(count: number): string {
    let result = '';
    while (count >= 20) {
        const high = Math.min(Math.floor(count / 20), 20);
        result += String.fromCharCode('f'.charCodeAt(0) + high);
        count -= high * 20;
    }
    if (count) result += String.fromCharCode('F'.charCodeAt(0) + count);
    return result;
}

function compressRow(row: string): string {
    let output = '';
    for (let index = 0; index < row.length;) {
        const character = row[index];
        let count = 1;
        while (index + count < row.length && row[index + count] === character) count++;
        output += count >= 2 ? repeatCount(count) + character : character;
        index += count;
    }
    return output;
}

export function compressZplBitmap(mono: Uint8Array, bytesPerRow: number, height: number): string {
    let output = '';
    let previous = '';
    for (let row = 0; row < height; row++) {
        let hex = '';
        let allWhite = true;
        let allBlack = true;
        for (let column = 0; column < bytesPerRow; column++) {
            const value = mono[row * bytesPerRow + column];
            hex += HEX[value];
            if (value !== 0) allWhite = false;
            if (value !== 0xff) allBlack = false;
        }
        if (row > 0 && hex === previous) output += ':';
        else if (allWhite) output += ',';
        else if (allBlack) output += '!';
        else output += compressRow(hex);
        previous = hex;
    }
    return output;
}

function ascii(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

function concat(parts: Uint8Array[]): Uint8Array {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) { output.set(part, offset); offset += part.length; }
    return output;
}

export function encodeZplBitmap(
    bitmap: TauriRenderedBitmap,
    config: Record<string, unknown>,
    nativeBarcodeCommands: readonly string[] = [],
): Uint8Array {
    const total = bitmap.mono.length;
    const compressed = compressZplBitmap(bitmap.mono, bitmap.bytesPerRow, bitmap.heightDots);
    let stream = `^XA\n^PW${bitmap.widthDots}\n^LL${bitmap.heightDots}\n^PON\n`;
    if (config.darkness !== undefined) stream += `^MD${finite(config.darkness)}\n`;
    if (config.printSpeed !== undefined) stream += `^PR${finite(config.printSpeed)}\n`;
    stream += `^FO0,0^GFA,${total},${total},${bitmap.bytesPerRow},${compressed}^FS\n`;
    if (nativeBarcodeCommands.length) stream += nativeBarcodeCommands.join('');
    stream += '^XZ';
    const bytes = ascii(stream);
    if (bytes.length > MAX_OUTPUT_BYTES) throw new Error(`ZPL bitmap exceeds ${MAX_OUTPUT_BYTES} bytes`);
    return bytes;
}

export function encodeTsplBitmap(bitmap: TauriRenderedBitmap, config: Record<string, unknown>): Uint8Array {
    const dpi = finite(config.dpi, 203);
    const widthMm = bitmap.widthDots * 25.4 / dpi;
    const heightMm = bitmap.heightDots * 25.4 / dpi;
    const density = Math.max(0, Math.min(15, Math.round(finite(config.darkness, 15) / 2)));
    const speed = Math.max(1, Math.min(12, Math.round(finite(config.printSpeed, 4))));
    const gap = Math.max(0, finite(config.gapMm, 2));
    const prefix = ascii(`SIZE ${widthMm.toFixed(2)} mm,${heightMm.toFixed(2)} mm\r\nGAP ${gap} mm,0 mm\r\nSPEED ${speed}\r\nDENSITY ${density}\r\nCLS\r\nBITMAP 0,0,${bitmap.bytesPerRow},${bitmap.heightDots},0,`);
    const suffix = ascii('\r\nPRINT 1,1\r\n');
    const bytes = concat([prefix, bitmap.mono, suffix]);
    if (bytes.length > MAX_OUTPUT_BYTES) throw new Error(`TSPL bitmap exceeds ${MAX_OUTPUT_BYTES} bytes`);
    return bytes;
}

function ensureAdapterOutput(protocol: string, bytes: Uint8Array): Uint8Array {
    if (bytes.length === 0 || bytes.length > MAX_OUTPUT_BYTES) {
        throw new Error(`${protocol.toUpperCase()} raster must contain 1..${MAX_OUTPUT_BYTES} bytes`);
    }
    return bytes;
}

function monoHex(mono: Uint8Array): string {
    const chunks: string[] = new Array(mono.length);
    for (let index = 0; index < mono.length; index++) chunks[index] = HEX[mono[index]];
    return chunks.join('');
}

export function encodeEplBitmap(
    bitmap: TauriRenderedBitmap,
    config: Record<string, unknown>,
): Uint8Array {
    const dpi = finite(config.dpi, 203);
    const gapDots = Math.max(0, Math.round(finite(config.gapMm, 2) * dpi / 25.4));
    const prefix = ascii(
        `N\nq${bitmap.widthDots}\nQ${bitmap.heightDots},${gapDots}\n`
        + `GW0,0,${bitmap.bytesPerRow},${bitmap.heightDots},`,
    );
    return ensureAdapterOutput('epl', concat([prefix, bitmap.mono, ascii('\nP1\n')]));
}

export function encodeCpclBitmap(
    bitmap: TauriRenderedBitmap,
    config: Record<string, unknown>,
): Uint8Array {
    const dpi = Math.round(finite(config.dpi, 203));
    const stream = `! 0 ${dpi} ${dpi} ${bitmap.heightDots} 1\r\n`
        + `PAGE-WIDTH ${bitmap.widthDots}\r\n`
        + `EG ${bitmap.bytesPerRow} ${bitmap.heightDots} 0 0 ${monoHex(bitmap.mono)}\r\n`
        + 'FORM\r\nPRINT\r\n';
    return ensureAdapterOutput('cpcl', ascii(stream));
}

function writeU16(view: DataView, offset: number, value: number): void {
    view.setUint16(offset, value, true);
}

function writeU32(view: DataView, offset: number, value: number): void {
    view.setUint32(offset, value, true);
}

function encodeDplBmp8(bitmap: TauriRenderedBitmap, dpi: number): Uint8Array {
    const rowBytes = (bitmap.widthDots + 3) & ~3;
    const pixelBytes = rowBytes * bitmap.heightDots;
    const pixelOffset = 14 + 40 + 256 * 4;
    const fileSize = pixelOffset + pixelBytes;
    if (fileSize > MAX_OUTPUT_BYTES - 256) {
        throw new Error(`DPL BMP exceeds ${MAX_OUTPUT_BYTES - 256} bytes`);
    }
    const bmp = new Uint8Array(fileSize);
    const view = new DataView(bmp.buffer);
    bmp[0] = 0x42;
    bmp[1] = 0x4d;
    writeU32(view, 2, fileSize);
    writeU32(view, 10, pixelOffset);
    writeU32(view, 14, 40);
    writeU32(view, 18, bitmap.widthDots);
    writeU32(view, 22, bitmap.heightDots);
    writeU16(view, 26, 1);
    writeU16(view, 28, 8);
    writeU32(view, 34, pixelBytes);
    const pixelsPerMeter = Math.max(1, Math.round(dpi / 0.0254));
    writeU32(view, 38, pixelsPerMeter);
    writeU32(view, 42, pixelsPerMeter);
    writeU32(view, 46, 256);
    writeU32(view, 50, 2);
    for (let value = 0; value < 256; value++) {
        const palette = 54 + value * 4;
        bmp[palette] = value;
        bmp[palette + 1] = value;
        bmp[palette + 2] = value;
    }
    for (let sourceY = 0; sourceY < bitmap.heightDots; sourceY++) {
        const target = pixelOffset + (bitmap.heightDots - 1 - sourceY) * rowBytes;
        for (let x = 0; x < bitmap.widthDots; x++) {
            const source = bitmap.mono[sourceY * bitmap.bytesPerRow + (x >> 3)];
            bmp[target + x] = source & (0x80 >> (x & 7)) ? 0 : 255;
        }
        bmp.fill(255, target + bitmap.widthDots, target + rowBytes);
    }
    return bmp;
}

function fnv1a32(bitmap: TauriRenderedBitmap): number {
    let hash = 0x811c9dc5;
    const update = (value: number) => {
        hash ^= value & 0xff;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    };
    for (const value of bitmap.mono) update(value);
    for (const value of [bitmap.widthDots, bitmap.heightDots]) {
        update(value);
        update(value >>> 8);
        update(value >>> 16);
        update(value >>> 24);
    }
    return hash;
}

export function encodeDplBitmap(
    bitmap: TauriRenderedBitmap,
    config: Record<string, unknown>,
): Uint8Array {
    if (bitmap.widthDots > 9999 || bitmap.heightDots > 9999) {
        throw new Error('DPL raster dimensions must be in 1..9999 dots');
    }
    const name = `LP${fnv1a32(bitmap).toString(16).toUpperCase().padStart(8, '0')}`;
    const bmp = encodeDplBmp8(bitmap, Math.round(finite(config.dpi, 203)));
    const stx = '\x02';
    const download = ascii(`${stx}xD${name}\r${stx}IDb${name}\r`);
    const format = ascii(
        `\r${stx}L\rD11\r1Y1100000000000${name}\rQ0001\rE\r`,
    );
    return ensureAdapterOutput('dpl', concat([download, bmp, format]));
}

function sbplBlockHex(bitmap: TauriRenderedBitmap): string {
    const horizontalBlocks = Math.ceil(bitmap.widthDots / 8);
    const verticalBlocks = Math.ceil(bitmap.heightDots / 8);
    const output: string[] = new Array(horizontalBlocks * verticalBlocks * 8);
    let index = 0;
    for (let blockY = 0; blockY < verticalBlocks; blockY++) {
        for (let blockX = 0; blockX < horizontalBlocks; blockX++) {
            for (let row = 0; row < 8; row++) {
                const y = blockY * 8 + row;
                output[index++] = y < bitmap.heightDots
                    ? HEX[bitmap.mono[y * bitmap.bytesPerRow + blockX]]
                    : '00';
            }
        }
    }
    return output.join('');
}

export function encodeSbplBitmap(
    bitmap: TauriRenderedBitmap,
    _config: Record<string, unknown>,
): Uint8Array {
    const horizontalBlocks = Math.ceil(bitmap.widthDots / 8);
    const verticalBlocks = Math.ceil(bitmap.heightDots / 8);
    if (bitmap.widthDots > 9999 || bitmap.heightDots > 9999
        || horizontalBlocks > 999 || verticalBlocks > 999) {
        throw new Error('SBPL raster dimensions exceed command bounds');
    }
    const esc = '\x1b';
    const stream = `${esc}A`
        + `${esc}A1${String(bitmap.heightDots).padStart(4, '0')}${String(bitmap.widthDots).padStart(4, '0')}`
        + `${esc}H0000${esc}V0000`
        + `${esc}GH${String(horizontalBlocks).padStart(3, '0')}${String(verticalBlocks).padStart(3, '0')}`
        + sbplBlockHex(bitmap)
        + `${esc}Q1${esc}Z`;
    return ensureAdapterOutput('sbpl', ascii(stream));
}

export type PortableRasterProtocol = 'zpl' | 'image' | 'tspl' | 'epl' | 'cpcl' | 'dpl' | 'sbpl';

export function encodePortableRaster(
    protocol: PortableRasterProtocol,
    bitmap: TauriRenderedBitmap,
    config: Record<string, unknown>,
    nativeBarcodeCommands: readonly string[] = [],
): Uint8Array {
    switch (protocol) {
        case 'zpl':
        case 'image':
            return encodeZplBitmap(bitmap, config, nativeBarcodeCommands);
        case 'tspl':
            return encodeTsplBitmap(bitmap, config);
        case 'epl':
            return encodeEplBitmap(bitmap, config);
        case 'cpcl':
            return encodeCpclBitmap(bitmap, config);
        case 'dpl':
            return encodeDplBitmap(bitmap, config);
        case 'sbpl':
            return encodeSbplBitmap(bitmap, config);
    }
}

export function bytesToBase64(bytes: Uint8Array): string {
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
    }
    return btoa(chunks.join(''));
}
