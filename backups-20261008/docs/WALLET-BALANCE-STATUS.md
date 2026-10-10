# Read-only wallet balance — 2026-09-24

Implemented a bounded, cached JSON-RPC native-asset reader, with separate network
descriptors for SOL, ETH, BSC and Robinhood. EVM chain identity and Solana genesis
are verified before reading; EVM reads are pinned to a block. Atomic units are
converted with BigInt, not floating point. RPC failures return CHUA_XAC_MINH,
never a fabricated zero. The server rejects a result if the wallet/network
session changed while the request was pending.

The existing bottom-left wallet panel renders native balance; it is explicitly
not a total token portfolio valuation. Overview labels identify paper PnL and
paper capital. No signer, secret, financial transaction or real capital sizing
was introduced.

Live read against the owner's already-connected Robinhood public account
succeeded at block 0x440c700, timestamp 2026-09-24T12:02:20.728Z. Public address
is intentionally omitted here. This verified the reader, not the deployed UI.

Remote snapshot: data/remote-tests/run-20260924-190203.
Runtime receipt: 174/174 passing, unchanged manifest hashes.
Additional wallet-balance, dashboard-wave and OKX-session tests: 10/10 passing.
These are component tests, not final independent JEV acceptance.

Commander, Quant and Forensic were already composed in runtime/application.cjs.
Their event subscriptions and tests were inspected; no duplicate AI services
were added. Forensic waits for TradeResult/StrategyProposal; absence of such an
event is not proof of a broken connection. The services currently implement
algorithmic decisions/replay/critique, not three newly connected language models.

Deployment update 19:06 local: after the owner's explicit request to connect,
the exact process identity was checked and the old process stopped. The journal's
81 records passed hash-chain verification. The owned stale lock was preserved
in the remote-test evidence directory, not deleted; the journal was not reset.
New backend PID 19860 started, the existing public wallet metadata was restored,
and paper acquisition resumed.

Actual browser verification: expanding the bottom-left Wallet panel shows
0.009982348292559839 ETH, block 0x440d008, observed at
2026-09-24T12:06:15.003Z. Live JEV, CODEX 1 and CODEX 2 events arrived, with
real market data visible. CODEX 3 remains waiting for a qualifying trade/proposal;
no artificial trade was injected to make it appear active.

Language-model routing for CODEX 1/2/3 is not yet configured. Owner was asked
whether to use the existing Qwen 32B Runpod or a configured OpenAI API.
Component service wiring is not equivalent to three model connections.
Full end-to-end and independent JEV acceptance remain pending.
