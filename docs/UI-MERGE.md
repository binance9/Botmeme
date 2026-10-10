# UI-MERGE — GA Trade Bot vào Meme Trader (2026-10-05)

Kết quả: **GA TRADING HUB MERGE = PASS + LOCKED**

## Kiến trúc

```
MEME TRADER WEB :7883  (cửa UI DUY NHẤT — /meme-trader/)
        │  cùng origin, KHÔNG iframe
        ├── MEME SERVICE (in-process, không đổi)
        │     scanner · on-chain · meme strategy · paper/live execution
        │     events: /api/events  (namespace MEME:*)
        │
        └── LONG/SHORT SERVICE (GA gateway :8932 + FreqTrade :8081)
              Binance feed · SMC engine · bot-bridge · ft_userdata
              UI assets:  /ga-assets/*  → C:\GA-TRADE-CHART (js/vendor/css thật, module import)
              API proxy:  /api/bot/*    → :8932 (GET/POST + SSE pipe)
              events:     /api/bot/stream (namespace LONG_SHORT:*)
```

Hai bot KHÔNG chia sẻ strategy state. BotManager (`services/bot-manager.cjs`) chỉ
start/stop/status/health — không quyết định BUY/SELL.

## Những gì đã xây

| Thành phần | File |
|---|---|
| Bot ON/OFF thật (LONG/SHORT) | `GA-TRADE-CHART/bot-bridge/power.mjs` — PowerManager (persist `ga_bridge/power.json`) + `FreqTradeControl` (chỉ POST /start, /stop). OFF = FreqTrade ngừng xử lý + bridge ngừng quyết định + **history giữ nguyên**. Boot với OFF → tự đồng bộ FT stopped. |
| Power trong runtime | `bot-bridge/bot-runtime.mjs` — `attachPower()`: OFF chặn ingest/heartbeat/entry-mirror; status polling vẫn chạy (hiển thị trung thực); đổi power → publish ngay (label không trễ). Namespace guard: symbol ngoài whitelist → `FOREIGN_NAMESPACE`, không vào journal. |
| Gateway route | `dev-server.mjs`: `POST /api/bot/power` |
| BotManager | `Botmeme/services/bot-manager.cjs` — MEME điều khiển in-process (application.start/stop có sẵn, persist scanner-state.json), LONG/SHORT qua gateway. State: ON/OFF/STARTING/ERROR. |
| Hub routes | `Botmeme/scripts/serve-meme-trader.cjs`: `/api/bots/status|health`, `/api/bots/{meme|long-short}/{start|stop}`, proxy `/api/bot/*`, static `/ga-assets/*` (chống traversal). Không đổi behavior có sẵn. |
| Trades 2 mode | `public/meme-trader/long-short.js` — tab [MEME TRADER][LONG / SHORT], nhớ tab gần nhất (`localStorage` + `#long-short`/`#meme-trades`), không reload app, chart/websocket giữ nguyên khi chuyển tab (mount một lần, chỉ toggle display). |
| LONG/SHORT view | Cùng module GA thật: ChartCore + ChartCoordinator + watchlist/bot-panel/bot-activity/bottom-bar/marker primitive. Layout bám golden: center chart hero, phải Watchlist+Bot Status+Positions+Activity, trái drawing toolbar, trên GA control bar (TF/SMC PRO-FULL/Candles/Indicators/Replay), dưới market strip + connection thật. |
| Trades header | `Trades [Meme Trader][Long/Short]` + phải: `Bot ● ON/OFF` (toggle runtime thật của tab hiện tại), `Dry Run`, `Connection ●`. |
| Sidebar BOTS | Widget gọn dưới menu: `Long/Short ● ON` / `Meme ● OFF`, click chuyển tab tương ứng. Poll 5s (tự-tái-lập, không thể chết im lặng). |
| Scoped CSS | `long-short.css` — toàn bộ GA palette scope dưới `#long-short-view` + `.bots-widget`, không泄漏 vào shell Meme (terminal LS luôn dark navy theo golden). |

## Điều kiện 0 (mục 0)

Phase trước đã kết thúc `CHART-BOT-MERGE = PASS + LOCKED` (250/250 test GA,
E2E live, visual MATCH 0 critical) — điều kiện bắt đầu THỎA.

## Tests

- GA: **250/250 PASS** (`node --test tests/`) — thêm `tests/bot-power.test.mjs` (P01–P10):
  mặc định OFF khi mới cài, persist qua restart, FT start/stop thật, POWERED_OFF chặn
  ingest + heartbeat, FOREIGN_NAMESPACE, status vẫn flow khi OFF.
- Botmeme: **9/9 PASS** (`npm run test:ui-merge`) — BotManager states, routing
  start/stop đúng bot, gateway offline → ERROR (không bao giờ fake ON), isolation
  contract, /ga-assets traversal blocked, proxy 502 khi gateway chết, meme start
  vẫn giữ gate gốc (WALLET/PROVIDER).
- Botmeme regression: `application-control`/`state-layer` — 2 test fail TRƯỚC KHI
  merge (môi trường có `wallet-key.env` thật → liveSession=true). Không phải regression
  của phase này; `application.cjs` không bị đụng.

## E2E (mục 17–19) — chạy thật trên :7883

- T1/T2 tab mở đúng ✓ · T3 chuyển 20 lần: history/listener/chart ổn định ✓
- T4–T7: MEME ON/OFF, LONG ON/OFF, cả hai OFF, cả hai ON — điều khiển runtime thật
  (FreqTrade `stopped`↔`running` xác nhận qua /show_config) ✓
- T8/T9/T10: isolation — P08 FOREIGN_NAMESPACE + UI hai tab đọc hai nguồn riêng ✓
- T11 history giữ nguyên sau switch ✓ · T12 không duplicate websocket ✓
- T13 bot OFF không tạo decision (FT stopped + POWERED_OFF) ✓ · T14 ON resume ✓
- T15 refresh restore mode + widget ✓
- T16 gateway chết → "FreqTrade Disconnected" + "Server: Offline" + BOTS ERROR,
  meme không bị ảnh hưởng ✓ (khôi phục sau khi gateway trở lại)
- T18 resize ✓ (canvas theo viewport sau fix ChartCore.resize) · T19/T20 1366/1920 ✓
- Section 18: trong chính #trades → LONG/SHORT: Binance → SMC → bridge → journal
  (SIGNAL_CANDIDATE seq 51–54 thật) → marker SIGNAL tím → activity → Bot Status.
  Không cần mở :8932.
- Section 19: MEME tab: scanner 110 pool · so ứng viên · 40 pool mới · trade panel
  riêng — không đụng Long/Short.

## Visual (mục 20)

Shell Meme giữ nguyên (sidebar/wallet/AI activity/scanner). Tab Long/Short dùng
layout golden đã duyệt. Ảnh: `GA-TRADE-CHART/docs/hub-screenshots/`
(hub-01…hub-06). Verdict visual-judge ở phần Final Gate.

## Sự cố đã xử lý trong phase

1. View bị lồng nhầm vào `.content-grid` (anchor chèn sai) → đã chuyển ra đúng vị trí.
2. Chart không vẽ: thiếu `chart.coordinator = coordinator` khi mount → SMC pipeline
   không bao giờ chạy. Fix 1 dòng; xác nhận 419 pivots/52 events ngay sau fix.
3. Canvas 0px sau display toggle → thêm `ChartCore.resize()` (applyOptions width/height,
   LWC v5 không có resize()) + gọi khi vào view/window resize.
4. Widget BOTS luôn OFF: BotManager trả key `longShort` nhưng UI index `'long-short'`
   → chuẩn hóa key ở fetchBots/toggle handler.
5. Poll 5s chết im lặng → thay bằng vòng `for(;;)` tự-tái-lập.
6. Server :7883 chết 1 lần không log (external kill, không phải crash code) → restart
   qua launcher; gateway chuyển sang chạy detached (PowerShell Start-Process).

## LƯU Ý QUAN TRỌNG CHO CHỦ

- **Meme bot**: restart :7883 làm mất trạng thái ARMED in-memory (thiết kế cũ của
  `core/execution/live.cjs`) → bot về **SAFE**. Chủ đã/đang arm lại qua API quen thuộc:
  `curl -X POST http://127.0.0.1:7883/api/control -H 'Content-Type: application/json'
  -d '{"action":"LIVE","confirm":"LIVE_REAL_MONEY"}'`. ZooKeeper không tự arm tiền thật.
- `bot-manager.cjs` sửa cosmetic (stale scan error không còn che state OFF) — có hiệu lực
  ở lần restart :7883 kế tiếp, cố tình không restart thêm lần nữa để giữ ARMED.
- FreqTrade LONG/SHORT hiện **ON (dry-run)**, MEME **ON** — muốn tắt bot nào: nút Bot OFF
  trong Trades hoặc click hàng BOTS ở sidebar.
- Legacy: :8932 vẫn chạy (dev/debug + LONG/SHORT service). Không xóa gì.

## FINAL GATE (mục 22)

| Điều kiện | Kết quả |
|---|---|
| :7883 là UI duy nhất cần mở | PASS |
| Meme Trader giữ đủ chức năng | PASS (scanner/trades/wallet/AI activity nguyên vẹn) |
| Long/Short đầy đủ GA Chart | PASS (chart+SMC+markers+panels thật, không iframe) |
| Bot ON/OFF điều khiển runtime thật | PASS (FT stopped/running; meme scanner stop/start) |
| 2 bot isolation hoàn toàn | PASS (namespace + state riêng + P08/M-tests) |
| Không duplicate websocket/listener | PASS (mount 1 lần + switch-storm ổn định) |
| History/state không mất | PASS (journal + meme history qua 20 switch) |
| E2E Long/Short PASS | PASS (SIGNAL_CANDIDATE thật trong :7883) |
| E2E Meme PASS | PASS (scanner→candidate→strategy→activity) |
| Visual đạt | PASS (shell nguyên vẹn + LS bám golden — ảnh hub-01…06) |
| Legacy chưa xóa | PASS (:8932 + GA repo nguyên trạng, chỉ thêm) |

**GA TRADING HUB MERGE = PASS + LOCKED**
Manifest: `Botmeme/docs/ui-merge-manifest.sha256` + `GA-TRADE-CHART/manifest/HUB-LOCKED.sha256`
