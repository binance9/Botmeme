# Paper capital and journal rotation

`runtime/telemetry/journal.cjs:openJournal` rotates journals larger than 20 MiB
at startup into `runtime.jsonl.<timestamp>.archive`. It acquires the writer lock,
fsyncs an atomic `capital-anchor.json.tmp` → `capital-anchor.json` checkpoint,
then renames the journal. A failed checkpoint prevents rotation.

The anchor lives beside the journal. `runtime/capital-ledger.cjs` owns both the
anchor and existing capital adjustments. The anchor stores paper accounting
events, imported archive names, and per-network capital/realized PnL totals.
Both checkpoint totals and the trade store call `projectCapitalPortfolio` in
`runtime/capital-ledger.cjs`, which delegates fill accounting to
`core/performance/project.cjs`. Explicit paper capital remains the seed even
when wallet observations exist. Preserving fill identities and cost basis prevents double counting on
restart and supports positions spanning rotations. Every SELL/REDUCE forces
the journal to disk before atomically updating the anchor. Startup repairs a
checkpoint missed between those writes from the journal.

Existing archives are imported read-only once. Legacy archives are projected
separately because the old code discarded their open positions at each rotation.
Their realized PnL carries forward; their unclosed trades remain archival history,
not newly funded positions. New rotations preserve the complete position basis.
Only the seed and latest wallet valuations are retained in each checkpoint.
The trade store combines the
anchor's historical events with current events by identity, so dashboard trade
history survives rotation too. Archived events are not delivered to consumers.
The overview also seeds its deduplicated fill index from the anchor at boot;
archive reads remain read-only.
Fresh, account-matched wallet evidence is still required for wallet-funded buys;
realized gains are included in the budget. Losses still reduce paper capital.

The deposit/withdraw Settings panel and its frontend handlers are removed.
The capital-ledger backend/API remains as part of the shared accounting store
and preserves existing cash adjustments. No live-wallet transfers are involved.

Entry policy uses a named `MAX_CAP_HARD_USD = 10000000` in the risk engine.
Every BUY path rejects larger caps. New tokens retain their $20k watch-band
upper limit with a $3k floor and $200 volume minimum; old tokens use $20k–$10M.
