export interface LabelElement {
    id: string;
    type: 'text' | 'rect' | 'barcode';
    x: number;
    y: number;
    w: number;
    h: number; // For barcodes, this is usually height, width is auto or w
    rotation?: number;

    // Text specific
    text?: string;
    fontFamily?: string;
    fontSize?: number;
    fontWeight?: number | string;
    fontStyle?: string;
    textAlign?: 'left' | 'center' | 'right' | 'justify';

    // Rect specific
    fill?: string;
    borderWidth?: number;
    borderColor?: string;
    borderRadius?: number; // ZPL supports some rounding

    // Barcode specific
    barcodeType?: string;
    value?: string;
    showText?: boolean;
}

export interface LabelDoc {
    canvas: {
        width: number;
        height: number;
        widthCm?: number;
        heightCm?: number;
        dpi?: number;
        background?: string;
    };
    dpi?: number;
    widthMm?: number;
    heightMm?: number;
    elements: LabelElement[];
}

export interface GeneratorOptions {
    dpi: 203 | 300 | 600;
    widthMm?: number;
    heightMm?: number;
    darkness?: number; // 0-30
    printSpeed?: number; // 2-12
}

export interface ILabelGenerator {
    generate(doc: LabelDoc, data: Record<string, any>, options: GeneratorOptions): Promise<Buffer>;
}
