# Activity Live / verification instance — 2026-09-24

## Status and task-count increment (20:05 local)

Implemented in dashboard/adapter/index.cjs and core/market-data/service.cjs:
- JEV status/task follows latest persisted Hunter/scanner activity, including
  equal timestamps; an older Hunter message cannot hide a new scan failure.
- Scanner progress retains MARKET_DATA attribution. Failure/stop messages expose
  a bounded reason, never raw provider errors or invented observations.
- AI completed-task counts use each task's latest event in the active epoch.
  Duplicate completion messages do not inflate totals; waiting/failed/reopened
  tasks are not completed. Counts never manufacture a progress percentage.
- Regression cases added to tests/dashboard-adapter.test.cjs and
  tests/market-data.test.cjs.

Verification/deployment boundaries:
- activity-state-20260924-195720: 177/177 remote runtime tests; source manifest
  unchanged. Status/reason changes deployed on existing port 7882, PID 30968.
  Restart preserved and verified all 1,143 journal records; retired lock retained.
- Actual Chrome inspection showed FAILED + explicit provider-rate-limit reason,
  scan 3/5, two candidates, a fresh real price chart, and wallet budget $26.43.
- activity-counts-20260924-200140: 178/178 remote runtime tests; source manifest
  unchanged. Task-count addition is ON DISK ONLY, NOT YET DEPLOYED. Automatic
  approval review rejected the combined verified restart/journal-recovery
  command with "blocked by policy", without a specific reason. No part of that
  command ran. Existing 7882 remains running with the status/reason revision;
  no extra instance was created to work around the rejection.
- Actual Qwen3-32B advisory initially made claims contradicted by supplied tests
  (including interpreting expected null as retained scan). Negative analysis is
  preserved in activity-counts-20260924-200140/jev-review.json and is not treated
  as deterministic acceptance. A bounded second evidence reconciliation returned
  UNKNOWN for all five allegations; its issued IDs are valid but its explanations
  still misread assertions. See jev-reconciliation.json. No JEV PASS was granted.

Still NOT FINAL PASS. Provider 429, full model/autonomy/wallet-switch acceptance
and official JEV gates are unresolved. The public-session restoration is read-only
address metadata, not proof of a new browser wallet SDK session or signing access.

## Historical provider increment

## Provider follow-up (19:50 local)

The latest verification instance is http://127.0.0.1:7882/meme-trader/,
PID 8260 at launch. Its journal is data/verification-provider-20260924/runtime.jsonl,
copied byte-for-byte from the stopped 7881 paper instance with copy-receipt.json.
7880 and 7881 paper loops remain stopped. No legacy source or dashboard layout changed.
The existing read-only public wallet metadata was restored; no signing session
or secret was copied. Only 7882 runs paper.

Provider changes reuse validated discovery pool data for at most 30 seconds,
retain timestamped trade requests, adapt request spacing after 429, and process
three active trending pools before two new pools to prevent starvation. Expired
pool data still requires a fresh validated request. Application request timeout
is 30 seconds to accommodate bounded pacing.

Evidence:
- data/remote-tests/provider-priority-20260924-194744/runtime-tests.receipt.json:
  176/176 remote component tests, unchanged manifest. This is not FINAL PASS.
- data/remote-tests/provider-20260924-194249/additional-tests.tap: 17/17 wallet,
  capital, chart, activity and OKX regression checks on the preceding cache/pacing
  revision (before discovery ordering changed).
- data/provider-verification/adaptive-1790253915052/scan.json: 429 persisted;
  slower second round obtained four samples before throttle, versus three first.
- data/provider-verification/priority-1790254112930/scan.json: three active samples
  aged 11–19 seconds, then 429. Exact source hash and raw response evidence saved.
- Same directory jev-review.json: actual Qwen3-32B advisory through JEV reviewer
  adapter with host-issued hash IDs; unresolved 429 reported. Advisory only,
  CHUA_XAC_MINH, not a registered deterministic acceptance receipt.
- Actual 7882 browser showed scan 4/5, found 3, failed 1; wallet budget $26.35.
  Its first production scan returned stale observations, so Hunter waited and
  chart stayed empty. Freshness requirements were NOT weakened to display them.

Outstanding provider throttling/freshness is not resolved. No claim of completed
autonomy, model wiring, migration acceptance or full-system JEV PASS follows.

## Previous increment (historical)

Owner reported old-looking lines with thousands of trades, scan 630/200 and
CODEX 3 executing POPCAT orders. Current 7880 API did not contain those lines.
Equivalent canned messages exist in historical UI test artifacts. The precise
origin of the owner's tab remains UNVERIFIED pending its URL; no claim that
the user's tab was inspected or repaired has been made.

Implemented:
- Typed ScanProgress counters with bounds, emitted from settled scanner work.
- Dashboard counts project those events, rather than parse English messages.
- Activity rejects missing attribution and uses actual producer for labels.
- PAPER_EXECUTION is labelled PAPER, never CODEX 3 through a misleading agentId.
- Existing rows expose event ID, producer, source and correlation in attributes
  and hover text. No new panel or dashboard layout change.

Verification:
- First run-20260924-193419: 175/176, a test selected the last event assuming it
  was AIActivityEvent. It was updated to select that event type explicitly and
  additionally assert the new ScanProgress counters. Negative receipt retained.
- run-20260924-193651: 176/176 runtime, unchanged source manifest; 17/17 additional
  wallet/capital/chart/activity/OKX tests. Component evidence, not JEV FINAL PASS.
- Actual browser on port 7881 showed scan 2/5, failed 1, found 1, candidates 0;
  CODEX 2 reported insufficient history. No fake execution/learning rows added.
- live-activity.json compares current Activity IDs/producers to persisted journal.

Deployment:
The existing 7880 paper loop was stopped through its API. No process termination
or journal-lock deletion was used. Its hash-verified 545-record journal was copied
without overwriting into data/verification-20260924/runtime.jsonl. The new backend
is on 127.0.0.1:7881 (PID 31876 at launch); only this instance runs paper.
Start configuration uses BOTMEME_PORT and BOTMEME_JOURNAL (under project data).
The old 7880 backend/journal remain preserved and must not be started in parallel.

The 25-second independent wallet refresh is now running on 7881, verified by new
WalletValuation events while paper/scanner were stopped. This supersedes the
deployment blocker described in WALLET-CAPITAL.md for the verification instance;
the old 7880 code is still unchanged in memory.

Outstanding: identify the exact tab showing the owner's canned rows; market API
429 limits still produce honest failed scans; model routing for CODEX 1/2/3,
real wallet network-switch E2E, independent JEV migration/module acceptance and
full autonomous paper acceptance remain incomplete. No FINAL PASS.
