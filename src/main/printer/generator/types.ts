export interface TableColumn {
    id: string;
    key: string;        // row field key resolved per item, e.g. 'name', 'weight_brutto_pack'
    title: string;      // column header (may wrap)
    widthRatio: number; // percent of table width (columns sum ≈ 100)
}

export interface LabelElement {
    id: string;
    type: 'text' | 'rect' | 'barcode' | 'table';
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
    verticalAlign?: 'top' | 'middle' | 'bottom'; // Vertical alignment within the element box
    color?: string;
    textDecoration?: string;

    // Rect specific
    fill?: string;
    borderWidth?: number;
    borderColor?: string;
    borderRadius?: number; // ZPL supports some rounding

    // Barcode specific
    barcodeType?: string;
    value?: string;
    showText?: boolean;
    imageData?: string; // Pre-rendered barcode image from server
    moduleWidth?: number; // Explicit module width for barcodes

    // Table specific (labelType 'pallet'). A table is data-driven (data.items) and is
    // therefore always rendered dynamically — never baked into the cached static layer.
    columns?: TableColumn[];
    groupBy?: 'none' | 'nomenclature' | 'batch';
    sortBy?: 'none' | 'name' | 'date';
    showHeaders?: boolean;
    showBorders?: boolean;
    maxRows?: number;
}

export interface LabelDoc {
    canvas: {
        width: number;
        height: number;
        widthCm?: number;
        heightCm?: number;
        dpi?: number;
        background?: string;
        printedZones?: {
            id: string;
            label: string;
            side: string;
            sizeMm: number;
            color?: string;
        }[];
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
    // Identifies the physical printer instance — used to scope the BG cache
    // so a hash uploaded to printer A isn't assumed present on printer B.
    printerId?: string;
    // 'ram'    → use ~DG + R: + ^XG (default, Zebra ZPL II).
    // 'inline' → embed static layer as ^GFA in every job (safe for any ZPL-compatible).
    // Determined by RamCacheCoordinator; the generator just executes the decision.
    cacheMode?: 'ram' | 'inline';
}

export interface ILabelGenerator {
    generate(doc: LabelDoc, data: Record<string, any>, options: GeneratorOptions): Promise<Buffer>;
}
