// i18n – lightweight translation system (RU / EN / DE)
// Usage: const t = useTranslation();  t('sidebar.weighing')

export type Lang = 'ru' | 'en' | 'de';

const translations: Record<Lang, Record<string, string>> = {
    ru: {
        // Sidebar
        'sidebar.weighing': 'Станция',
        'sidebar.products': 'Номенклатура',
        'sidebar.database': 'База данных',
        'sidebar.settings': 'Настройки',
        'sidebar.serverStatus': 'Статус сервера',
        'sidebar.connected': 'Подключено',

        // App
        'app.syncComplete': 'Синхронизация завершена',

        // Database
        'db.tables': 'Таблицы базы данных',
        'db.records': 'записей',
        'db.search': 'Поиск данных...',
        'db.noTable': 'Выберите таблицу для просмотра данных',

        // Settings
        'settings.title': 'Настройки',
        'settings.printer': 'Настройки принтера',
        'settings.packPrinter': 'Принтер для этикетки на упаковку',
        'settings.boxPrinter': 'Принтер для этикетки на короб',
        'settings.systemDefault': 'Системный по умолчанию',
        'settings.printerHint': 'TSC, Zebra, Honeywell, CAB и др.',
        'settings.refreshPrinters': 'Обновить список принтеров',
        'settings.autoPrint': 'Авто-печать по стабилизации',
        'settings.autoPrintDesc': 'Автоматическая печать этикетки при стабилизации показаний весов',
        'settings.scales': 'Настройки весов',
        'settings.connectionType': 'Тип интерфейса',
        'settings.serial': 'Serial Port (USB/COM)',
        'settings.tcp': 'Ethernet (TCP/IP)',
        'settings.simulator': 'Симулятор',
        'settings.port': 'Порт',
        'settings.refresh': 'Обновить',
        'settings.baudRate': 'Скорость (Baud)',
        'settings.ipAddress': 'IP Адрес',
        'settings.protocol': 'Протокол весов',
        'settings.connectionInterface': 'Интерфейс подключения',
        'settings.protocolSettings': 'Протокол и настройка',
        'settings.pollingMs': 'Опрос (мс)',
        'settings.stabilityCount': 'Стабильность (измерений)',
        'settings.save': 'Сохранить настройки',
        'settings.saved': 'Настройки сохранены',
        'settings.language': 'Язык интерфейса',
        'settings.portsNotFound': 'Порты не найдены',
        'settings.defaultMark': 'по умолч.',
        'settings.serverIp': 'IP-адрес сервера',
        'settings.serverIpPlaceholder': 'Например: 192.168.1.100',
        'settings.sync': 'Синхронизация',
        'settings.syncing': 'Загрузка...',
        'settings.testing': 'Проверка...',
        'settings.testConnection': 'Проверить соединение',
        'settings.connectionSuccess': 'Соединение успешно!',
        'settings.connectionFailed': 'Ошибка соединения',
        'settings.serverIpRequired': 'Укажите IP сервера',

        // WeighingStation
        'ws.title': 'Станция маркировки',
        'ws.selectProduct': 'Выберите продукт...',
        'ws.search': 'Поиск продукта...',
        'ws.noProducts': 'Товары не найдены',
        'ws.net': 'Нетто',
        'ws.gross': 'Брутто',
        'ws.kg': 'кг',
        'ws.stable': 'Стабильно',
        'ws.unstable': 'Нестабильно',
        'ws.print': 'ПЕЧАТЬ ЭТИКЕТКИ',
        'ws.printBox': 'ЗАКРЫТЬ КОРОБ',
        'ws.closeBox': 'Закрыть короб',
        'ws.session': 'Смена',
        'ws.unitsInBox': 'Упаковок в коробе',
        'ws.boxWeight': 'Вес короба',
        'ws.boxes': 'Коробов',
        'ws.total': 'Всего упаковок',
        'ws.lastPrinted': 'Последняя этикетка',
        'ws.reprint': 'Повторная печать',
        'ws.noLabel': 'Шаблон этикетки не найден',
        'ws.noBoxLabel': 'Шаблон этикетки короба не найден!',
        'ws.autoPrintActive': 'Авто-печать',
        'ws.printed': 'Напечатано',
        'ws.closeBoxBeforeChange': 'Пожалуйста, закройте текущий короб перед сменой товара.',
        'ws.errorPrefix': 'Ошибка',
        'ws.scaleStatus.connected': 'Подключено',
        'ws.scaleStatus.disconnected': 'Отключено',
        'ws.scaleStatus.connecting': 'Подключение...',
        'ws.scaleStatus': 'Статус весов',
        'ws.sessionStats': 'Статистика смены',
        'ws.packNum': 'Упаковка №:',
        'ws.boxNum': 'Короб №:',
        'ws.inBox': 'В коробе:',
        'ws.boxesOnPallet': 'Коробов на паллете:',
        'ws.totalUnits': 'Всего упаковок:',
        'ws.reprintSmall': 'Повтор',
        'ws.attention': 'Внимание',
        'ws.ok': 'ПОНЯТНО',
        'ws.stationNumber': 'Номер станции',

        // Products
        'products.title': 'Номенклатура',
        'products.search': 'Поиск по названию или артикулу...',
        'products.name': 'Наименование',
        'products.article': 'Артикул',
        'products.expDays': 'Срок годности (дней)',
        'products.packTare': 'Тара упаковки',
        'products.boxTare': 'Тара короба',
        'products.packLabel': 'Этикетка (упак.)',
        'products.boxLabel': 'Этикетка (короб)',
        'products.boxLimit': 'Лимит короба',
        'products.extraData': 'Доп. данные',
        'products.noProducts': 'Товары не найдены',
        'products.totalItems': 'Всего позиций',
        'products.gram': 'г',
        'products.yes': 'Да',
        'products.no': 'Нет',
    },

    en: {
        // Sidebar
        'sidebar.weighing': 'Station',
        'sidebar.products': 'Products',
        'sidebar.database': 'Database',
        'sidebar.settings': 'Settings',
        'sidebar.serverStatus': 'Server Status',
        'sidebar.connected': 'Connected',

        // App
        'app.syncComplete': 'Sync complete',

        // Database
        'db.tables': 'Database Tables',
        'db.records': 'records',
        'db.search': 'Search data...',
        'db.noTable': 'Select a table to view data',

        // Settings
        'settings.title': 'Settings',
        'settings.printer': 'Printer Settings',
        'settings.packPrinter': 'Pack label printer',
        'settings.boxPrinter': 'Box label printer',
        'settings.systemDefault': 'System default',
        'settings.printerHint': 'TSC, Zebra, Honeywell, CAB, etc.',
        'settings.refreshPrinters': 'Refresh printer list',
        'settings.autoPrint': 'Auto-print on stabilization',
        'settings.autoPrintDesc': 'Automatically print label when scale reading stabilizes',
        'settings.scales': 'Scale Settings',
        'settings.connectionType': 'Interface type',
        'settings.serial': 'Serial Port (USB/COM)',
        'settings.tcp': 'Ethernet (TCP/IP)',
        'settings.simulator': 'Simulator',
        'settings.port': 'Port',
        'settings.refresh': 'Refresh',
        'settings.baudRate': 'Baud Rate',
        'settings.ipAddress': 'IP Address',
        'settings.protocol': 'Scale Protocol',
        'settings.connectionInterface': 'Connection Interface',
        'settings.protocolSettings': 'Protocol & Configuration',
        'settings.pollingMs': 'Polling (ms)',
        'settings.stabilityCount': 'Stability (readings)',
        'settings.save': 'Save Settings',
        'settings.saved': 'Settings saved',
        'settings.language': 'Interface Language',
        'settings.portsNotFound': 'No ports found',
        'settings.defaultMark': 'default',
        'settings.serverIp': 'Server IP Address',
        'settings.serverIpPlaceholder': 'Example: 192.168.1.100',
        'settings.sync': 'Sync Data',
        'settings.syncing': 'Syncing...',
        'settings.testing': 'Testing...',
        'settings.testConnection': 'Test Connection',
        'settings.connectionSuccess': 'Connection Successful!',
        'settings.connectionFailed': 'Connection Failed',
        'settings.serverIpRequired': 'Server IP required',

        // WeighingStation
        'ws.title': 'Labeling Station',
        'ws.selectProduct': 'Select product...',
        'ws.search': 'Search product...',
        'ws.noProducts': 'No products found',
        'ws.net': 'Net',
        'ws.gross': 'Gross',
        'ws.kg': 'kg',
        'ws.stable': 'Stable',
        'ws.unstable': 'Unstable',
        'ws.print': 'PRINT LABEL',
        'ws.printBox': 'CLOSE BOX',
        'ws.closeBox': 'Close Box',
        'ws.session': 'Session',
        'ws.unitsInBox': 'Units in box',
        'ws.boxWeight': 'Box weight',
        'ws.boxes': 'Boxes',
        'ws.total': 'Total units',
        'ws.lastPrinted': 'Last printed',
        'ws.reprint': 'Reprint',
        'ws.autoPrintActive': 'Auto-print',
        'ws.printed': 'Printed',
        'ws.closeBoxBeforeChange': 'Please close the current box before changing product.',
        'ws.errorPrefix': 'Error',
        'ws.scaleStatus.connected': 'Connected',
        'ws.scaleStatus.disconnected': 'Disconnected',
        'ws.scaleStatus.connecting': 'Connecting...',
        'ws.scaleStatus': 'Scale Status',
        'ws.sessionStats': 'Session Statistics',
        'ws.packNum': 'Current Pack #:',
        'ws.boxNum': 'Current Box #:',
        'ws.inBox': 'In This Box:',
        'ws.boxesOnPallet': 'Boxes on Pallet:',
        'ws.totalUnits': 'Total Units:',
        'ws.reprintSmall': 'Reprint',
        'ws.attention': 'Attention',
        'ws.ok': 'OK, GOT IT',
        'ws.stationNumber': 'Station Number',

        // Products
        'products.title': 'Products',
        'products.search': 'Search by name or article...',
        'products.name': 'Name',
        'products.article': 'Article',
        'products.expDays': 'Shelf life (days)',
        'products.packTare': 'Pack tare',
        'products.boxTare': 'Box tare',
        'products.packLabel': 'Label (pack)',
        'products.boxLabel': 'Label (box)',
        'products.boxLimit': 'Box limit',
        'products.extraData': 'Extra data',
        'products.noProducts': 'No products found',
        'products.totalItems': 'Total items',
        'products.gram': 'g',
        'products.yes': 'Yes',
        'products.no': 'No',
    },

    de: {
        // Sidebar
        'sidebar.weighing': 'Station',
        'sidebar.products': 'Produkte',
        'sidebar.database': 'Datenbank',
        'sidebar.settings': 'Einstellungen',
        'sidebar.serverStatus': 'Serverstatus',
        'sidebar.connected': 'Verbunden',

        // App
        'app.syncComplete': 'Synchronisierung abgeschlossen',

        // Database
        'db.tables': 'Datenbanktabellen',
        'db.records': 'Datensätze',
        'db.search': 'Daten suchen...',
        'db.noTable': 'Wählen Sie eine Tabelle aus, um Daten anzuzeigen',

        // Settings
        'settings.title': 'Einstellungen',
        'settings.printer': 'Druckereinstellungen',
        'settings.packPrinter': 'Drucker für Packungsetikett',
        'settings.boxPrinter': 'Drucker für Karton-Etikett',
        'settings.systemDefault': 'Systemstandard',
        'settings.printerHint': 'TSC, Zebra, Honeywell, CAB usw.',
        'settings.refreshPrinters': 'Druckerliste aktualisieren',
        'settings.autoPrint': 'Automatischer Druck bei Stabilisierung',
        'settings.autoPrintDesc': 'Etikett автоматически drucken, wenn das Waagengewicht стабиль ist',
        'settings.scales': 'Waagen-Einstellungen',
        'settings.connectionType': 'Schnittstellentyp',
        'settings.serial': 'Serial Port (USB/COM)',
        'settings.tcp': 'Ethernet (TCP/IP)',
        'settings.simulator': 'Simulator',
        'settings.port': 'Port',
        'settings.refresh': 'Aktualisieren',
        'settings.baudRate': 'Baudrate',
        'settings.ipAddress': 'IP-Adresse',
        'settings.protocol': 'Waagen-Protokoll',
        'settings.connectionInterface': 'Verbindungsschnittstelle',
        'settings.protocolSettings': 'Protocol & Configuration',
        'settings.pollingMs': 'Abfrage (ms)',
        'settings.stabilityCount': 'Stabilität (Messungen)',
        'settings.save': 'Einstellungen speichern',
        'settings.saved': 'Einstellungen gespeichert',
        'settings.language': 'Oberflächensprache',
        'settings.portsNotFound': 'Keine Ports gefunden',
        'settings.defaultMark': 'Standard',
        'settings.serverIp': 'Server-IP-Adresse',
        'settings.serverIpPlaceholder': 'Beispiel: 192.168.1.100',
        'settings.sync': 'Synchronisieren',
        'settings.syncing': 'Laden...',
        'settings.testing': 'Prüfen...',
        'settings.testConnection': 'Verbindung testen',
        'settings.connectionSuccess': 'Verbindung erfolgreich!',
        'settings.connectionFailed': 'Verbindungsfehler',
        'settings.serverIpRequired': 'Server-IP erforderlich',

        // WeighingStation
        'ws.title': 'Etikettierstation',
        'ws.selectProduct': 'Produkt auswählen...',
        'ws.search': 'Produkt suchen...',
        'ws.noProducts': 'Keine Produkte gefunden',
        'ws.net': 'Netto',
        'ws.gross': 'Brutto',
        'ws.kg': 'kg',
        'ws.stable': 'Stabil',
        'ws.unstable': 'Instabil',
        'ws.print': 'DRUCKEN',
        'ws.printBox': 'KARTON SCHLIESSEN',
        'ws.closeBox': 'Karton schließen',
        'ws.session': 'Schicht',
        'ws.unitsInBox': 'Packungen im Karton',
        'ws.boxWeight': 'Kartongewicht',
        'ws.boxes': 'Kartons',
        'ws.total': 'Gesamt Packungen',
        'ws.lastPrinted': 'Zuletzt gedruckt',
        'ws.reprint': 'Nachdruck',
        'ws.autoPrintActive': 'Auto-Druck',
        'ws.printed': 'Gedruckt',
        'ws.closeBoxBeforeChange': 'Bitte schließen Sie den aktuellen Karton, bevor Sie das Produkt wechseln.',
        'ws.errorPrefix': 'Fehler',
        'ws.scaleStatus.connected': 'Verbunden',
        'ws.scaleStatus.disconnected': 'Getrennt',
        'ws.scaleStatus.connecting': 'Verbindung...',
        'ws.scaleStatus': 'Waagenstatus',
        'ws.sessionStats': 'Schichtstatistik',
        'ws.packNum': 'Packung №:',
        'ws.boxNum': 'Karton №:',
        'ws.inBox': 'Im Karton:',
        'ws.boxesOnPallet': 'Kartons auf Palette:',
        'ws.totalUnits': 'Gesamt Packungen:',
        'ws.reprintSmall': 'Wiederholung',
        'ws.attention': 'Achtung',
        'ws.ok': 'OK, VERSTANDEN',
        'ws.stationNumber': 'Stationsnummer',

        // Products
        'products.title': 'Produkte',
        'products.search': 'Suche nach Name oder Artikel...',
        'products.name': 'Bezeichnung',
        'products.article': 'Artikelnr.',
        'products.expDays': 'Haltbarkeit (Tage)',
        'products.packTare': 'Verp.-Tara',
        'products.boxTare': 'Karton-Tara',
        'products.packLabel': 'Etikett (Verp.)',
        'products.boxLabel': 'Etikett (Karton)',
        'products.boxLimit': 'Kartonlimit',
        'products.extraData': 'Zusatzdaten',
        'products.noProducts': 'Keine Produkte gefunden',
        'products.totalItems': 'Positionen gesamt',
        'products.gram': 'g',
        'products.yes': 'Ja',
        'products.no': 'Nein',
    },
};

const LANG_KEY = 'labelpilot_language';

export function getSavedLang(): Lang {
    return (localStorage.getItem(LANG_KEY) as Lang) || 'ru';
}

export function saveLang(lang: Lang): void {
    localStorage.setItem(LANG_KEY, lang);
}

export function t(key: string, lang?: Lang): string {
    const l = lang || getSavedLang();
    return translations[l]?.[key] || translations['en']?.[key] || key;
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

    const translate = useCallback((key: string) => t(key, lang), [lang]);

    return { t: translate, lang, setLang };
}
