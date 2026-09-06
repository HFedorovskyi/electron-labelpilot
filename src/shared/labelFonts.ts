export const LABEL_FONT_FAMILIES = [
    'Inter',
    'Roboto',
    'Arial',
    'Times New Roman',
    'Courier New',
    'Montserrat',
    'Ubuntu',
    'Georgia',
    'Verdana',
] as const;

export type LabelFontFamily = typeof LABEL_FONT_FAMILIES[number];

export const BUNDLED_LABEL_FONT_FILES = {
    Inter: {
        regular: 'Inter-Regular.ttf',
        bold: 'Inter-Bold.ttf',
    },
    Roboto: {
        variable: 'Roboto-Variable.ttf',
    },
    Montserrat: {
        variable: 'Montserrat-Variable.ttf',
    },
    Ubuntu: {
        regular: 'Ubuntu-Regular.ttf',
        bold: 'Ubuntu-Bold.ttf',
    },
} as const;

export const SYSTEM_LABEL_FONT_FAMILIES = [
    'Arial',
    'Times New Roman',
    'Courier New',
    'Georgia',
    'Verdana',
] as const;

export function normalizeLabelFontFamily(value: unknown, fallback = 'Inter'): string {
    const family = String(value || fallback).replaceAll('"', '').trim();
    return family || fallback;
}

export function labelFontStack(value: unknown, fallback = 'Inter'): string {
    const family = normalizeLabelFontFamily(value, fallback);
    if (family.includes(',')) return family;
    return '"' + family + '", "Arial", sans-serif';
}
