# MASTER PLAN — Botmeme × Codex 6 × Jev (bản của sếp, 2026-09-27)

Vai trò: **Chủ = sếp** (chính sách rủi ro, kết nối ví, START/STOP).
**Codex 6 = não chính** (bắt xu hướng, quyết định sớm nhất).
**Jev = não quyết định nhanh có confidence + giám sát pháp chứng.**
Mục tiêu: từng bộ não, từng nhiệm vụ chạy chuẩn và ổn định; giao dịch paper hoàn chỉnh
trước, real chỉ sau khi chủ nối ví và tất cả gate PASS.

## 1. Chuẩn mực rút ra từ các bot meme tốt nhất hiện tại (research 2026-09-27)

Các bot đầu bảng (Trojan, BonkBot, Maestro, Banana Gun, GMGN, Photon) dùng chung 7 thứ:

1. **Thực thi dưới 1 giây** — private RPC + định tuyến riêng, không swap qua ví thường.
2. **An toàn không ký (non-custodial) có kiểm toán** — KMS + 2FA/Passkey.
3. **Chống MEV/sandwich** — relay riêng (Jito / private routing).
4. **Đa chuỗi** — Solana trước, sau đó ETH/Base/BSC.
5. **Tự động lệnh** — limit order, DCA, auto-snipe token mới.
6. **Lọc rug/honeypot bắt buộc trước khi mua** — mint authority revoked, freeze authority
   revoked, LP burned/locked, tập trung holder, lịch sử dev wallet, mô phỏng lệnh bán.
7. **Copy trading / smart-money watchlist** (Trojan theo dõi tới 40 ví).

Khoảng trống của chính các bot này: **TP/SL/trailing stop gần như không có** —
Botmeme sẽ làm tốt hơn ở điểm này (risk engine chủ động, không phụ thuộc bot bên ngoài).

Nguồn: [Gate.com — Top 10 meme bots](https://www.gate.com/learn/articles/top-10-meme-trading-bots/5195),
[CoinLaunch — Best meme bots 2026](https://coinlaunch.space/blog/5-best-memecoin-trading-bots-for-sniping-and-automation),
[Backpack — Best Telegram bots on Solana](https://learn.backpack.exchange/articles/best-telegram-trading-bots-on-solana),
[QuickNode — Top Telegram bots](https://www.quicknode.com/builders-guide/best/top-10-telegram-trading-bots).

## 2. Phân vai bộ não (ràng buộc cứng)

| Não | Nhiệm vụ | Hiện trạng | Việc cần |
|---|---|---|---|
| **Codex 6** (não chính) | Nắm xu hướng sớm nhất: discovery token mới, momentum, timing vào/ra, chiến lược vào lệnh | Hunter + providers đã có, bị 429 chậm | Sửa pacing/provider pool, thêm tín hiệu momentum & smart-money, rút ngắn chuỗi quyết định |
| **Jev** (não nhanh + giám sát) | (a) Verdict có cấu trúc cho từng candidate (noul/choice/score + confidence + probabilities, batch 1 call < 1s); (b) chấm rủi ro; (c) forensic critique sau trade; (d) auditor pháp chứng code/acceptance | `C:\JEV` đã có client API thật (13/13 test PASS, latency 0.5–1.5s); Botmeme đã có services/jev/auditor + hunter | Cắm Jev decision adapter vào pipeline candidate→verdict; bắt buộc guardrail; API chết → rơi về rule-quant, không treo |
| **Chủ** | Chính sách rủi ro, nối ví thật, START/STOP | Chưa nối ví | Chỉ chủ làm được |

Ràng buộc giữ nguyên từ docs Botmeme: TypeSafe/Jev **không bao giờ** là acceptance
provider; JEV acceptance vẫn đi qua services/jev/auditor với receipt. Không tự phong PASS.

## 3. Pipeline mục tiêu (mỗi bước có owner, có gate)

```
[1] DISCOVERY   Hunter + GeckoTerminal/DexScreener pacing (Codex 6)
      ↓ candidates có freshness ≤ 60s, dedupe
[2] SAFETY GATE (hard rules — KHÔNG qua gate thì KHÔNG mua, không xin ý kiến model)
      mint authority revoked · freeze authority revoked · LP burned/locked ≥ ngưỡng
      top-10 holders < ngưỡng · tuổi pool ≥ ngưỡng · liquidity USD ≥ sàn
      honeypot: mô phỏng lệnh BÁN thành công (RugCheck/checker)
[3] SIGNAL      momentum, delta volume/liquidity/holders, smart-money watchlist (Codex 6)
[4] VERDICT NHANH   Jev batch 1 call: noul(s) an toàn bổ sung + score momentum +
      choice action (TRADE/WATCH/REJECT/WAIT) + confidence → guardrail validate
      API chết → rule-quant quyết, ghi reason (Jev decision adapter)
[5] RISK        sizing từ WalletValuation đã verify; % position tối đa; slippage cap;
      STOP-LOSS + TAKE-PROFIT + TRAILING STOP bắt buộc mọi position (điểm các
      bot lớn thiếu); daily loss cap chặn hẳn vòng lặp
[6] EXECUTION   paper trước: mô phỏng slippage + fee 1%; sau khi chủ nối ví + gate
      PASS: Jupiter + priority fee + MEV protection
[7] MEASURE     journal hash-linked, performance store, PnL paper trung thực
[8] LEARN       forensic critique + Jev score lại quyết định cũ → feedback strategy
```

## 4. JEV hiện làm được gì (đã kiểm chứng thật, 13/13 test PASS)

- **Decision thật qua TypeSafe System One**: noul/choice/score, batch nhiều câu 1 call,
  state string/JSON, confidence + probabilities, usage tokens. Latency thực 0.5–1.5s/call.
- **Client routing** jev-latest → jev-preview; model sai fail-fast không che lỗi.
- **Guardrail** validate answer shape theo OpenAPI schema (choice ngoài phương án,
  confidence/score ngoài khoảng → violations).
- **Degrade**: API lỗi/hết quota/mất mạng → `ok:false` + reason, local vẫn chạy.
- **Local scanner** (C:\JEV): scan/diff/find/grep/read/sha256 toàn máy — dùng cho pháp chứng.
- **Trong Botmeme sẵn có**: services/jev/auditor (acceptance, receipt), hunter (research).

## 5. Lộ trình thực thi (theo thứ tự, mỗi bước có receipt)

1. **P0 — Kéo code bám kịp docs**: 36 file sửa sau 24/9 chưa có receipt; chạy lại
   test:runtime + audit:jev trên source hiện tại trước khi thêm tính năng mới.
2. **P0 — Safety gate [2]**: module mới, hard rules, unit test với fixture rug/honeypot
   thật. Không gate này thì mọi thứ sau vô nghĩa trên meme coin.
3. **P1 — Jev decision adapter [4]**: đã khởi tạo (services/jev/decision/jev-client.cjs +
   test thật PASS); việc còn lại: nối vào application.cjs qua event bus, thêm test
   application-control tương ứng, chạy receipt.
4. **P1 — Risk engine [5]**: TP/SL/trailing + daily cap; unit test kịch bản pump/dump.
5. **P2 — Tháo nút 429 [1]/[3]**: pool provider đa nguồn (thêm 1 nguồn nữa), backoff
   thích ứng đã có, cache 30s giữ nguyên; mục tiêu scan 5/5 ổn định.
6. **P2 — Deploy bản activity-counts đang kẹt on-disk**.
7. **P3 — Real execution**: chỉ khi chủ nối ví + mọi gate PASS + paper lãi/không cháy
   qua ít nhất một chế độ market đầy đủ.

## 6. Định nghĩa "chuẩn, ổn định" (chủ dùng để nghiệm thu)

- Mọi candidate phải đi qua [2] và [4] với confidence ≥ ngưỡng chủ đặt; thiếu → WATCH.
- Mọi position phải có SL/TP/trailing từ lúc mở; không có case "mở lệnh trần trôi".
- API/model chết bất kỳ lúc nào → bot không treo, không mua mù, log reason.
- Mỗi thay đổi code có receipt test + JEV auditor; negative result giữ nguyên vẹn.
- Chỉ báo trên dashboard tính từ event thật, không chế số.
