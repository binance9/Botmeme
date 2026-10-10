# Botmeme implementation status

## Safety gate + Jev decision + protective exits increment — 2026-09-27

Owner-ordered build-out of docs/MASTER-PLAN-CODEX6-JEV.md steps [2], [4], [5].
All changes verified by component tests on this machine; no FINAL PASS, no JEV
acceptance, no live trading. Bot remains paper-only and stopped until the owner
connects a wallet and STARTs.

Implemented:

- `core/safety/gate.cjs` — fail-closed hard veto per TokenCandidate: liquidity
  floor, pool-age window, market-cap ceiling, and (via pluggable reader) on-chain
  metadata: mint authority revoked, freeze authority revoked, LP lock floor,
  top-10 holder ceiling, insider-holder ceiling, RugCheck risk-score ceiling.
  Unverifiable metadata REJECTS. A later Jev REJECT supersedes an approval
  (`jev-veto` SafetyDecision); paper reads the latest verdict per candidate.
- `core/safety/rugcheck.cjs` — RugCheck adapter for Solana mints; live contract
  verified against the public report endpoint; unparsable reports fail closed.
- `services/jev/decision/service.cjs` + `jev-client.cjs` — one batched TypeSafe
  System One call per candidate (noul + score + choice) with confidence and
  guardrail validation; any API failure degrades to NO_ACTION/CHUA_XAC_MINH and
  the pipeline continues on rule-quant. Jev is advisory; TypeSafe is never an
  acceptance provider.
- `core/risk/exit-manager.cjs` — protective exits for open meme-flow positions:
  stop-loss 5%, take-profit 15%, trailing stop 8% from the high-water mark.
  Exits are ordinary StrategyDecisions (producer EXIT_MANAGER) still vetted by
  the independent risk engine.
- `core/execution/paper.cjs` — BUY now requires an approved SafetyDecision for
  its candidate (`requireSafetyVerdict: true` in production wiring; the flag
  defaults false so legacy unit compositions are unchanged), and meme SELL/REDUCE
  intents settle immediately on the triggering quote like meme buys, because a
  protective exit that waits one scan interval would always be too late.
- `runtime/application.cjs` — safety gate, Jev decision, exit manager wired into
  the module chain before paper execution.
- Contracts: SafetyDecision and JevVerdict types, SAFETY_GATE/EXIT_MANAGER
  producers, status rules; signalIds minimum relaxed to 0 so protective exits
  can carry no signals. Contract-count test updated to the extended registry.

Test receipts (local, this machine, 2026-09-27):

- `npm run test:runtime` — 66/66. `npm run test:auditor` — 168/168.
- application-control + dashboard-adapter + server-control — 19/19. OKX session — 3/3.
- New `npm run test:safety` — safety gate 7/7, exit-manager integration 3/3
  (full chain: gate -> decision -> risk -> intent -> paper fill OPEN -> protective
  exit CLOSED with correct PnL sign), Jev decision service 1/1 (live API),
  Jev client 13/13 (live API, no mocks).
- Evidence limits: no Runpod cross-check of this increment yet; no official JEV
  auditor receipt; dashboard adapter does not yet project SafetyDecision/
  JevVerdict (UI rework is owner-planned after the bot loop is complete).

Remaining before any real capital: owner wallet connection, provider 429 pacing
unresolved, JEV auditor receipt for this increment, dashboard/UI alignment, and
a full autonomous paper run the owner reviews. No profitability claim is made or
implied by any test above.

## OKX QR and wallet-follow increment — 2026-09-24

- Owner clarified OKX Wallet. Native `@okxconnect/universal-provider` 1.9.1 now
  generates an actual connection QR inside the bottom-left Wallet panel; no
  WalletConnect Project ID is needed for this native SDK flow. An actual QR was
  generated and visually checked in the owner's Chrome tab. Wallet approval and
  live network-change delivery are still pending; QR generation is not connection.
- SDK pairing storage is scoped to an in-memory bundle wrapper, separate from
  browser localStorage. No wallet signing/transaction methods are invoked. The
  optional approved chains support later switching; unapproved/unknown chains
  cannot be accepted just from a chain label.
- `/api/wallet/change` validates public metadata, stops old acquisition, advances
  the network epoch, retains journal/history, and resumes only if already running.
  Invalid metadata stops/disconnects. Injected EVM and native OKX events are wired;
  cross-network behavior must still be checked on the owner's actual session.
- Runpod source snapshot `run-20260924-184547`: 171/171 component tests and 3/3
  OKX public-session contract tests passed. The subsequent accountChanged listener
  and QR CSS clipping fix were built/viewed locally, not covered by that receipt.
- Server restarted with the new code. Its old PID lock was recovered only after
  verifying the old process had exited and all four journal records' hash links.
  No journal data was deleted or reset. Bot remains paper-only and stopped until
  wallet connection and START.

Created: `wallet/connection/okx-entry.mjs`, `wallet/connection/okx-session.mjs`,
`scripts/build-wallet.cjs`, `public/meme-trader/wallet-sdk.js`,
`tests/okx-session.test.cjs`.
Modified: `runtime/application.cjs`, `scripts/serve-meme-trader.cjs`,
`public/meme-trader/wallet.js`, `wallet.css`, `index.html`,
`tests/application-control.test.cjs`, `package.json`, `package-lock.json`.
Build: `node scripts/build-wallet.cjs`. Serve: `npm start` (port 7880).
Main `app.js` and `styles.css` remain unchanged. No FINAL PASS.

## Current increment — 2026-09-24 (supersedes historical status below)

Implementation continues in Botmeme only. No FINAL PASS or JEV acceptance.
Owner supplied Runpod access. The pod has a running Qwen3-32B model (32B
parameters) and now an isolated Botmeme verification directory. The remote
component run passed 169/169 with matching source/log hashes; see
`RUNPOD-VERIFICATION.md` and `data/remote-tests/run-20260924-182137`.
The added JEV model adapter/identity changes passed a separate 195/195 remote
regression in `run-20260924-182536`. Real schema transport was verified after
fixing the deployed server's nested JSON-schema request format. The first real
32B review returned FAIL for fixed-profile-cli (receipt
`1f9dbd46-18c4-46cd-8620-1f09ef841285`), citing source/runtime path evidence gaps.
This negative result is preserved; no migration plan or full-system PASS follows.

Implemented source, awaiting combined verification:

- 17 typed contracts, durable runtime, Hunter, regime classification, autonomous
  quant replay, forensic critique, Commander decisions/lifecycle, independent
  risk veto, next-observation paper execution, and computed trade/performance store.
- `runtime/application.cjs` composes these services. Startup remains stopped;
  START requires a connected public wallet session. STOP cancels acquisition and
  consumers. Network selection stops work, changes epoch/provider and disconnects
  the old wallet. REST acquisition is paced; AI work is event-driven.
- `dashboard/adapter/index.cjs` projects the same runtime/store into the frozen
  dashboard. Actual scan events supply JEV progress. Accounting supplies position
  cycle state and returns; the frontend does not calculate trading results.
- `scripts/serve-meme-trader.cjs` production path now uses the application/adapter,
  refuses public event injection, and exposes bounded wallet/control endpoints.
  Explicit legacy journal mode remains for existing transport regression only.
- Four separate public-session network adapters; bottom-left wallet control,
  hidden network selection and nested QR camera. Main app.js/styles.css unchanged.
  Index additions are authorized wallet changes, not an unchanged file hash.
- Timestamped GeckoTerminal provider and conservative DexScreener adapter.
  Duplicate/older observations do not inflate history. Regime history uses a
  separate 30-minute window while current quote freshness stays 60 seconds.

Evidence limits:

- Initial dashboard adapter tests: 5/5 before later accounting/progress changes.
- Server plus legacy regression: 21/22; remaining Host transport test corrected
  to use node:http, but not rerun after the remote-test instruction.
- Market deduplication plus Dex tests: 15/15; regime plus market: 16/16, completed
  before the hold message arrived. These are component checks, not full acceptance.
- Application-control tests, expanded adapter/accounting assertions, corrected
  server test and expanded JEV inspection coverage were included in the 169/169
  remote component run. This does not establish semantic JEV acceptance.
- Internal JEV technical inspection covers the new sources/tests but has not
  issued a current receipt. Existing frozen-index hash comparison will flag the
  authorized wallet addition; baseline has not been overwritten to hide this.
- The dashboard server was restarted onto the new application on 2026-09-24.
  GET /api/control reports paper mode, SOLANA, stopped, wallet disconnected.
  The owner's Chrome tab was reloaded and shows the new bottom-left Wallet
  control and START action. Full bot testing is waiting for the owner's real
  wallet connection as requested; live provider availability, Robinhood feed
  coverage and browser wallet operation remain unverified.
- QR camera decoding is implemented, but WalletConnect session pairing still
  requires its configuration/implementation; decoding is not wallet connection.
- Full paper bot E2E awaits the owner's actual wallet connection. No signing,
  real orders, secret storage or claim of profitable strategy.

Files created in this continuation: `runtime/application.cjs`,
`tests/application-control.test.cjs`, `dashboard/adapter/index.cjs`,
`tests/dashboard-adapter.test.cjs`, `tests/server-control.test.cjs`.
Files modified in this continuation: `scripts/serve-meme-trader.cjs`,
`core/market-data/service.cjs`, `core/market-data/regime.cjs`,
`core/performance/project.cjs`, their corresponding tests,
`services/jev/auditor/technical-inspection.cjs`, its test and this document.

## Historical checkpoint

Owner changed sequencing on 2026-09-24: technical verification permits continued
new implementation while JEV comparison/inspection remains pending. This is an
owner-authorized workflow change, not a JEV PASS or an accepted migration plan.

Owner role assignment reaffirmed: Codex implements, diagnoses and fixes. JEV
performs scanning, comparison and test-result assessment. Codex may execute
technical checks to collect logs for JEV; those logs and independent coding-agent
inspections must never be described as JEV acceptance. The internal JEV service
is the named review authority, not TypeSafe or a renamed coding sub-agent.

- Dashboard: frozen; no layout changes.
- Legacy: unchanged. 85 decisions remain 56 DROP / 22 PORT / 7 REWRITE.
- Auditor: CHUA_XAC_MINH. Latest official receipt
  `3446674d-be96-4bab-9374-799b5c8c076c` rejected unsupported claims. No freeze.
- Auditor regression: 204/204 before latest schema-description refinement;
  relevant reviewer regression after refinement: 121/121.
- Contracts/events: 15 exact typed envelopes; producer boundaries, network epoch,
  uncertainty and paper-only execution validated. Technical checks passed;
  official JEV acceptance pending.
- Runtime/state/telemetry: hash-linked exclusive-writer journal, trace checks,
  risk-veto/fill-size boundaries, bounded delivery, network quarantine and durable
  consumer acknowledgments. Unacknowledged active-network work replays at least
  once; consumers must make their effects idempotent. Technical checks passed;
  official JEV acceptance pending.
- JEV Hunter: market-event research discovery, quality/freshness/liquidity checks,
  momentum and volume/liquidity observations, ranked candidates, replay recovery.
  Heuristic research thresholds are not a validated trading strategy.
- Market data: provider interface and discovery lifecycle wired to runtime/Hunter
  in `runtime/market-runtime.cjs`. Actual provider adapters and production feed
  verification remain pending; interface tests are not live-market acceptance.
- New research runtime is not yet attached to the running dashboard server.
- Commander, quant, forensic, strategy, risk engine, paper execution, new trade/
  performance projection, wallet/network, dashboard adapter and autonomy
  integration: pending. Trace validation is not a completed Risk Engine.
- Wallet integration/full paper acceptance: wait for owner's connected wallet.

Technical verification, JEV acceptance and full-system acceptance are distinct.
No model timeout or favorable prose can manufacture acceptance evidence.

Latest technical check: `npm run test:runtime` — 59 tests, 59 passed, 0 failed,
0 skipped. Includes real filesystem journal/restart/alias checks and existing
HTTP/SSE regression. Provider fixtures test interfaces only; no full bot test,
wallet connection, signing or live execution has occurred.

New files in this increment:

- `runtime/contracts/schema.cjs`, `types.cjs`, `index.cjs`
- `runtime/events/bus.cjs`, `runtime/state/trace.cjs`
- `runtime/telemetry/journal.cjs`, `runtime/market-runtime.cjs`
- `services/jev/hunter.cjs`, `core/market-data/service.cjs`
- `tests/runtime-contracts.test.cjs`, `runtime-events.test.cjs`,
  `runtime-trace.test.cjs`, `runtime-recovery.test.cjs`, `hunter.test.cjs`,
  `market-data.test.cjs`
- This implementation-status document.

Modified: `package.json` (test:runtime command),
`docs/AUTONOMOUS-INTELLIGENCE.md` (owner's updated sequencing),
`services/jev/auditor/readback.cjs` (field-local review guidance).

Remaining operational boundaries: stale lock after unclean process exit needs
explicit recovery; anonymous live subscriptions have no replay guarantee—use
stable durable consumer IDs for automation. Cooperative cancellation cannot
forcibly stop arbitrary JavaScript; producers still pass epoch/trace validation.
