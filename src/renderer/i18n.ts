import type { Lang } from '../shared/i18n_data';
import { translations } from '../shared/i18n_data';
export type { Lang };

const LANG_KEY = 'labelpilot_language';

export function getSavedLang(): Lang {
    return (localStorage.getItem(LANG_KEY) as Lang) || 'ru';
}

export function saveLang(lang: Lang): void {
    localStorage.setItem(LANG_KEY, lang);
    // Sync to main process config as well
    try {
        if (window.electron) {
            window.electron.invoke('get-printer-config').then((config: any) => {
                if (config) {
                    config.language = lang;
                    window.electron.send('save-printer-config', config);
                }
            });
        }
    } catch (e) {
        console.warn('Failed to sync language to main process config:', e);
    }
}

export function t(key: string, lang?: Lang): string {
    const l = lang || getSavedLang();
    const translation = translations[l]?.[key] || translations['en']?.[key] || key;
    return translation;
}

// React hook for components
import { useState as useReactState, useEffect as useReactEffect, useCallback } from 'react';

export function useTranslation() {
    const [lang, setLangState] = useReactState<Lang>(getSavedLang());

    useReactEffect(() => {
        const handler = () => setLangState(getSavedLang());
        window.addEventListener('lang-changed', handler);
        return () => window.removeEventListener('lang-changed', handler);
    }, []);

    const setLang = useCallback((newLang: Lang) => {
        saveLang(newLang);
        setLangState(newLang);
        window.dispatchEvent(new Event('lang-changed'));
    }, []);

    const translate = useCallback((key: string, params?: Record<string, string>) => {
        let text = t(key, lang);
        if (params) {
            Object.keys(params).forEach(p => {
                text = text.replace(`{${p}}`, params[p]);
            });
        }
        return text;
    }, [lang]);

    return { t: translate, lang, setLang };
}
