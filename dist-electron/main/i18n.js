"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.t = t;
const config_1 = require("./config");
const i18n_data_1 = require("../shared/i18n_data");
function t(key, params) {
    const config = (0, config_1.loadPrinterConfig)();
    const lang = config.language || 'ru';
    let text = i18n_data_1.translations[lang]?.[key] || i18n_data_1.translations['en']?.[key] || key;
    if (params) {
        Object.keys(params).forEach(p => {
            text = text.replace(`{${p}}`, params[p]);
        });
    }
    return text;
}
