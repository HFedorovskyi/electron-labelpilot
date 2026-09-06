# Phase 7.2 — runtime qualification

Дата: 2026-08-21.

## Реализовано

- benchmark функционально одинаковых production Electron и Tauri UI;
- изолированный data directory для каждого запуска;
- cold start, process-tree working/private bytes, sampled peak, normalized CPU, process/thread/handle counts;
- машинно-проверяемые бюджеты из roadmap;
- параметризованный soak harness с 8 часами по умолчанию;
- native ZPL generation/send с уникальными idempotency keys;
- локальный TCP printer receiver с принудительным reconnect;
- TCP-весы and_standard, fragmented frames и принудительный reconnect;
- повторяющийся localhost GET /api/full_sync;
- итоговые native summaries печати, durable queue, generator, весов и ingress;
- тренд private/working memory и контроль роста;
- first-label, 100-label и full-sync latency.

## Короткая квалификация

Итоговый контрольный прогон:

node scripts/soak-tauri-runtime.cjs artifacts/printer-diagnostics-phase-7-1/labelpilot-tauri.exe artifacts/runtime-benchmark-phase-7-2/runtime-soak-short.json --duration-seconds=30 --print-interval-ms=250 --sync-interval-ms=2000 --snapshot-interval-ms=3000 --printer-disconnect-every=10 --scale-disconnect-every=10

Результат:

- 120/120 native ZPL jobs доставлены;
- 120/120 заданий приняты durable queue, failed/uncertain/rejected = 0;
- 12 printer TCP connections, reconnect подтверждён;
- 117 scale polls, 12 scale connections, reconnect подтверждён;
- 15/15 full-sync запросов, rejected = 0;
- first label: 9 ms после старта workload;
- 100 labels: 25,000 ms при намеренном интервале 250 ms;
- print command p50/p95/max: 4.26/6.23/8.22 ms;
- full-sync p50/p95/max: 20.09/32.41/32.47 ms;
- private memory growth: +2,076,672 B;
- working set growth: +5,517,312 B;
- normalized CPU под нагрузкой: 2.71%;
- все 16 soak gates: PASS.

JSON: artifacts/runtime-benchmark-phase-7-2/runtime-soak-short.json.

## Автоматические проверки

- migration contracts: PASS;
- Rust: 89 passed, 0 failed;
- runtime qualification source contract: PASS;
- full Electron production unpacked build: PASS;
- short Tauri runtime soak: PASS.

## Решение gate

Функциональная стабильность печати/весов/reconnect/sync и отсутствие краткосрочного роста памяти подтверждены. Строгий idle/peak memory budget full UI не пройден, поэтому canary и удаление Electron ещё не активируются.

Следующий срез Phase 7.3:

1. профилирование renderer heap и WebView2 process roles на целевой 4 GB станции;
2. перенос оставшихся тяжёлых barcode/bitmap операций из WebView;
3. дополнительное lazy-loading экранов и ресурсов;
4. повтор benchmark;
5. полный 8-часовой soak после прохождения memory gate.
