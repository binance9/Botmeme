# Binding paper-autonomy acceptance contract

Owner requirement recorded 2026-09-24. These are acceptance requirements for the
later architecture, not claims that those modules exist or are approved today.
The frozen dashboard remains in force. Owner sequencing update below supersedes
the former requirement to wait for model acceptance before every implementation.

After START, observation -> reasoning -> decision -> risk veto -> strategy ->
paper execution -> measurement -> learning must run without the owner selecting
tokens, issuing BUY/SELL or choosing a strategy per trade. Human controls are
START, STOP and bounded risk policy. No live financial execution or signing.

CODEX 1 is the decision brain with persistent world state, objectives,
constraints, evidence aggregation, uncertainty, task planning, agent routing,
strategy lifecycle, risk awareness, decision journal and module failure recovery.
It ranks competing candidates, observes regime, commissions research/critique,
and chooses TRADE, WATCH, REJECT, WAIT, REDUCE_RISK, EXIT or NO_ACTION. Candidate
arrival is never automatic permission to BUY. Unknown regime or weak evidence
must reduce risk or prevent new exposure. Commander owns decisions; quant,
forensic, risk, strategy and execution remain separate responsibilities.

Objectives: risk-adjusted return, capital preservation, bounded drawdown/exposure,
improved expectancy and fewer unnecessary/bad entries. Trade count or win rate
alone is not the objective. No guaranteed-profit assumptions are permitted.

JEV Hunter proactively watches the active network's token/pool universe, new
liquidity, volume/price/flow anomalies, momentum and trend changes. It rejects
stale/unreliable observations, ranks candidates and emits attributed candidates.
It never submits orders or promotes production strategies.

CODEX 2 autonomously detects strategy/feature degradation, regime changes and
recurring winner/loser patterns. It forms hypotheses and versioned proposals
with replay, walk-forward, out-of-sample and challenger evidence. CODEX 3
autonomously detects losses, missed opportunities, bad exits, abnormal fills,
drawdown, drift and data/execution anomalies; it emits evidence-backed failure
and root-cause reports and critiques proposals. Promotion requires CODEX 2 ->
CODEX 3 -> CODEX 1 through the controlled lifecycle, never direct model promotion.

MarketRegimeState distinguishes trending, range, high volatility, low liquidity,
momentum expansion/decay, risk-off and unknown (or documented equivalent states).
Regime and confidence must materially affect strategy selection and exposure.
Independent Risk Engine controls exposure, sizing, per-trade risk, concentration,
liquidity, drawdown, cooldown and stop conditions. Its veto always prevents
execution, regardless of the commander's proposed action.

Every AI result carries confidence, evidence_quality, missing_evidence and
uncertainty. Missing facts remain CHUA_XAC_MINH. Every trading decision traces
candidate -> market snapshot -> signals -> regime -> strategy version -> quant
evidence -> critic/risk checks -> commander decision -> execution intent.
Model text alone is not evidence. Record non-trading decisions too.

Durable state includes active candidates, paper positions, strategy versions,
champion/challengers, regime, recent failures, risk state, performance history,
AI tasks and unresolved anomalies. Event-driven tasks respond to new tokens,
quality candidates, degradation, failures, drawdown and regime changes. Bounded
provider polling is allowed where the upstream has no event feed; internal work
must not rely on blind loops or manual prompts.

Trade results feed telemetry and attribution (signal, entry, exit, regime,
timing, liquidity, slippage, sizing, strategy, execution), then quant learning,
forensic critique and commander lifecycle decisions. Learn from wins, losses,
missed opportunities and whether avoiding a trade was appropriate. Persistent
underperformance triggers reduced sizing, stronger evidence thresholds,
cooldown, weak-strategy disablement and forensic/challenger evaluation.

Network changes are semantic boundaries, not label changes. Separate SOLANA,
ETHEREUM, BSC and ROBINHOOD adapters must identify chain/network and capabilities.
Active selection changes discovery universe, provider/market subscriptions and
network-qualified identities. Cancel or quarantine old-network work; reject stale
events from the previous selection. Open positions/history retain their original
network and remain visible/accounted for; never reinterpret balances or tokens.
No adapter may use another network's scanner as an undisclosed fallback. Unknown
provider/protocol support blocks scanning/trading with CHUA_XAC_MINH. Robinhood's
exact supported chain/provider must be verified from evidence before enabling it.

JEV Auditor must inspect implementation and real runtime evidence for proactive
discovery, genuine commander decisions, independent proposals/critique, risk
veto, effective NO_ACTION, regime effects, feedback, versioned lifecycle,
traceability, persistent memory, network switching and recovery from AI failure.
Files existing, prompt-response demos or fabricated trading streams cannot prove
autonomy. Modules absent or unverified stay CHUA_XAC_MINH, never FINAL PASS.

Owner-directed wallet acceptance sequence (2026-09-24): finish implementation
and its technical prerequisite checks, then notify the owner to connect the wallet.
Wallet integration and end-to-end paper tests must wait for a confirmed owner
connection. Readiness to connect is not FINAL PASS; final acceptance follows
those tests. Never infer connection from elapsed time or enable live signing.

Latest owner sequencing update (2026-09-24): when slow reviewer calls impede
progress, complete and technically verify the module, wire it, and continue new
implementation. JEV compares and scans alongside development; unresolved review
is PENDING, never PASS. Known functional/security defects still require repair.
This authorization does not fabricate auditor receipts, change acceptance-gate
results, permit unverified legacy ports, or authorize live financial execution.
Final paper-system integration follows confirmed wallet connection; failures
return to their owning module. Historical Stage 2 acceptance locks describe
acceptance status, not the owner's newly authorized implementation sequence.
