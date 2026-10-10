# Live trading

Live execution starts locked on every process boot. No key is bundled. No new packages were installed: the existing `tweetnacl`, `bs58`, and `@solana/web3.js` provide signing, encoding, and transaction parsing.

The owner supplies `C:\Botmeme\wallet-key.env`, with one `TRADING_PRIVATE_KEY=<base58 64-byte Solana secret key>` line. The derived address must match `D1mXorM6HPJ1NdoKXyCuvtjVQxtvFGQmJzHY6EnqBc2D`. Never paste this file into logs, chat, or source control. This module does not accept a secret via HTTP or process environment.

The existing launcher imports `RPC_HTTP_ENDPOINT` from `rpc.env`; live RPC uses this configured Helius endpoint. No changes to `rpc.env` are required. Jupiter's current v6-style ExactIn quote/swap API is `https://api.jup.ag/swap/v1` (https://developers.jup.ag/docs/api-reference/swap/v1/swap). Supply `JUPITER_API_KEY` in the server's environment for this endpoint. Tests inject a local mock transport. There is no fallback that bypasses an API, simulation, or safety failure.

After the owner next loads this code into the server, connect the matching SOLANA wallet, press LIVE, and type exactly `LIVE`. The UI posts `{ "action": "LIVE", "confirm": "LIVE_REAL_MONEY" }` to `/api/control`. A missing/invalid key, wrong wallet/network, invalid cap, pending transaction, or kill file prevents arming. STOP disarms and stops acquisition; START PAPER remains available separately. Scanner auto-resume never arms live execution.

Defaults, overridden by the corresponding server environment variables:

| Variable | Default |
| --- | --- |
| `TRADING_MAX_POSITION_USD` | 1 per BUY, including SOL debit/fees/rent verified by simulation |
| `TRADING_MAX_DAILY_LOSS_USD` | 5, gross realized losses plus entry fees, UTC day; profits do not reset it |
| `TRADING_MIN_SOL_RESERVE` | 0.01 SOL |

BUY rejects oversized intents rather than silently resizing risk approvals. Within an approved budget it leaves 0.0025 SOL rent/fee headroom and a 1% buffer, then verifies actual simulated spend and reserve. Consequently very small budgets may be rejected. Quotes use 100 bps slippage. SELL requires a tracked live position matching the entire on-chain token balance; it never sells paper positions or unrelated wallet holdings. Live protective exits request a full SELL instead of paper's partial REDUCE. Risk, safety, Jev veto, strategy disablement, and fresh SOL/USD evidence remain required.

Create `C:\Botmeme\LIVE_KILL` to halt new sends. The executor checks it at each stage and immediately before broadcast; a watcher disarms idle live mode as well. An already broadcast transaction cannot be recalled: confirmation/accounting continues after STOP/kill. Confirmation is polled at confirmed commitment for up to 60 seconds, with bounded RPC calls. No signed transaction is automatically re-sent.

`live-state.json` is a separate, private-key-free durable ledger containing claimed intents, confirmed receipts, daily-loss history, and any pending signature. It is flushed before broadcast. The runtime journal receives live activity and contract-valid `TradeResult` events; token amounts come from transaction metadata, fees from `meta.fee`, and SOL debit/credit from signer balance changes. SOL debit includes account rent where applicable. Amounts and fees are valued using the verified SOL/USD observation used for execution. Raw token, SOL, fee amounts, and signature are in receipt evidence. Rent refunds can appear in SELL proceeds.

An ambiguous send, failed transaction, missing receipt, or publication failure leaves live execution locked for reconciliation. Inspect the recorded public signature on-chain and reconcile the ledger/receipt before any further arming; never delete the ledger or clear pending state merely to retry. This version deliberately has no automatic recovery that could double-spend an uncertain intent. Use one application process for this wallet.

Paper and live intent modes are distinct. Paper consumers stay subscribed for analytics but skip live intents, including after STOP/restart. Live execution ignores all pre-arm backlog. Long-running swaps use a separate serial queue so the event bus's 5-second consumer deadline cannot cancel routine network work or freeze analytics. Live portfolio cost basis and positions come only from the live ledger; the main wallet balance switches to confirmed on-chain SOL. Existing overview widgets continue to present paper shadow history.

Verification uses random temporary test keys, mock Jupiter/RPC, and a local HTTP test server. No production key or real transaction is used. The running server was not restarted by this change.
