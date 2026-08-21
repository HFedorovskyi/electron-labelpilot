# Runtime benchmark: full Electron vs full Tauri

Дата измерения: 2026-08-21. Оба runtime загружают один и тот же production React/Vite UI, запускаются последовательно и используют отдельные пустые каталоги данных. Метрики включают всё дерево процессов, а не только корневой EXE.

Команда: npm run benchmark:runtimes

## Результаты

| Метрика | Tauri/Rust | Electron/Node | Изменение Tauri |
|---|---:|---:|---:|
| Cold start до main window | 216.7 ms | 1088.5 ms | быстрее на 80.1% |
| Median working set дерева | 405,897,216 B | 408,870,912 B | меньше на 0.7% |
| Median private bytes дерева | 281,423,872 B | 220,741,632 B | больше на 27.5% |
| Peak sampled private bytes | 316,452,864 B | 221,700,096 B | — |
| Idle CPU, нормализованный | 2.15% | 0.02% | — |
| Процессы | 7 | 4 | WebView2 создаёт больше служебных процессов |
| Потоки | 213 | 166 | — |
| Handles | 3,538 | 2,343 | — |
| Размер основного EXE | 20,452,864 B | 232,336,896 B | меньше на 91.2% |

Исходный JSON: artifacts/runtime-benchmark-phase-7-2/runtime-benchmark.json.

## Контрольные ворота слабого устройства

| Gate | Бюджет | Факт | Статус |
|---|---:|---:|---|
| Cold start | <= 2.5 s | 216.7 ms | PASS |
| Idle working set | <= 120 MiB | 387.1 MiB | FAIL |
| Ordinary peak private | <= 200 MiB | 301.8 MiB | FAIL |
| Idle CPU | <= 5% | 2.15% | PASS |

Tauri уже даёт быстрый запуск и компактную поставку, но переход оболочки сам по себе не решает память full UI. Основную долю дерева формируют WebView2 browser/renderer/GPU/network процессы. Переключение на Tauri как основной runtime остаётся закрытым до измерения на целевом 4 GB моноблоке и отдельной оптимизации renderer/WebView2.

## Методика

- production EXE, а не dev server;
- один и тот же UI и одинаковый пустой persisted state;
- порт 5556 проверяется до запуска;
- cold start фиксируется по появлению main window;
- после 8 секунд стабилизации берутся 5 выборок с интервалом 1 секунду;
- working/private bytes, CPU, handles и threads суммируются по дереву потомков;
- каждый процесс завершается по точному PID tree;
- изолированные каталоги сохраняются в JSON для воспроизводимости.
