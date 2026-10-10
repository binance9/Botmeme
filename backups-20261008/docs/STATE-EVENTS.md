# Realtime state contract

This is a state/event layer, not a scanner implementation, market-data provider,
AI runtime, order executor or wallet. Producers must supply their actual results.
The running dashboard starts empty; test fixtures are used only by isolated tests.

## One authority

`state/store.cjs` validates and reduces producer events. It writes and fsyncs each
accepted event to `data/events.jsonl` before publishing the new state. All views
receive the same complete snapshot, including its monotonically increasing
`version`, via server-sent events. Browser code only formats that snapshot and
aggregates its received candles for display; it never books trades or computes
independent portfolio balances.

- `GET /api/state`: complete current snapshot.
- `GET /api/events`: SSE; `event: state`, `id: <version>`, `data: <snapshot>`.
- `POST /api/events`: one producer event, JSON, maximum 64 KiB.

The server binds to loopback. Ingestion is for trusted local producers; it is not
an authenticated multi-user/public service. Host and browser Origin checks block
cross-origin writes. There is no order-submission endpoint.

Every new or reconnected stream gets a full snapshot. A 15-second refresh keeps
the stream alive and rolls the daily summary over at midnight in Vietnam; it does
not generate market ticks, AI work, scan results, activity or trades. A browser
disconnect keeps the last snapshot visible and marks the connection OFFLINE.
Agent statuses are the last status reported by their producer, with its timestamp;
connection to the state service does not mean every AI/feed is online.

## Envelope

Each producer sends exactly these fields:

| Field | Contract |
| --- | --- |
| `id` | Unique stable event ID, up to 120 characters; letters, digits, `_`, `-`, `.`, `/`, `:` |
| `type` | One event type listed below |
| `source` | The assigned producer identity listed below |
| `occurredAt` | Actual UTC ISO timestamp ending in `Z`; not a browser-generated display time |
| `data` | Event-specific fields below; unknown fields are rejected |

Retries must preserve the ID, timestamp and entire payload. Exact replay returns
HTTP 200 with `duplicate: true` and does not advance state. A new event returns
201. Reusing an ID with different data returns 409. `version` in the response is
the event's original version; `currentVersion` is the latest snapshot version.
Rejected events never write to the journal or change any panel.

## Producer events

| Type | Source | Required data |
| --- | --- | --- |
| `scan.started` | `scanner` | `runId`, integer `total` |
| `scan.item` | `scanner` | Matching `runId`, unique `itemId`; optionally a discovery (`tokenId`, `symbol`, boolean `candidate`) OR an `error` string |
| `scan.finished` | `scanner` | `runId`; every declared item must have completed |
| `scan.failed` | `scanner` | `runId`, `error` |
| `ai.work` | `codex-1`, `codex-2`, `codex-3` | `taskId`, `task`, `status` (`waiting`, `running`, `done`, `error`), integer `completed`, integer `total` |
| `activity.logged` | `scanner`, `codex-1`, `codex-2`, `codex-3` | `message` (max 300 characters) |
| `market.tick` | `market` | `tokenId`, `symbol`, positive `priceUsd`, nonnegative incremental `volumeUsd` |
| `portfolio.configured` | `operator` | Positive paper-ledger `budgetUsd` |
| `trade.filled` | `paper-ledger` | `fillId`, `positionId`, `mode: "paper"`, `tokenId`, `symbol`, `side: "BUY"` or `"SELL"`, positive `quantity`, positive `priceUsd`, nonnegative `feeUsd` |

Token IDs, fill IDs and position IDs use the event ID character set. A token ID
must keep the same symbol. Numbers must be finite and at most
`Number.MAX_SAFE_INTEGER`. AI progress is derived from work counts, not accepted
as a producer-supplied percentage. A task cannot regress its counter or change
its denominator. CODEX 3 is permanently **Forensic Analyst** in this layer.

## Scanner integration

`runScan({ runId, items, scanOne, publish, signal })` in `state/scanner.cjs` is an
adapter around a supplied scanner function. `runId` is required, unique, max 80
characters. Every item requires a unique `id`.

`scanOne(item, { signal })` must await the actual scan and return either `null`
(no discovery) or `{ tokenId, symbol, candidate }`. A rejected scan is recorded as
a processed failed item; it cannot create a discovery. The adapter emits start,
completed-item and finish/failure events through the provided `publish` function.
Use the running service's HTTP endpoint for an external producer. An in-process
producer can use that service's `store.publish`; do not create a second store.

JEV progress = `floor(100 * processedItems / totalItems)`. It advances only after
an item finishes or fails. Zero items means 0%, with a completed status on finish.
Failures are counted separately and the completed scan is marked ERROR if any
item failed. Discovery counts are unique token counts. There is no background
scanner, default token universe, random result or automatically generated job.

## Ledger and price semantics

- A BUY fill opens/adds to a position. Cost includes the buy fee.
- A SELL fill releases proportional weighted cost, subtracts its sell fee and
  realizes the difference. A partial sell leaves the remaining position open.
- A full sell closes it. A later new position needs a new `positionId`.
- `fillId` is unique independently of envelope ID. Oversells, conflicting token
  identities, closed-position reuse and out-of-order position fills are rejected.
- The table has one row per position, showing its latest BUY/SELL. Entry price is
  fee-inclusive weighted entry cost; exit price is average net proceeds per sold
  unit. Row PnL combines realized PnL and remaining unrealized PnL. It is unknown
  while an open position has no received market mark.
- Overview PnL is today's realized PnL. Total orders counts today's accepted fills.
  Win rate counts profitable closed positions divided by all positions closed
  today (break-even is not a win). The day boundary is Asia/Ho_Chi_Minh. Open
  positions and capital at cost include positions carried from earlier days.
- Budget is unknown until explicitly provided; no balance or seed capital is
  assumed. Observations do not authorize spending or enforce an order limit.
- Paper ledger amounts round to 8 decimal USD places. Quantities use at most 15
  significant digits. A fill's gross notional must round above zero and be at most
  $1 billion. This is not an on-chain settlement engine.
- Price ticks are monotonic per token and form 1-minute OHLCV candles using source
  timestamps. `volumeUsd` is incremental, not a cumulative daily volume. Up to
  2,880 received minute buckets per token are retained; missing bars stay missing.
- Changing timeframe aggregates those received bars; it never fabricates history.
  Price percentage shows change from the first received price, not a claimed 24h
  return. A fill selects its token's chart, but never invents a market tick.
- Accepted work, scan and fill events produce Activity entries. Market ticks do
  not impersonate AI work. Ledger activity is labeled LEDGER, not CODEX 3.

## Persistence and limits

Run one server/writer per journal. Restart replays the ledger and idempotency
keys. A malformed or incomplete journal stops startup loudly; it is never silently
reset or truncated. Preserve the journal when investigating such an error.

This first layer has no journal rotation or external producer authentication.
Events/fills remain on disk for replay; Activity retains the latest 200 entries in
the snapshot. These are deliberate preparation-stage limits, not hidden fallbacks.

The dashboard contains no real-money execution path. `mode` values other than
`paper` are rejected. No scanner/feed or AI worker has been connected yet.
