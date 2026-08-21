# РџРѕСЌС‚Р°РїРЅС‹Р№ РїРµСЂРµС…РѕРґ desktop-РєР»РёРµРЅС‚Р° РЅР° Rust

## Р¦РµР»СЊ

РЎРѕС…СЂР°РЅРёС‚СЊ React/Vite-РёРЅС‚РµСЂС„РµР№СЃ Рё РІРµСЃСЊ С‚РµРєСѓС‰РёР№ С„СѓРЅРєС†РёРѕРЅР°Р», Р·Р°РјРµРЅСЏСЏ Electron main/preload РЅР° Rust/Tauri РїРѕСЃС‚РµРїРµРЅРЅРѕ. РЎРµСЂРІРµСЂРЅС‹Р№ API, Р»РѕРєР°Р»СЊРЅС‹Рµ РґР°РЅРЅС‹Рµ Рё РєРѕРјР°РЅРґС‹ UI СЃРЅР°С‡Р°Р»Р° С„РёРєСЃРёСЂСѓСЋС‚СЃСЏ РєРѕРЅС‚СЂР°РєС‚Р°РјРё; РєР°Р¶РґС‹Р№ РЅРѕРІС‹Р№ Rust-РјРѕРґСѓР»СЊ РІРєР»СЋС‡Р°РµС‚СЃСЏ РѕС‚РґРµР»СЊРЅРѕ Рё РёРјРµРµС‚ Р±С‹СЃС‚СЂС‹Р№ РІРѕР·РІСЂР°С‚ РЅР° Electron.

## Р‘Р°Р·РѕРІС‹Рµ РѕРіСЂР°РЅРёС‡РµРЅРёСЏ

- Р Р°Р±РѕС‡РёРµ СЃС‚Р°РЅС†РёРё: 1366x768, С‚Р°С‡СЃРєСЂРёРЅ, СЃР»Р°Р±С‹Рµ CPU Рё 4 GB RAM.
- Р¤РѕСЂРјР°С‚ РґР°РЅРЅС‹С… СЃРµСЂРІРµСЂР° Рё СЃСѓС‰РµСЃС‚РІСѓСЋС‰РёРµ СѓСЃС‚Р°РЅРѕРІРєРё РѕСЃС‚Р°СЋС‚СЃСЏ СЃРѕРІРјРµСЃС‚РёРјС‹РјРё.
- РџРµС‡Р°С‚СЊ РЅРµ Р±Р»РѕРєРёСЂСѓРµС‚ UI; РѕС‡РµСЂРµРґРё РёРјРµСЋС‚ backpressure Рё РѕРіСЂР°РЅРёС‡РµРЅРЅС‹Р№ РїР°СЂР°Р»Р»РµР»РёР·Рј.
- РЎРµС‚РµРІС‹Рµ, РїРѕСЃР»РµРґРѕРІР°С‚РµР»СЊРЅС‹Рµ Рё С„Р°Р№Р»РѕРІС‹Рµ РѕРїРµСЂР°С†РёРё РІС‹РїРѕР»РЅСЏСЋС‚СЃСЏ РІРЅРµ UI-РїРѕС‚РѕРєР°.
- РћРґРёРЅ СѓСЃС‚Р°РЅРѕРІС‰РёРє EXE; РїРѕСЃР»Рµ РїРµСЂРµРєР»СЋС‡РµРЅРёСЏ Electron/Node РЅРµ РІС…РѕРґСЏС‚ РІ С„РёРЅР°Р»СЊРЅС‹Р№ РїР°РєРµС‚.
- РџРµСЂРµС…РѕРґ РЅРµ РјРµРЅСЏРµС‚ РјР°РєРµС‚С‹, С€Р°Р±Р»РѕРЅС‹, РїРѕРґРґРµСЂР¶РёРІР°РµРјС‹Рµ С€С‚СЂРёС…РєРѕРґС‹ Рё РїСЂРѕС‚РѕРєРѕР»С‹ РїСЂРёРЅС‚РµСЂРѕРІ.

## Р­С‚Р°Рї 0 вЂ” Р·Р°С„РёРєСЃРёСЂРѕРІР°С‚СЊ РєРѕРЅС‚СЂР°РєС‚С‹ (С‚РµРєСѓС‰РёР№)

Р РµР·СѓР»СЊС‚Р°С‚:

- РµРґРёРЅС‹Р№ `DesktopBridge` СЃРѕ СЃРїРёСЃРєРѕРј invoke/send/event-РєР°РЅР°Р»РѕРІ;
- С‚РёРїРёР·РёСЂРѕРІР°РЅРЅС‹Р№ Рё РїСЂРѕРІРµСЂСЏРµРјС‹Р№ envelope РїРѕР»РЅРѕР№ СЃРёРЅС…СЂРѕРЅРёР·Р°С†РёРё;
- РїСЂРѕРІРµСЂСЏРµРјС‹Р№ РѕС‚РІРµС‚ ping СЃРµСЂРІРµСЂР°;
- Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєРёРµ С‚РµСЃС‚С‹ РґСЂРµР№С„Р° IPC Рё СЃС…РµРјС‹ СЃРёРЅС…СЂРѕРЅРёР·Р°С†РёРё;
- РєР°СЂС‚Р° С„СѓРЅРєС†РёР№ Рё СЃРµСЂРІРµСЂРЅС‹С… С‚РѕС‡РµРє РёРЅС‚РµРіСЂР°С†РёРё.

РљСЂРёС‚РµСЂРёР№ РІС‹С…РѕРґР°: Electron-СЃР±РѕСЂРєР° Рё РїСЂРµР¶РЅРёРµ printer-С‚РµСЃС‚С‹ РїСЂРѕС…РѕРґСЏС‚, РЅРѕРІС‹Р№ bridge РґРѕСЃС‚СѓРїРµРЅ РєР°Рє `window.desktopBridge`, СЃС‚Р°СЂС‹Р№ `window.electron` РїСЂРѕРґРѕР»Р¶Р°РµС‚ СЂР°Р±РѕС‚Р°С‚СЊ.

## Р­С‚Р°Рї 1 вЂ” РїР°СЂР°Р»Р»РµР»СЊРЅР°СЏ Rust/Tauri-РѕР±РѕР»РѕС‡РєР°

1. РЎРѕР·РґР°С‚СЊ `src-tauri` Р±РµР· СѓРґР°Р»РµРЅРёСЏ Electron.
2. РџРѕРґРєР»СЋС‡РёС‚СЊ СЃСѓС‰РµСЃС‚РІСѓСЋС‰РёР№ `dist` РєР°Рє frontendDist Рё Vite dev server РІ СЂР°Р·СЂР°Р±РѕС‚РєРµ.
3. Р РµР°Р»РёР·РѕРІР°С‚СЊ Rust-РєРѕРјР°РЅРґС‹ `get-version`, `quit-app`, `open-logs-folder`, Р»РѕРіРёСЂРѕРІР°РЅРёРµ Рё СЃРѕР±С‹С‚РёСЏ.
4. Р”РѕР±Р°РІРёС‚СЊ Tauri-Р°РґР°РїС‚РµСЂ, СЂРµР°Р»РёР·СѓСЋС‰РёР№ С‚РѕС‚ Р¶Рµ `DesktopBridge`.
5. РџРµСЂРµРІРµСЃС‚Рё РѕРґРёРЅ РЅРёР·РєРѕСЂРёСЃРєРѕРІС‹Р№ СЌРєСЂР°РЅ РЅР° `getDesktopBridge()`.

РљСЂРёС‚РµСЂРёР№ РІС‹С…РѕРґР°: РѕРґРёРЅР°РєРѕРІС‹Рµ РѕС‚РІРµС‚С‹ smoke-С‚РµСЃС‚РѕРІ РІ Electron Рё Tauri; РѕС‚РґРµР»СЊРЅС‹Рµ РєРѕРјР°РЅРґС‹ СЃР±РѕСЂРєРё Рё Р·Р°РїСѓСЃРєР° РѕР±РµРёС… РѕР±РѕР»РѕС‡РµРє.

## Р­С‚Р°Рї 2 вЂ” РєРѕРЅС„РёРіСѓСЂР°С†РёСЏ, РёРґРµРЅС‚РёС‡РЅРѕСЃС‚СЊ Рё СЃРµС‚РµРІРѕР№ РєРѕРЅС‚СѓСЂ

1. РџРµСЂРµРЅРµСЃС‚Рё С‡С‚РµРЅРёРµ/Р·Р°РїРёСЃСЊ РєРѕРЅС„РёРіСѓСЂР°С†РёРё, identity Рё numbering РІ Rust СЃ Р°С‚РѕРјР°СЂРЅРѕР№ Р·Р°РїРёСЃСЊСЋ.
2. РџРµСЂРµРЅРµСЃС‚Рё ping, license Рё server-status/discovery.
3. РџРѕРґРЅСЏС‚СЊ Р»РѕРєР°Р»СЊРЅС‹Р№ HTTP listener РЅР° РїРѕСЂС‚Сѓ 5556 СЃ С‚РµРєСѓС‰РёРјРё Р»РёРјРёС‚Р°РјРё Р·Р°РїСЂРѕСЃРѕРІ.
4. Р РµР°Р»РёР·РѕРІР°С‚СЊ byte-for-byte СЃРѕРІРјРµСЃС‚РёРјРѕСЃС‚СЊ РєРѕРЅС‚РµР№РЅРµСЂР° LPI2 Рё РїСЂРѕРІРµСЂСЏС‚СЊ fixtures РѕР±РµРёРјРё СЂРµР°Р»РёР·Р°С†РёСЏРјРё.
5. РћСЃС‚Р°РІРёС‚СЊ Electron-РјР°СЂС€СЂСѓС‚ РєР°Рє selectable backend РґРѕ РѕРєРѕРЅС‡Р°РЅРёСЏ soak-С‚РµСЃС‚Р°.

РљСЂРёС‚РµСЂРёР№ РІС‹С…РѕРґР°: РѕРґРёРЅР°РєРѕРІР°СЏ РѕР±СЂР°Р±РѕС‚РєР° РєРѕСЂСЂРµРєС‚РЅС‹С…, СѓСЃС‚Р°СЂРµРІС€РёС…, РїРѕРІСЂРµР¶РґС‘РЅРЅС‹С… Рё СЃР»РёС€РєРѕРј Р±РѕР»СЊС€РёС… СЃРѕРѕР±С‰РµРЅРёР№.

## Р­С‚Р°Рї 3 вЂ” SQLite, СЃРёРЅС…СЂРѕРЅРёР·Р°С†РёСЏ Рё Р·Р°РґР°РЅРёСЏ

1. Р—Р°С„РёРєСЃРёСЂРѕРІР°С‚СЊ schema-version Рё РјРёРіСЂР°С†РёРё С‚РµРєСѓС‰РµР№ SQLite Р±Р°Р·С‹.
2. РџРµСЂРµРЅРµСЃС‚Рё С‚СЂР°РЅР·Р°РєС†РёРѕРЅРЅС‹Р№ full sync Рё station identity lock.
3. РџРµСЂРµРЅРµСЃС‚Рё print jobs, pallets, boxes, packs, counters Рё outbox reports.
4. Р”РѕР±Р°РІРёС‚СЊ С‚РµСЃС‚ РјРёРіСЂР°С†РёРё РєРѕРїРёРё СЂРµР°Р»СЊРЅРѕР№ Р±Р°Р·С‹ Рё crash-recovery.
5. РЎСЂР°РІРЅРёРІР°С‚СЊ РІС‹Р±РѕСЂРєРё Electron/Rust РЅР° РѕРґРЅРѕРј fixture.

РљСЂРёС‚РµСЂРёР№ РІС‹С…РѕРґР°: РЅСѓР»РµРІРѕРµ СЂР°СЃС…РѕР¶РґРµРЅРёРµ РґР°РЅРЅС‹С…; РѕС‚РєР°С‚ Р·Р°РїСѓСЃРєР°РµС‚ СЃС‚Р°СЂСѓСЋ РѕР±РѕР»РѕС‡РєСѓ РЅР° С‚РѕР№ Р¶Рµ Р±Р°Р·Рµ Р±РµР· РєРѕРЅРІРµСЂС‚Р°С†РёРё РЅР°Р·Р°Рґ.

## Р­С‚Р°Рї 4 вЂ” РІРµСЃС‹ Рё РїРµСЂРёС„РµСЂРёСЏ

1. РџРµСЂРµРЅРµСЃС‚Рё serial discovery/open/read/reconnect Рё TCP-РІРµСЃС‹.
2. РЎРѕС…СЂР°РЅРёС‚СЊ С‚РµРєСѓС‰РёРµ РїСЂРѕС‚РѕРєРѕР»С‹ С‡РµСЂРµР· РѕР±С‰РёР№ trait `ScaleProtocol`.
3. РћРіСЂР°РЅРёС‡РёС‚СЊ Р±СѓС„РµСЂС‹ Рё С‡Р°СЃС‚РѕС‚Сѓ UI-СЃРѕР±С‹С‚РёР№; РёСЃРєР»СЋС‡РёС‚СЊ Р±РµСЃРєРѕРЅС‚СЂРѕР»СЊРЅС‹Рµ С„РѕРЅРѕРІС‹Рµ Р·Р°РґР°С‡Рё.
4. Р”РѕР±Р°РІРёС‚СЊ Р·Р°РїРёСЃСЊ/РІРѕСЃРїСЂРѕРёР·РІРµРґРµРЅРёРµ РїРѕС‚РѕРєРѕРІ СѓСЃС‚СЂРѕР№СЃС‚РІ РґР»СЏ С‚РµСЃС‚РѕРІ Р±РµР· РѕР±РѕСЂСѓРґРѕРІР°РЅРёСЏ.

РљСЂРёС‚РµСЂРёР№ РІС‹С…РѕРґР°: reconnect, partial frames, disconnect Рё РґР»РёС‚РµР»СЊРЅС‹Р№ soak СЂР°Р±РѕС‚Р°СЋС‚ РЅР° РєР°Р¶РґРѕРј СЃРµРјРµР№СЃС‚РІРµ СѓСЃС‚СЂРѕР№СЃС‚РІ.

## Р­С‚Р°Рї 5 вЂ” РїРµС‡Р°С‚СЊ Рё С€С‚СЂРёС…РєРѕРґС‹

1. РџРµСЂРµРЅРµСЃС‚Рё transport-СЃР»РѕР№: Windows spooler, raw TCP 9100 Рё serial.
2. РЎРѕС…СЂР°РЅРёС‚СЊ РіРµРЅРµСЂР°С‚РѕСЂС‹ ZPL/TSPL Рё bitmap fallback РєР°Рє РЅРµР·Р°РІРёСЃРёРјС‹Рµ backend-СЃС‚СЂР°С‚РµРіРёРё.
3. РќР° РїРµСЂРµС…РѕРґРµ РѕСЃС‚Р°РІРёС‚СЊ `bwip-js` РІ WebView worker; Р·Р°С‚РµРј РґРѕР±Р°РІРёС‚СЊ Rust/native backend РЅР° Р±Р°Р·Рµ libzint РґР»СЏ 1D/2D-РєРѕРґРѕРІ.
4. РЎРѕС…СЂР°РЅРёС‚СЊ Р·Р°РіСЂСѓР·РєСѓ С€СЂРёС„С‚РѕРІ/РіСЂР°С„РёРєРё С‚РѕР»СЊРєРѕ РїРѕСЃР»Рµ capability detection; РёСЃРїРѕР»СЊР·РѕРІР°С‚СЊ RAM/cache printers СЃ fallback.
5. Р’РІРµСЃС‚Рё golden-С„Р°Р№Р»С‹ РєРѕРјР°РЅРґ РґР»СЏ 203/300/600 DPI Рё РїСЂРѕС„РёР»СЊРЅСѓСЋ РјР°С‚СЂРёС†Сѓ РґРµС€С‘РІС‹С…/РїСЂРѕРјС‹С€Р»РµРЅРЅС‹С… РјРѕРґРµР»РµР№.

РљСЂРёС‚РµСЂРёР№ РІС‹С…РѕРґР°: РѕРґРёРЅР°РєРѕРІР°СЏ РіРµРѕРјРµС‚СЂРёСЏ Рё СЃРѕРґРµСЂР¶РёРјРѕРµ С€С‚СЂРёС…РєРѕРґРѕРІ, РѕС‚СЃСѓС‚СЃС‚РІРёРµ СЂРµРіСЂРµСЃСЃРёРё СЃРєРѕСЂРѕСЃС‚Рё first-label/steady-state, СѓСЃРїРµС€РЅС‹Рµ С‚РµСЃС‚С‹ РЅР° С„РёР·РёС‡РµСЃРєРѕРј РїР°СЂРєРµ.

## Р­С‚Р°Рї 6 вЂ” РѕР±РЅРѕРІР»РµРЅРёРµ, РёРјРїРѕСЂС‚/СЌРєСЃРїРѕСЂС‚ Рё СѓРїР°РєРѕРІРєР°

1. РџРµСЂРµРЅРµСЃС‚Рё online/offline update, backup list Рё rollback.
2. РџРµСЂРµРЅРµСЃС‚Рё USB/offline import/export Рё РґРёР°Р»РѕРіРё РІС‹Р±РѕСЂР° С„Р°Р№Р»РѕРІ.
3. РќР°СЃС‚СЂРѕРёС‚СЊ signed NSIS/MSI РёР»Рё Tauri NSIS build РІ РµРґРёРЅС‹Р№ EXE.
4. РџСЂРѕРІРµСЂРёС‚СЊ РѕР±РЅРѕРІР»РµРЅРёРµ РїРѕРІРµСЂС… СЃСѓС‰РµСЃС‚РІСѓСЋС‰РµР№ Electron-СѓСЃС‚Р°РЅРѕРІРєРё СЃ СЃРѕС…СЂР°РЅРµРЅРёРµРј Р±Р°Р·С‹, РЅР°СЃС‚СЂРѕРµРє Рё identity.

РљСЂРёС‚РµСЂРёР№ РІС‹С…РѕРґР°: install/update/rollback РїСЂРѕС…РѕРґСЏС‚ РЅР° С‡РёСЃС‚РѕР№ Рё СЂР°Р±РѕС‡РµР№ СЃС‚Р°РЅС†РёРё.

## Р­С‚Р°Рї 7 вЂ” РѕРїС‚РёРјРёР·Р°С†РёСЏ Рё РїРµСЂРµРєР»СЋС‡РµРЅРёРµ

1. РЎРЅСЏС‚СЊ РѕРґРёРЅР°РєРѕРІС‹Р№ benchmark РЅР° С†РµР»РµРІРѕРј СЃР»Р°Р±РѕРј СѓСЃС‚СЂРѕР№СЃС‚РІРµ: cold start, idle RAM, peak RAM, CPU, first label, 100 labels, full sync.
2. РЈСЃС‚СЂР°РЅРёС‚СЊ РєРѕРїРёРё Р±РѕР»СЊС€РёС… bitmap/JSON, РІРєР»СЋС‡РёС‚СЊ bounded queues Рё РєСЌС€ СЃ Р»РёРјРёС‚РѕРј.
3. РџСЂРѕРІРµСЃС‚Рё 8-С‡Р°СЃРѕРІРѕР№ soak СЃ РїРµС‡Р°С‚СЊСЋ, РІРµСЃР°РјРё, reconnect Рё sync.
4. Р’С‹РїСѓСЃС‚РёС‚СЊ canary, Р·Р°С‚РµРј РїРµСЂРµРєР»СЋС‡РёС‚СЊ Tauri РєР°Рє РѕСЃРЅРѕРІРЅРѕР№ runtime.
5. РЈРґР°Р»РёС‚СЊ Electron С‚РѕР»СЊРєРѕ РїРѕСЃР»Рµ РїРµСЂРёРѕРґР° РЅР°Р±Р»СЋРґРµРЅРёСЏ; rollback-РїР°РєРµС‚ С…СЂР°РЅРёС‚СЊ РјРёРЅРёРјСѓРј РѕРґРёРЅ СЂРµР»РёР·.

## Р РµСЃСѓСЂСЃРЅС‹Рµ РєРѕРЅС‚СЂРѕР»СЊРЅС‹Рµ Р·РЅР°С‡РµРЅРёСЏ

Р­С‚Рѕ С†РµР»Рё РґР»СЏ РёР·РјРµСЂРµРЅРёСЏ РЅР° РєР°СЃСЃРѕРІРѕРј РјРѕРЅРѕР±Р»РѕРєРµ, Р° РЅРµ РѕС†РµРЅРєРё РїРѕ desktop-СЂР°Р·СЂР°Р±РѕС‚РєРµ:

- idle working set: РЅРµ Р±РѕР»РµРµ 120 MB;
- peak РїСЂРё РѕР±С‹С‡РЅРѕР№ РїРµС‡Р°С‚Рё: РЅРµ Р±РѕР»РµРµ 200 MB;
- С…РѕР»РѕРґРЅС‹Р№ СЃС‚Р°СЂС‚ РґРѕ РіРѕС‚РѕРІРѕРіРѕ UI: РЅРµ Р±РѕР»РµРµ 2.5 s;
- UI event-loop: Р±РµР· Р·Р°РґР°С‡ РґРѕР»СЊС€Рµ 50 ms;
- РѕС‡РµСЂРµРґСЊ РїРµС‡Р°С‚Рё Рё bitmap-cache: СЃС‚СЂРѕРіРѕ РѕРіСЂР°РЅРёС‡РµРЅС‹ РєРѕРЅС„РёРіСѓСЂР°С†РёРµР№;
- steady-state throughput РЅРµ РЅРёР¶Рµ С‚РµРєСѓС‰РµРіРѕ Electron-РєР»РёРµРЅС‚Р°.

## РЎС‚СЂР°С‚РµРіРёСЏ РѕС‚РєР°С‚Р°

РљР°Р¶РґС‹Р№ СЌС‚Р°Рї РґРѕР±Р°РІР»СЏРµС‚ backend Р·Р° feature flag. Р‘Р°Р·Р° Рё С„Р°Р№Р»С‹ РѕСЃС‚Р°СЋС‚СЃСЏ РІ СЃРѕРІРјРµСЃС‚РёРјРѕРј С„РѕСЂРјР°С‚Рµ. РўРѕС‡РєР° РїРµСЂРµРєР»СЋС‡РµРЅРёСЏ С…СЂР°РЅРёС‚СЃСЏ РІ launcher/config; РѕС‚РєР°С‚ РјРµРЅСЏРµС‚ runtime, Р° РЅРµ РїРѕР»СЊР·РѕРІР°С‚РµР»СЊСЃРєРёРµ РґР°РЅРЅС‹Рµ. РЈРґР°Р»РµРЅРёРµ РїСЂРµР¶РЅРµР№ СЂРµР°Р»РёР·Р°С†РёРё РІС‹РїРѕР»РЅСЏРµС‚СЃСЏ С‚РѕР»СЊРєРѕ РЅР° СЃР»РµРґСѓСЋС‰РµРј СЌС‚Р°РїРµ РїРѕСЃР»Рµ РїРѕРґС‚РІРµСЂР¶РґС‘РЅРЅРѕРіРѕ РїР°СЂРёС‚РµС‚Р°.
## РЎС‚Р°С‚СѓСЃ РІС‹РїРѕР»РЅРµРЅРёСЏ

- Р­С‚Р°Рї 0: Р·Р°РІРµСЂС€С‘РЅ вЂ” server envelope, ping Рё desktop IPC Р·Р°С„РёРєСЃРёСЂРѕРІР°РЅС‹ TypeScript/Rust С‚РµСЃС‚Р°РјРё.
- Р­С‚Р°Рї 1.1: Р·Р°РІРµСЂС€С‘РЅ вЂ” РїР°СЂР°Р»Р»РµР»СЊРЅР°СЏ Tauri 2 РѕР±РѕР»РѕС‡РєР°, РѕС‚РґРµР»СЊРЅС‹Р№ Vite entrypoint Рё РїРµСЂРІС‹Рµ РєРѕРјР°РЅРґС‹ `updater:get-version`, `open-logs-folder`, `log-to-main`, `quit-app`.
- РЎР»РµРґСѓСЋС‰РёР№ СЃСЂРµР·: РєРѕРЅС„РёРіСѓСЂР°С†РёСЏ, identity Рё numbering СЃ С‡С‚РµРЅРёРµРј СЃСѓС‰РµСЃС‚РІСѓСЋС‰РёС… С„Р°Р№Р»РѕРІ Р±РµР· РёР·РјРµРЅРµРЅРёСЏ persisted schema.

РџСЂРµРґРІР°СЂРёС‚РµР»СЊРЅРѕРµ СЃСЂР°РІРЅРµРЅРёРµ runtime РЅР°С…РѕРґРёС‚СЃСЏ РІ `RUNTIME_BENCHMARK.md`.

## Phase 2 implementation status (2026-08-13)

- Phase 2.1 complete: scale, numbering and printer configuration persistence is implemented in Rust with unchanged JSON schemas.
- Identity is SQLite-first with JSON fallback; the database is opened read-only in this slice.
- Offline sequence generation uses an atomic, mutex-serialized read/increment/write path.
- 12 desktop operations are now backed by Rust (5 invoke channels, 3 persisted send channels, and the 4 phase-1 runtime operations).
- Next: phase 2.2 server ping, discovery, license/status polling and local HTTP ingress.

## Phase 2.2a implementation status (2026-08-13)

- Outbound ping, license retrieval and adaptive server-status polling are implemented in Rust.
- UDP discovery uses one bounded worker, protocol port 5555, 4 KiB datagrams and three-second announcements.
- Five additional desktop channels are backed by Rust: `sync-data`, `get-server-status`, `get-license-status`, `set-app-mode`, `renderer-ready`.
- The Tauri runtime now reports 17 migrated desktop operations plus the native diagnostic command.
- Next: phase 2.2b local HTTP ingress on port 5556, processor handoff and LPI2 parity fixtures.

## Phase 2.2b implementation status (2026-08-13)

- Local HTTP ingress :5556 is implemented with one bounded native worker, 16 KiB headers, 64 MiB sync and 1 MiB print-job caps.
- LPI2 framing, Ed25519 verification, license-derived HKDF-SHA256 and AES-256-CBC decoding are implemented with a shared Node/Rust fixture.
- Transactional master-data sync, station identity lock and online print-job persistence are implemented in Rust.
- The Tauri runtime now exposes 20 Rust commands, including network and ingress diagnostics.
- Next: phase 3 operational SQLite paths (pallets, boxes, packs, counters and reports/outbox) plus crash-recovery parity.
## Phase 3.1 implementation status (2026-08-14)

- Operational SQLite ownership is implemented in Rust for packs, boxes, pallets, counters, deletions and pallet render aggregation.
- The repository keeps one process-lifetime SQLite connection and short transactions for low-resource POS hardware.
- Barcode value generation supports all 19 current/legacy production field variants and regenerates after box-number collision resolution.
- Operator credentials and the current operator session are implemented with Django PBKDF2-SHA256 parity and the existing logout gate.
- 12 additional desktop channels are mapped to Rust; the Tauri scaffold now exposes 32 commands.
- 33 Rust tests pass, including 1,000 pack records through one connection and a read/write/delete migration test on an isolated Electron database copy.
- Reports/outbox continue through Electron until their Rust delivery activation contract is frozen.
- Next: phase 4 scale transports and recorded-stream replay.
## Phase 4.1 implementation status (2026-08-14)

- Serial discovery, serial/TCP/simulator transport ownership, polling, bounded decoding, stability filtering and reconnect are implemented in Rust.
- All 20 existing scale protocol profiles pass the same recorded Electron/Rust replay corpus.
- The public scale IPC/event contract is unchanged; the Tauri runtime now exposes 38 Rust commands and 34 migrated user-facing desktop operations.
- TCP loopback and release EXE smoke verify fragmented frames, disconnect detection and reconnect; a 20,000-frame soak verifies the 64 KiB decoder bound.
- Electron scale transport remains the immediate rollback path while the physical device qualification matrix is populated.
- Next: phase 5 printer transports and generation parity, beginning with raw TCP 9100 and bounded print queues.
## Phase 5.1 implementation status (2026-08-14)

- Raw TCP 9100 printer delivery is implemented in Rust with one bounded FIFO queue per physical endpoint.
- Limits are explicit for low-resource workstations: 16 jobs per printer, 12 workers process-wide and 16 MiB per raw job.
- Connect/write timeouts are 3 seconds; non-persistent sockets close after 400 ms; persistent sockets are reused; one retry and a 5-second circuit breaker bound failures.
- Four staging commands expose raw send, warmup, diagnostics and disconnect without replacing the legacy print-label contract yet.
- Release EXE smoke delivered two ordered ZPL jobs from two logical roles over one reused TCP connection; all 50 Rust tests pass.
- Electron transport and ZPL/TSPL/bitmap generation remain the rollback path.
- Next: phase 5.2 generator orchestration and golden byte/geometric parity, followed by public print-label routing.

## Phase 5.2 implementation status (2026-08-14)

- Native ZPL and TSPL/TSPL2 generation is implemented in Rust for profile-supported text, rectangles and printer-native barcode commands.
- Shared 203/300 DPI golden fixtures match the current TypeScript generators byte-for-byte; geometry is also tested at 600 DPI.
- Unsupported or complex elements are routed explicitly to the retained Electron bitmap backend with deterministic reasons.
- Generation is bounded to 1,024 elements, 8 MiB input and 16 MiB output and runs off the UI thread for low-resource POS terminals.
- Four generator staging commands bring the Tauri runtime to 46 Rust commands; direct generate-and-send avoids a renderer Base64 round trip.
- Release EXE smoke generated and delivered exact ZPL and TSPL streams over one reused TCP connection; all 57 Rust tests pass.
- Next: phase 5.3 public print-label orchestration, serial printer transport and Windows spooler adapter.

## Phase 5.3 implementation status (2026-08-14)

- The public print-label bridge now asks the Rust planner for every job and routes eligible labels directly through Rust generation and transport.
- Unsupported or complex documents lazily load the renderer Canvas bitmap backend; ZPL uses GFA, TSPL uses binary BITMAP, and Windows driver printing uses a 1-bit GDI DIB.
- Rust transport coverage now includes TCP 9100, persistent Serial 8N1 and Windows spooler RAW/GDI, including the configured or system-default printer.
- Weak-device startup remains compact: the public orchestrator is about 2.1 KiB, the bitmap module about 9.6 KiB, and bwip-js stays in a separate on-demand chunk.
- The Tauri runtime exposes 48 registered Rust commands and 35 migrated user-facing operations.
- Release smoke sent one native ZPL job plus ZPL and TSPL bitmap fallbacks through the public API: 14,377 total bytes, one reused TCP connection, zero failures.
- All 58 Rust tests and the migration, printer, public-routing, scale, raw printer, native generator and ingress checks pass.
- Next: physical qualification across representative Serial, Windows GDI/RAW and TCP printer families, then phase 6 packaging/updater work.
## Phase 6 implementation status (2026-08-14)

- The current React/Vite design is retained unchanged; lifecycle work is isolated to the desktop bridge and Rust runtime.
- Seventeen updater, offline file, USB, demo and reset operations now execute through registered Rust commands.
- Online updates use the official signed Tauri updater; offline EXE/MSI installation creates the same bounded backup first.
- Backups retain the three newest snapshots and restore before SQLite opens; outbox data is merged so queued reports are not lost.
- Identity, sync, print-job and report workflows use native file dialogs; USB envelopes are versioned, bounded and HMAC authenticated.
- The release pipeline produces one current-user NSIS EXE, detached signature, `latest.json`, checksums and an independent signature verification.
- Final gates: renderer build passed, migration parity passed, 67 Rust tests passed, and the signed NSIS artifact passed minisign verification.
- Next: representative physical printer/scale qualification and controlled rollout telemetry; UI redesign remains deferred.
## Phase 7.2 implementation status (2026-08-21)

- Full production Electron and Tauri runtimes are now benchmarked sequentially with isolated data directories and complete process-tree metrics.
- Tauri cold start is 216.7 ms and the main EXE is 20.45 MB; both cold-start and idle-CPU gates pass.
- Full UI memory gates remain open: 405.9 MB median working set and 316.5 MB sampled peak private bytes on the development workstation.
- The parameterized soak defaults to 8 hours and covers native ZPL print, durable queue, printer reconnect, TCP scale reconnect, localhost full-sync and resource trends.
- A 30-second qualification completed 120/120 prints, 15/15 full-sync requests and all reconnect/resource-integrity gates with zero failed, rejected or uncertain print jobs.
- Canary activation remains pending renderer/WebView2 memory optimization and the full 8-hour run on target 4 GB hardware.

## Phase 7.3 implementation status (2026-08-21)

- Operating stations and closed modal implementations are split from the startup graph; the main App chunk decreased from 252.81 KiB to 127.65 KiB.
- The release smoke starts with only the weighing station loaded, retains a station after its first visit, and reports a 2.50 MiB post-GC JavaScript heap.
- The benchmark now forces both full production runtimes to 1366×768; Tauri measures 242.6 ms cold start, 404.8 MB median working set, and 281.7 MB median private bytes.
- Against the same final UI, Tauri is 75.3% faster to start, 91.2% smaller on disk, 8.5% lower in working set, and 16.5% lower in private bytes than Electron.
- Disabling GPU acceleration was rejected by measurement because it increased working set by approximately 120 MiB and selected WARP software rendering.
- The final short soak completed 120/120 prints, 15/15 sync requests, all reconnects, and all 16 integrity/resource gates; 89/89 Rust tests pass.
- Next: the eight-hour soak on representative 4 GB / 1366×768 hardware, followed by physical-device matrix qualification and canary activation.

## Phase 7.4 implementation status (2026-08-21)

- Production telemetry is now native in Tauri: structured events, runtime heartbeat and printer/scale/ingress/renderer error capture use the server-compatible `StationLog` report contract.
- Encrypted `.lpr` delta reports use durable cursors, atomic outbox storage, startup/periodic/reconnect retry and a final shutdown spool.
- Outbox/report/event sizes and per-cycle work are bounded for weak POS workstations; an outbox overflow never advances the cursor.
- Missing station identity or license is explicitly counted and leaves production rows pending in SQLite.
- Diagnostic summary/flush commands and automated Rust/Node contract tests gate the release.
- Remaining deployment work is the eight-hour 4 GB hardware soak and physical printer/scale qualification matrix; these do not change telemetry delivery ownership.

## Phase 8 implementation status (2026-08-21)

- The production repository now has one Tauri/WebView2 runtime, one renderer entrypoint and one `window.desktopBridge` surface.
- Node desktop backend, preload, hidden print worker, Electron packaging/scripts/dependencies and dual-runtime CI were removed.
- Complex-label fallback is renderer-owned (`renderer-bitmap`); printer transport, durable queue, telemetry, updater and lifecycle remain Rust-owned.
- The legacy application identifier, data directory and repository URL remain stable solely for deployed-station upgrade/data compatibility.
- Build, migration contracts, full Rust tests, signed NSIS verification and telemetry runtime smoke are the release gates.