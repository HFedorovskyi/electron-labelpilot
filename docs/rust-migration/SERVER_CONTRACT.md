# Контракт сервера и desktop-клиента

Источник инвентаризации: `D:\Antigravity_Workspaces\LabelPilot_Server` и текущий Electron-клиент. Сервер на этом этапе не изменяется.

## Основные адреса

| Назначение | Метод и путь | Направление |
|---|---|---|
| Ping станции | `GET /api/v1/stations/ping/?station_uuid=...` | клиент → сервер |
| Лицензия | `GET /api/v1/license/` | клиент → сервер |
| Отчёт станции | `POST /api/v1/stations/upload_report/` | клиент → сервер |
| Полная синхронизация | `POST http://<station>:5556/api/full_sync` | сервер → клиент |
| Последний sync loopback | `GET http://127.0.0.1:5556/api/full_sync` | клиент локально |
| Задание печати | `POST http://<station>:5556/api/print_job` | сервер → клиент |

Серверный API по умолчанию расположен на `http://<server>:8000/api/v1`.

## Envelope полной синхронизации

Корневой объект содержит три обязательные секции:

- `station`: `uuid`, `number`, `name`, `server_url`;
- `payload`: наборы master-data;
- `meta`: `type`, `generated_at` и опциональные версии.

Текущие поля payload:

- `operators`;
- `barcodes`;
- `labels`;
- `containers`;
- `nomenclature`;
- `global_attributes`;
- `product_pack_links`;
- `packs`.

Для импорта старых и demo-данных сохраняются aliases: `barcode_templates`, `label_templates`, `container`, `nomenclatures`, а также `station_number` в payload.

Metadata сервера:

- `type`;
- `format_version` (текущий сервер формирует `1.0`);
- `server_version`;
- `min_client_version`;
- `generated_at`.

Demo envelope может не содержать три version-поля. Parser это поддерживает, но всегда проверяет `type` и `generated_at`.

## Представление шаблонов

- Label serializer передаёт `structure` как JSON-строку для desktop-клиента.
- `scheme` остаётся объектом web-дизайнера.
- В структуре элемента поле `barcodeType` нормализуется сервером в `barcode_type`.
- Структура barcode template передаётся JSON-объектом.

## Защищённый контейнер

Полная синхронизация принимает текущий бинарный контейнер LPI2. Rust-реализация обязана совпасть с текущей реализацией по framing, проверке подписи, derivation и расшифровке. Совместимость проверяется общими бинарными fixtures в обоих направлениях; алгоритм и формат не меняются в ходе переноса.

Текущие входные лимиты клиента:

- full sync: 64 MB;
- print job: 1 MB.

Plain JSON допускается текущей реализацией только в состоянии без сохранённого token; это поведение переносится как явное правило совместимости.

## Транзакционные инварианты

1. Compatibility проверяется до записи в базу.
2. После первичной настройки UUID и номер станции заблокированы до reset database.
3. `server_url` обновляет адрес сервера в конфигурации.
4. Identity-файл, запись station и импорт payload относятся к одной логической операции.
5. Master-data импортируется транзакционно.
6. Ошибка декодирования, версии или схемы не оставляет частично обновлённые таблицы.

## Версионирование контракта

- Новые необязательные поля игнорируются.
- Изменение типа существующего поля считается несовместимым.
- Удаление обязательного поля требует новой `format_version`.
- `min_client_version` блокирует импорт до изменения локальных данных.
- Rust DTO содержит aliases до окончания периода совместимости.

## Автоматические проверки этапа 0

- `parseUnifiedSyncEnvelope` принимает текущий и demo/legacy envelope.
- Некорректные секции, типы и массивы отклоняются до processor/database.
- `parseServerPingResponse` проверяет типы полей ping.
- Тесты запускаются командой `npm run test:migration`.