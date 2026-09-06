# РњР°С‚СЂРёС†Р° С„СѓРЅРєС†РёРѕРЅР°Р»СЊРЅРѕРіРѕ РїР°СЂРёС‚РµС‚Р°

РЎС‚Р°С‚СѓСЃС‹: **current** вЂ” СЂР°Р±РѕС‚Р°РµС‚ РІ Electron; **contracted** вЂ” РєРѕРЅС‚СЂР°РєС‚ Р·Р°С„РёРєСЃРёСЂРѕРІР°РЅ; **planned** вЂ” РїРµСЂРµРЅРѕСЃ РЅРµ РЅР°С‡Р°С‚; **gate** вЂ” СѓСЃР»РѕРІРёРµ РІРєР»СЋС‡РµРЅРёСЏ Rust backend.

| РћР±Р»Р°СЃС‚СЊ | Electron | Rust target | РџСЂРѕРІРµСЂРєР° РїР°СЂРёС‚РµС‚Р° | Gate |
|---|---|---|---|---|
| React/Vite UI | current | С‚РѕС‚ Р¶Рµ bundle РІ WebView | build + РІРёР·СѓР°Р»СЊРЅС‹Р№ smoke 1366x768 | Р±РµР· РёР·РјРµРЅРµРЅРёСЏ СЌРєСЂР°РЅРѕРІ |
| Desktop invoke IPC | 59 РєР°РЅР°Р»РѕРІ | Tauri commands | Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєРёР№ inventory drift test | РІСЃРµ РєРѕРјР°РЅРґС‹ СЃРѕРїРѕСЃС‚Р°РІР»РµРЅС‹ |
| Desktop send IPC | 11 РєР°РЅР°Р»РѕРІ | Tauri commands/events | Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєРёР№ inventory drift test | РІСЃРµ РєРѕРјР°РЅРґС‹ СЃРѕРїРѕСЃС‚Р°РІР»РµРЅС‹ |
| Desktop events | 19 РєР°РЅР°Р»РѕРІ | Tauri emit/listen | producer/consumer inventory test | payload parity |
| Legacy `window.electron` | current | РІСЂРµРјРµРЅРЅС‹Р№ alias | preload smoke | СЃРѕС…СЂР°РЅСЏРµС‚СЃСЏ РґРѕ РјРёРіСЂР°С†РёРё UI |
| Unified sync schema | current | serde DTO | current + demo + malformed fixtures | contracted |
| Server ping/version | current | reqwest client | response fixtures | contracted |
| LPI2 full sync | current | Rust crypto/container | РґРІСѓРЅР°РїСЂР°РІР»РµРЅРЅС‹Рµ binary fixtures | byte parity |
| Local HTTP :5556 | current | axum/hyper listener | full_sync/print_job integration | limits + status parity |
| Identity lock | current | Rust storage service | mismatch/reset cases | error parity |
| SQLite master data | current | rusqlite/sqlx | snapshot diff | zero row diff |
| Packs/boxes/pallets | current | Rust repository | transaction/recovery tests | zero state diff |
| Print jobs | current | Rust service | progress/complete/delete/import | event + DB parity |
| Reports/outbox | current rollback | implemented native Rust worker | delta/retry/license/outbox fixtures | cursor advances only after send or durable spool |
| Config/numbering | current | Rust atomic store | round-trip corpus | same persisted schema |
| Discovery/server status | current | Rust async tasks | recorded network fixtures | bounded tasks |
| Serial/TCP scales | current rollback | implemented Rust worker | 20 shared fixtures + TCP release-smoke + 20k-frame soak | software parity; physical certification pending |
| Windows printers | current rollback | implemented Rust RAW/GDI spooler | missing-queue test + release build; physical device matrix pending | explicit queue and system-default printer supported |
| Raw TCP 9100 | current rollback | implemented Rust transport | loopback order/reuse/idle/refused tests + release EXE smoke | bounded: 16 jobs/printer, 12 workers, 16 MiB/job |
| Serial printers | current rollback | implemented persistent serialport 8N1 transport | config/queue tests; physical device matrix pending | 300..4,000,000 baud, one retry |
| ZPL generator | current rollback | implemented native staging path | shared TypeScript/Rust golden streams | 203/300/600 DPI geometry; exact native bytes |
| TSPL/TSPL2 generator | current rollback | implemented native staging path | shared TypeScript/Rust golden streams | exact native bytes; complex text uses explicit fallback |
| Bitmap fallback | renderer retained | implemented lazy Canvas handoff to Rust transport | public release smoke: ZPL GFA + TSPL BITMAP | bounded 8M pixels/16 MiB and lazy bwip-js |
| Pallet table footer | designer preview indicator | implemented canonical draw-table port (body limit + footer band) | unit: truncation counts, footer text, body limit pixels | "Стр. 1/N · показано X из N" honest indicator; multi-page buffers deferred by contract |
| Sort/group/maxRows tables | designer preview grouping | implemented sortBy/maxRows/groupBy with wrapped headers and variable row heights | unit: group label, ru sort order, cell padStart | mirrors server reference draw-table.ts |
| Rotated text raster | canvas center rotation | implemented quarter-turn raster rotation around element center | unit: 0/90/180/45 pixel bounding boxes | non-quarter angles keep the unrotated layout |
| Serial status probe | separate COM open | routed through the holding print worker when one owns the port | unit: routed vs direct error paths; breaker bypass | Windows exclusive COM access honored; direct probe kept for unconfigured devices |
| Barcode generation | bwip-js | hybrid, Р·Р°С‚РµРј libzint | decode + geometry corpus | symbology parity |
| Printer fonts/cache | current capability path | Rust capability strategy | warm/cold printer tests | safe fallback |
| Online updater | current | Tauri updater/service | signed staging release | install + rollback |
| Offline updater | current | Rust file workflow | package corpus | backup + rollback |
| USB import/export | current | Rust file workflow | round-trip hashes | format parity |
| Demo mode | current | Rust dataset loader | deterministic snapshot | UI parity |
| Logging | current rollback | rolling file + structured server telemetry | rotation/event/heartbeat/error-capture tests | bounded local storage and idempotent upload |
| Packaging | Electron NSIS/portable | Tauri NSIS/MSI EXE | clean VM install | data preserved |
| Low-resource behavior | current baseline pending | optimized target | fixed hardware benchmark | resource budgets met |

## РЎС‡С‘С‚С‡РёРє РєРѕРЅС‚СЂР°РєС‚Р° СЌС‚Р°РїР° 0

- invoke: 59;
- send: 11;
- events: 19;
- server envelope sections: 3;
- РѕР±СЏР·Р°С‚РµР»СЊРЅС‹Рµ station fields: 4;
- РѕР±СЏР·Р°С‚РµР»СЊРЅС‹Рµ metadata fields: 2, РїР»СЋСЃ 3 version-РїРѕР»СЏ СЃРµСЂРІРµСЂР°.

РџРѕР»РЅС‹Р№ РјР°С€РёРЅРЅРѕ-РїСЂРѕРІРµСЂСЏРµРјС‹Р№ РїРµСЂРµС‡РµРЅСЊ РєР°РЅР°Р»РѕРІ РЅР°С…РѕРґРёС‚СЃСЏ РІ `src/shared/desktopBridge.ts`; С‚РµСЃС‚ РЅР°РјРµСЂРµРЅРЅРѕ РїР°РґР°РµС‚ РїСЂРё РґРѕР±Р°РІР»РµРЅРёРё РєР°РЅР°Р»Р° С‚РѕР»СЊРєРѕ РІ main РёР»Рё renderer Р±РµР· РѕР±РЅРѕРІР»РµРЅРёСЏ РєРѕРЅС‚СЂР°РєС‚Р°.

## Implemented parity checkpoint: phase 2.1

| Contract | Rust status | Verification |
|---|---|---|
| Scale config | persisted | shared fixture + validation + atomic write |
| Numbering config | persisted | shared fixture + validation + atomic write |
| Printer config | persisted | shared fixture + legacy 58x40 migration + event emission |
| Identity read | persisted | read-only SQLite-first + JSON fallback test |
| Next sequence | persisted | format parity + 32-thread uniqueness + durable counter |

Hardware side effects triggered by config saves remain assigned to the scale and printer transport phases; this checkpoint covers file/identity/sequence state only.

## Implemented parity checkpoint: phase 2.2a

| Contract | Rust status | Verification |
|---|---|---|
| Server ping/version | implemented | strict response fixtures + UUID query + exact compatibility reason |
| License status | implemented | endpoint fixture + complete object preservation |
| Adaptive server status | implemented | 5s/15s/60s cadence + status event shape |
| UDP discovery | implemented | server/station parsing + source-IP normalization + 4 KiB bound |
| Network IPC | implemented | five bridge mappings + Rust registration drift test |
| Local HTTP :5556 | implemented | bounded listener + transactional processor + LPI2 handoff |

The network path uses one named native worker and one pooled idle HTTP connection per host to fit weak POS terminals.

## Implemented parity checkpoint: phase 3.1

| Contract | Rust status | Verification |
|---|---|---|
| Packs/boxes/pallets | implemented | transactional create/close/delete/rehoming tests |
| Counters/render data | implemented | JSON field and aggregation assertions |
| Barcode value fields | implemented | 19 current/legacy types + collision regeneration |
| Operator credentials | implemented | Django PBKDF2-SHA256 fixture + constant-time compare |
| Operator session | implemented | bridge mapping + logout gate + atomic hint |
| Existing SQLite data | compatible | isolated Electron DB copy read/write/delete test |
| Weak-device write path | optimized | one persistent connection + 1,000-record test |
| Reports/outbox | Electron retained | Rust delivery activation pending explicit deployment contract |
## Implemented parity checkpoint: phase 4.1

| Contract | Rust status | Verification |
|---|---|---|
| Serial/TCP/simulator lifecycle | implemented | generation-fenced worker + bounded shutdown/reconnect |
| Protocol catalog | implemented | 20 shared Electron/Rust replay fixtures |
| Partial and binary framing | implemented | line, Massa-K 100 and J decoder tests |
| Reading stability/throttle | implemented | transition, dedup and bounded-window tests |
| Weak-device stream path | bounded | 4 KiB reads, 64 KiB decoder cap, 20,000-frame soak |
| Release TCP behavior | implemented | poll, fragmented frame, EOF and reconnect EXE smoke |
| Physical device qualification | pending by model family | Electron transport retained for rollback |
## Implemented parity checkpoint: phase 5.1

| Contract | Rust status | Verification |
|---|---|---|
| Raw TCP 9100 send | implemented staging path | release EXE sends two exact ZPL byte streams to a local receiver |
| Physical printer ordering | implemented | pack/box logical roles share one endpoint-keyed FIFO worker |
| Persistent/idle connections | implemented | one reused connection; 400 ms idle-close loopback test |
| Retry/circuit breaker | implemented | refused endpoint test + bounded retry/reconnect counters |
| Weak-device limits | bounded | 16 queued jobs/printer, 12 workers, 16 MiB/job, 3 s I/O timeouts |
| Public print-label route | Electron retained | switch after generator golden parity in phase 5.2 |

## Implemented parity checkpoint: phase 5.2

| Contract | Rust status | Verification |
|---|---|---|
| ZPL native generation | implemented staging path | exact shared 203 DPI TypeScript golden stream |
| TSPL/TSPL2 native generation | implemented staging path | exact shared 300 DPI TypeScript golden stream |
| Geometry | implemented | 203/300/600 DPI dot and scaling assertions |
| Compatibility/profile routing | implemented | native eligibility plus deterministic bitmap fallback reasons |
| Legacy barcode names | implemented | current aliases normalize to the same command families |
| Weak-device limits | bounded | 1,024 elements, 8 MiB input, 16 MiB output, blocking work off UI thread |
| Generate-to-TCP path | implemented staging path | release EXE sends 889 exact bytes over one reused connection |
| Public print-label route | Electron retained | switch with bitmap handoff in phase 5.3 |

## Implemented parity checkpoint: phase 5.3

| Contract | Rust status | Verification |
|---|---|---|
| Public print-label route | implemented | release EXE invokes the unchanged public bridge for native and fallback jobs |
| Planner routing | implemented | native Rust generate/send or explicit lazy renderer bitmap handoff |
| ZPL bitmap fallback | implemented | release stream contains ordered GFA payload |
| TSPL bitmap fallback | implemented | release stream contains ordered binary BITMAP payload |
| Serial printer transport | implemented | persistent 8N1 configuration, endpoint queue key, retry and bounds tests |
| Windows RAW printing | implemented | OpenPrinter/WritePrinter backend plus missing-queue error test |
| Windows bitmap printing | implemented | CreateDC/StretchDIBits 1-bit GDI backend |
| Default Windows printer | implemented | GetDefaultPrinterW fallback when no queue name is supplied |
| Weak-device loading | optimized | 2.1 KiB orchestrator and 9.6 KiB bitmap chunks; bwip-js remains lazy |
| Transport bounds | retained | 16 jobs/printer, 12 workers, 16 MiB/job, 3 s I/O timeouts |
| Release public behavior | implemented | 3 jobs, 14,377 bytes, one TCP connection, zero failed jobs |
| Physical printer qualification | pending by family | Electron runtime and phase 5.2 archive remain rollback paths |
## Implemented parity checkpoint: phase 6

| Contract | Rust status | Verification |
|---|---|---|
| Online updater | implemented | official Tauri updater, signed endpoint and progress events |
| Offline EXE/MSI update | implemented | extension guard, pre-install backup and passive launch |
| Backup/rollback | implemented | three-snapshot retention, traversal rejection, startup restore and outbox merge |
| Identity/sync/job file dialogs | implemented | native dialog paths plus bounded LPI2 processing |
| Offline report export | implemented | encrypted LPR output written atomically |
| USB import/export | implemented | 64 MiB cap, versioned envelope, HMAC round trip and tamper rejection |
| Demo/reset lifecycle | implemented | Rust-owned seed, exit and transactional database reset |
| Packaging | implemented | current-user Tauri NSIS EXE, detached signature and latest.json |
| Electron data compatibility | retained | shared LabelPilot data directory and identifier contract |
| UI layout | unchanged | renderer production hash/build path retained for this phase |
## Implemented parity checkpoint: phase 7.2

| Contract | Rust/Tauri status | Verification |
|---|---|---|
| Full runtime benchmark | implemented | identical production UI, isolated profiles, process-tree cold/CPU/RAM/thread/handle metrics |
| Runtime stability harness | implemented | configurable 8-hour default; short qualification uses the identical workload |
| Native print workload | passed | 120/120 ZPL jobs; durable/generator/transport failures = 0 |
| Printer reconnect | passed | 12 TCP connections, transport reconnect counter observed |
| Scale reconnect | passed | 117 polls, 12 TCP connections, fragmented frames parsed |
| Full-sync workload | passed | 15/15 localhost snapshots, ingress rejected = 0 |
| Resource trend | passed short run | private +2.0 MB, working set +5.3 MB, normalized CPU 2.71% |
| Cold-start budget | passed | 216.7 ms <= 2.5 s |
| Full-UI memory budget | open | 405.9 MB median working set and 316.5 MB sampled peak private |
| Canary | pending | repeat after memory optimization and 8-hour target-hardware soak |

## Implemented parity checkpoint: phase 7.3

| Contract | Rust/Tauri status | Verification |
|---|---|---|
| Initial UI graph | optimized | release EXE loads only App, weighing station, shared vendor/bridge, and the lightweight modal wrapper |
| Station state continuity | retained | first visit mounts each station once; hidden stations remain mounted |
| Closed modal cost | deferred | date, product, delete implementation, and numeric keypad chunks load on demand |
| Main App bundle | bounded | 130,717 bytes, down from 252.81 KiB |
| Barcode generator isolation | retained | 884,530-byte `bwip-js` chunk remains outside startup |
| Renderer heap | measured | 2,618,300 bytes used after visiting all stations and collecting garbage |
| Target viewport | fixed | both runtime windows positioned at 1366×768 before five samples |
| Runtime comparison | passed relative gates | Tauri: 8.5% lower working set, 16.5% lower private bytes, 75.3% faster start |
| GPU mode | measured and retained | software fallback raised working set by approximately 120 MiB |
| Operational stability | passed | 120/120 prints, 15/15 sync, printer/scale reconnect, all 16 soak gates |
| Full regression | passed | migration contracts and 89/89 Rust tests |
| Strict memory budget | open | fixed WebView2 process-tree baseline exceeds 120/200 MiB targets |
| Canary | pending | eight-hour soak on 4 GB target hardware plus physical-device matrix |

## Implemented parity checkpoint: phase 7.4

| Contract | Rust/Tauri status | Verification |
|---|---|---|
| Structured production events | implemented | versioned JSON, UUID dedupe IDs and 16 KiB bound |
| Runtime heartbeat | implemented | network/ingress/scale/printer/durable/generator summaries |
| Renderer/subsystem failures | implemented | global error/rejection plus printer/scale/ingress WARN/ERROR sinks |
| Delta reporting | implemented | pack/error cursors and compound late-deletion cursor |
| Encrypted online upload | implemented | existing LPI2 `.lpr` multipart server endpoint |
| Durable outbox | implemented | atomic spool, bounded disk usage and cursor-after-durability rule |
| Retry ownership | implemented | startup, periodic, reconnect and manual flush |
| Shutdown continuity | implemented | worker join followed by network-free final spool |
| Missing provisioning | lossless deferral | watermark remains unchanged until identity/license exists |
| Diagnostics | implemented | telemetry summary and explicit flush commands |

## Implemented parity checkpoint: phase 8

| Contract | Tauri-only status | Verification |
|---|---|---|
| Desktop runtime | implemented | Tauri/WebView2 only; no Electron package or executable |
| Renderer bridge | implemented | `window.desktopBridge`; legacy alias absent |
| Production entry | implemented | one `index.html` / `src/main.tsx` path |
| Native backend | implemented | Rust owns lifecycle, persistence, network, ingress, scales, printing, updater and telemetry |
| Complex label fallback | implemented | lazy `renderer-bitmap` path |
| Release CI | implemented | Rust tests plus signed Tauri NSIS artifacts only |
| Existing station data | retained | stable application identifier and `%APPDATA%` data directory |
| Rollback | external artifact | signed 1.3.x installer, not part of the 2.0 source/build graph |