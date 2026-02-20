export interface BarcodeField {
    field_type: 'constanta' | 'constant' | 'ai' | 'weight' | 'weight_netto_pack' | 'weight_brutto_pack' | 'weight_netto_box' | 'weight_brutto_box' | 'weight_netto_pallet' | 'weight_brutto_pallet' | 'weight_brutto_all' | 'production_date' | 'exp_date' | 'article' | 'batch_number' | 'pack_number' | 'box_number' | 'pallet_number' | 'extra_data';
    value?: string;
    length?: string | number;
    decimalPlaces?: string | number;
    dateFormat?: string;
}

export interface BarcodeData {
    weight_netto_pack?: number; // kg
    weight_brutto_pack?: number; // kg
    weight_netto_box?: number; // kg
    weight_brutto_box?: number; // kg
    weight_netto_pallet?: number; // kg
    weight_brutto_pallet?: number; // kg
    production_date?: Date;
    exp_date?: Date;
    article?: string;
    batch_number?: string;
    pack_number?: string;
    box_number?: string;
    pallet_number?: string;
    [key: string]: any;
}

const formatDate = (date: Date, format: string): string => {
    const d = date;
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = String(d.getFullYear());
    const shortYear = year.slice(-2);

    // Simple replacement for common GS1 formats
    return format
        .replace('dd', day)
        .replace('MM', month)
        .replace('yy', shortYear)
        .replace('yyyy', year);
};

const formatWeight = (weight: number | undefined, length: number = 6, decimals: number = 3): string => {
    if (weight === undefined) return '0'.repeat(length);
    const multiplier = Math.pow(10, decimals);
    const value = Math.round(weight * multiplier);
    return String(value).padStart(length, '0');
};

const calculateGTIN14CheckDigit = (input: string): string => {
    // We expect a string of at least 13 digits. We take the first 13.
    const digits = input.padStart(13, '0').slice(-13).split('').map(Number);
    let sum = 0;
    // Weights for GTIN-14 (positions 1-13): 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3
    for (let i = 0; i < 13; i++) {
        sum += digits[i] * (i % 2 === 0 ? 3 : 1);
    }
    const checkDigit = (10 - (sum % 10)) % 10;
    return String(checkDigit);
};

export const generateBarcode = (fields: BarcodeField[], data: BarcodeData): string => {
    let barcode = '';

    fields.forEach(field => {
        try {
            switch (field.field_type) {
                case 'constanta':
                case 'constant': // Legacy/DB support
                    barcode += field.value || '';
                    break;
                case 'weight': // Legacy/DB support - defaults to weight_netto_pack or data.weight
                    const wValGeneric = data.weight !== undefined ? Number(data.weight) : (data.weight_netto_pack || 0);
                    const wLenGeneric = Number(field.length) || 5; // Default 5 for EAN13 weight
                    const wDecGeneric = Number(field.decimalPlaces) || 3;
                    barcode += formatWeight(wValGeneric, wLenGeneric, wDecGeneric);
                    break;
                case 'ai':
                    // GS1 AIs are typically surrounded by parens in human readable text, 
                    // but for raw data (Code128), parens are NOT encoded if using FNC1.
                    // However, many barcode renderers (like JsBarcode) expect raw data or specific format.
                    // If the user wants `(01)...` in text, usually that's separate.
                    // For the BARCODE VALUE passed to JsBarcode, we usually just concat the numbers?
                    // OR if using "CODE128", we might just dump the text.
                    // Let's assume for now we perform simple concatenation for the value.
                    // If brackets are needed for the renderer to parse AIs, we include them if the user specified them in value?
                    // Actually, the prompt says: "wraps in brackets for treepoem generator string"
                    // But "visually in barcode brackets are not encoded".
                    // JsBarcode doesn't support FNC1 automagically easily.
                    // Let's stick to the prompt's implied format: just append the value (e.g. "01")
                    // If the prompt said "wraps in brackets... but not encoded", it implies we might need to handle it.
                    // IMPORTANT: The prompt example: {"field_type": "ai", "value": "01"} -> (01)
                    // So we WILL add brackets.
                    barcode += `(${field.value})`;
                    break;
                case 'weight_netto_pack':
                case 'weight_brutto_pack':
                case 'weight_netto_box':
                case 'weight_brutto_box':
                case 'weight_netto_pallet':
                case 'weight_brutto_pallet':
                case 'weight_brutto_all':
                    const wType = field.field_type;
                    const wVal = data[wType];
                    const wLen = Number(field.length) || 6;
                    const wDec = Number(field.decimalPlaces) || 3;
                    barcode += formatWeight(wVal, wLen, wDec);
                    break;
                case 'production_date':
                    if (data.production_date) {
                        barcode += formatDate(data.production_date, field.dateFormat || 'yyMMdd');
                    }
                    break;
                case 'exp_date':
                    if (data.exp_date) {
                        barcode += formatDate(data.exp_date, field.dateFormat || 'yyMMdd');
                    }
                    break;
                case 'article':
                    const artLen = Number(field.length) || 14;
                    const baseArticle = (data.article || '');
                    if (artLen === 14) {
                        // For GTIN-14, we pad to 13 and calculate the 14th digit (check digit)
                        const padded13 = baseArticle.padStart(13, '0').slice(-13);
                        const checkDigit = calculateGTIN14CheckDigit(padded13);
                        barcode += padded13 + checkDigit;
                    } else {
                        barcode += baseArticle.padStart(artLen, '0');
                    }
                    break;
                case 'batch_number':
                    const batchLen = Number(field.length) || 0;
                    barcode += (data.batch_number || '').padStart(batchLen, '0');
                    break;
                case 'pack_number':
                    const packLen = Number(field.length) || 0;
                    barcode += (data.pack_number || '').padStart(packLen, '0');
                    break;
                case 'box_number':
                    const boxLen = Number(field.length) || 0;
                    barcode += (data.box_number || '').padStart(boxLen, '0');
                    break;
                case 'pallet_number':
                    const palletLen = Number(field.length) || 0;
                    barcode += (data.pallet_number || '').padStart(palletLen, '0');
                    break;
                case 'extra_data':
                    if (field.value) {
                        const extraValue = String(data[field.value] || '');
                        const extraLen = field.length ? Number(field.length) : 0;
                        if (extraLen > 0) {
                            barcode += extraValue.padStart(extraLen, '0').slice(0, extraLen);
                        } else {
                            barcode += extraValue;
                        }
                    }
                    break;
            }
        } catch (e) {
            console.error(`Error processing field ${field.field_type}:`, e);
        }
    });

    return barcode;
};
