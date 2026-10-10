# Botmeme realtime dashboard

Run independently from this folder:

```powershell
cd C:\Botmeme
npm start
```

Open http://127.0.0.1:7880/meme-trader/ . Node is the only runtime requirement.
The accepted layout, CSS and image assets are unchanged. CODEX 3 now displays
Forensic Analyst.

The dashboard has no sample market data, initial fake trades, random progress or
invented activity. It waits for producer events. One server-owned event store
supplies all AI cards, scan counters, market candles, positions, PnL and activity.
State is streamed over SSE and restored from `data/events.jsonl` after restart.
No wallet, real-money order execution, market feed or AI worker is connected.

Read [the state/event contract](docs/STATE-EVENTS.md) for endpoint schemas, scanner
adapter integration, replay behavior and paper-ledger accounting rules.

Verification:

```powershell
npm install
npm test
npm run test:ui
```

The browser test starts its own local server and temporary journal. Its explicit
fixture events never enter the dashboard on port 7880. It checks atomic BUY/SELL
updates in two browsers, reconnect/restart, honest waiting states, XSS-safe event
rendering, both themes and responsive layout. Reports and screenshots are saved
under `tests/artifacts/realtime-state/`. Earlier UI/color receipts remain under
`tests/artifacts/meme-trader/` as historical evidence.

Scope lesson: keep this project entirely in C:\Botmeme. Runtime state belongs on
the server; the UI must never manufacture producer progress or trading records.

Internal JEV Auditor (local Ollama must be running with `qwen3:14b` installed):

```powershell
npm run test:auditor
npm run audit:jev -- auditor-contract
npm run audit:jev -- auditor-agent
npm run audit:jev -- auditor-collector
npm run audit:jev -- auditor-dependencies
npm run audit:jev -- auditor-integrity
npm run audit:jev -- auditor-evidence-registry
npm run audit:jev -- auditor-acceptance
npm run audit:jev -- auditor-attribution
npm run audit:jev -- auditor-cli
```

The host collects source, exact initial/delta evidence, architecture, dependency
hashes and real fixed-command logs, then invokes a separate local reasoning model.
The evidence registry issues the only selectable IDs. The model supplies analysis;
the deterministic gate requires host-owned proof obligations and current bound
source/runtime evidence. Receipts under `data/audits/` include `receipt_id`,
`source_hash`, `evidence_ids`, missing evidence, findings and fixes. A test run
alone is not JEV approval. v1 receipts cannot authorize v2 acceptance.
Exit codes: 0 bounded PASS, 2 FAIL, 3 CHUA_XAC_MINH.
See [the auditor contract](docs/JEV-AUDITOR.md). The legacy migration and later
architecture stages remain locked until independently accepted.
