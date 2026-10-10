# Wallet-backed paper capital — 2026-09-24

Production application no longer selects the $10,000 fixture budget. It reads
native on-chain balance and a timestamped public Coinbase USD trade quote,
rounds the resulting available USD ceiling down to cents, and publishes a
validated WalletValuation event. Raw balance and quote evidence is retained in
data/capital-evidence; events contain hashes and public account identity hashes.

This is native coin valuation only, not total ERC20/SPL holdings or OKX's entire
portfolio balance. Unsupported/unavailable market quotes fail closed. There is
no USD/USDT parity assumption and no stale-price fallback.

The first positive valuation seeds the paper ledger. Subsequent wallet-price
changes alter the spending ceiling, not realized paper PnL or the original
paper principal. Available equity/cash are capped by verified current wallet
capital. Both Commander and Risk consume that same trade store; the dashboard
uses its budgetUsd. Missing, expired, disconnected, wrong-account or old-network
funding denies capital. Risk decisions include the funding event reference.

Regression evidence: remote run-20260924-191512 recorded 174/174 passing tests,
unchanged source manifest. Initial wallet suites: 7/7. Subsequent timestamp
normalization and default-production START/failure coverage ran in separate
capital-final-1918 snapshot: 8/8. Fixed-budget application/control test fixtures
now explicitly pass capitalUsd instead of accidentally relying on production's
old default; new tests exercise the wallet-funded production default.

Live reader + application verification returned approximately $26.42. After
deployment, real browser DOM at 19:18 local displayed `$0.00 / 26.43`, matching
the updated USD valuation. No position was open, so utilized capital stayed $0.
The original 223-record journal was hash-verified and preserved during restart.
Retired writer lock was archived; current backend PID at deployment was 9784.

Component tests and this live UI verification are not independent JEV semantic
acceptance or FINAL PASS. Model routing, market-provider throttling and full
autonomous end-to-end acceptance remain outstanding.

Live follow-up found the token provider's 429 backoff could allow valuation to
expire before the next scan. Source now refreshes wallet valuation independently
every 25 seconds, using the serialized control queue, and clears the timer on
close. Remote capital/application/server regressions: 13/13 passed, recorded in
capital-final-1918/capital-cadence.tap. This final cadence fix is NOT DEPLOYED:
automatic approval review rejected the restart command with 'blocked by policy'
and supplied no specific reason. Existing PID 9784 remains on the preceding
version, where expired valuations correctly render unknown and prevent risk
approval. Do not claim completion of live cadence verification.
