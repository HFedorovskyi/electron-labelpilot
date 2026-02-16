import { loadPrinterConfig } from './config';
import type { Lang } from '../shared/i18n_data';
import { translations } from '../shared/i18n_data';

export function t(key: string, params?: Record<string, string>): string {
    const config = loadPrinterConfig();
    const lang = (config.language as Lang) || 'ru';

    let text = translations[lang]?.[key] || translations['en']?.[key] || key;

    if (params) {
        Object.keys(params).forEach(p => {
            text = text.replace(`{${p}}`, params[p]);
        });
    }

    return text;
}
