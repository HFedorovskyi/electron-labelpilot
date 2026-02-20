import type { ILabelGenerator, LabelDoc, GeneratorOptions, LabelElement } from './types';

export class ZplGenerator implements ILabelGenerator {

    async generate(doc: LabelDoc, data: Record<string, any>, options: GeneratorOptions): Promise<Buffer> {
        console.log('ZplGenerator: Incoming doc:', JSON.stringify(doc, null, 2));
        console.log('ZplGenerator: Options:', JSON.stringify(options, null, 2));

        const dpi = options.dpi || doc.dpi || 203;

        // 1. Determine Physical Dimensions (MM)
        // Priority: 
        // 1. Root widthMm/heightMm (Manual override or direct property)
        // 2. Options widthMm/heightMm (Printer config override)
        // 3. Canvas widthCm/heightCm (From visual editor)
        // 4. Fallback to calculating from canvas pixels assuming 96 DPI (Legacy/Web)

        let targetWidthMm = doc.widthMm || options.widthMm;
        let targetHeightMm = doc.heightMm || options.heightMm;

        if (!targetWidthMm && doc.canvas?.widthCm) {
            targetWidthMm = doc.canvas.widthCm * 10;
        }
        if (!targetHeightMm && doc.canvas?.heightCm) {
            targetHeightMm = doc.canvas.heightCm * 10;
        }

        // 2. Determine Scale Factor
        // If we know the physical size, we calculate scale to fit the canvas into that size.
        // If we don't, we assume the canvas is 1:1 with the printer dots (if DPI matches) or scaled from screen (96 DPI).

        let printWidth: number;
        let labelLength: number;
        let scaleX: number = 1;
        let scaleY: number = 1;

        if (targetWidthMm) {
            // Case A: We have physical dimensions.
            printWidth = Math.round(targetWidthMm * dpi / 25.4);
            // If canvas.width is just dots at 96 DPI or some arbitrary number, we scale it to fit the print width.
            if (doc.canvas.width > 0) {
                scaleX = printWidth / doc.canvas.width;
            }
        } else {
            // Case B: No physical dimensions. Infer from canvas.
            const sourceDpi = doc.canvas?.dpi || 96; // Default to screen DPI if not specified

            // If source is 203 DPI and target is 203 DPI, scale should be 1.
            // If source is 96 DPI and target is 203 DPI, scale is 203/96.
            scaleX = dpi / sourceDpi;

            printWidth = Math.round(doc.canvas.width * scaleX);
        }

        if (targetHeightMm) {
            labelLength = Math.round(targetHeightMm * dpi / 25.4);
            if (doc.canvas.height > 0) {
                scaleY = labelLength / doc.canvas.height;
            }
        } else {
            // Scale height using same ratio as width if height not specified
            scaleY = scaleX;
            labelLength = Math.round(doc.canvas.height * scaleY);
        }

        console.log(`ZplGenerator: DPI=${dpi}, TargetWidthMm=${targetWidthMm}, TargetHeightMm=${targetHeightMm}, CanvasW=${doc.canvas.width}, CanvasH=${doc.canvas.height}`);
        console.log(`ZplGenerator: Calculated PrintWidth=${printWidth}, LabelLength=${labelLength}, ScaleX=${scaleX.toFixed(4)}, ScaleY=${scaleY.toFixed(4)}`);

        let zpl = '^XA\n'; // Start Format
        zpl += `^PW${printWidth}\n`; // Print Width
        zpl += `^LL${labelLength}\n`; // Label Length
        zpl += '^PON\n'; // Print Orientation Normal

        // Darkness (0-30)
        if (options.darkness !== undefined) {
            zpl += `^MD${options.darkness}\n`;
        }

        // Speed (2-12)
        if (options.printSpeed !== undefined) {
            zpl += `^PR${options.printSpeed}\n`;
        }

        zpl += '^CI28\n'; // UTF-8 Encoding support

        for (const el of doc.elements) {
            zpl += await this.processElement(el, data, scaleX, scaleY);
        }

        zpl += '^XZ'; // End Format
        return Buffer.from(zpl, 'utf-8');
    }

    private async processElement(el: LabelElement, data: Record<string, any>, scaleX: number, scaleY: number): Promise<string> {
        // Variable substitution
        const processText = (text: string) => {
            if (!text) return '';

            // Prepare a lowercase map for case-insensitive lookup
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

        const x = Math.round(el.x * scaleX);
        const y = Math.round(el.y * scaleY);

        // Rotation mapping
        // N = 0, R = 90, I = 180, B = 270
        let orient = 'N';
        if (el.rotation === 90) orient = 'R';
        else if (el.rotation === 180) orient = 'I';
        else if (el.rotation === 270) orient = 'B';

        let cmd = `^FO${x},${y}`;

        switch (el.type) {
            case 'text':
                const textVal = processText(el.text || '');
                const fontSize = el.fontSize || 12;
                const h = Math.round(fontSize * scaleY);
                const w = el.w ? Math.round(el.w * scaleX) : undefined;

                // Native ZPL font with alignment support via ^FB
                if (w) {
                    let justification = 'L';
                    if (el.textAlign === 'center') justification = 'C';
                    else if (el.textAlign === 'right') justification = 'R';

                    // Allow up to 20 lines by default for blocks. 
                    // ZPL requires \& for manual line breaks in ^FB mode.
                    const processedText = textVal.replace(/\n/g, '\\&');

                    // ^FB width, maxLines, lineSpacing, justification, hangingIndent
                    cmd += `^FB${w},20,0,${justification},0`;
                    cmd += `^A0${orient},${h},${h}^FD${processedText}^FS\n`;
                } else {
                    // Simple text line
                    cmd += `^A0${orient},${h},${h}^FD${textVal}^FS\n`;
                }
                break;

            case 'rect':
                let wRect = Math.round(el.w * scaleX);
                let hRect = Math.round(el.h * scaleY);
                const border = Math.round((el.borderWidth || 1) * scaleX);
                const radius = Math.round((el.borderRadius || 0) * scaleX);

                // For a Box, ZPL doesn't strictly rotate the box shape with a flag in ^GB.
                // However, we can swap W/H if we want to "rotate" the frame itself.
                // But ^FO sets the top-left corner.
                if (orient === 'R' || orient === 'B') {
                    const temp = wRect;
                    wRect = hRect;
                    hRect = temp;
                }

                if (el.fill && el.fill !== 'transparent') {
                    // Filled Black Rectangle
                    cmd += `^GB${wRect},${hRect},${hRect},B,${radius}^FS\n`;
                } else {
                    // Border only
                    cmd += `^GB${wRect},${hRect},${border},B,${radius}^FS\n`;
                }
                break;

            case 'barcode':
                const bcVal = processText(el.value || '');
                const height = Math.round(el.h * scaleY);
                const moduleWidth = Math.max(2, Math.round(2 * (scaleX / 2.1)));

                const type = (el.barcodeType || 'code128').toLowerCase();

                if (type.includes('code128')) {
                    // ^BC o, h, f, g, e, m
                    const showText = el.showText ? 'Y' : 'N';
                    cmd += `^BY${moduleWidth},3.0,${height}`;
                    cmd += `^BC${orient},${height},${showText},N,N^FD${bcVal}^FS\n`;
                } else if (type.includes('qr') || type === 'gs-1') {
                    // ^BQ o, 2, mag
                    const magnification = Math.max(3, Math.round(scaleX * 2));
                    cmd += `^BQ${orient},2,${magnification}`;
                    cmd += `^FDQA,${bcVal}^FS\n`;
                } else if (type.includes('ean13') || type.includes('ean13_kz')) {
                    const showText = el.showText ? 'Y' : 'N';
                    cmd += `^BY${moduleWidth},3.0,${height}`;
                    cmd += `^BE${orient},${height},${showText},N^FD${bcVal}^FS\n`;
                } else if (type.includes('datamatrix')) {
                    const mag = Math.max(3, Math.round(scaleX * 2));
                    cmd += `^BX${orient},${mag},200`;
                    cmd += `^FD${bcVal}^FS\n`;
                } else {
                    // Fallback to Code 128
                    cmd += `^BY${moduleWidth},3.0,${height}`;
                    cmd += `^BC${orient},${height},Y,N,N^FD${bcVal}^FS\n`;
                }
                break;
        }

        return cmd;
    }
}
