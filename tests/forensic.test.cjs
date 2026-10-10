'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createRuntime } = require('../runtime/events/bus.cjs');
const { createTradeStore } = require('../core/trades/store.cjs');
const { createForensic } = require('../services/forensic/service.cjs');
const { createQuant } = require('../services/quant/service.cjs');
const at = '2026-09-24T10:00:00.000Z', now = () => new Date('2026-09-24T11:00:00.000Z');
function event(id, type, producer, payload, extra = {}) { return { id, type, timestamp: at, producer, source: 'forensic-test-case', evidence: ['observed/' + id], status: type === 'TradeResult' ? 'COMPLETED' : 'OBSERVED', correlationId: 'correlation/' + id, network: 'SOLANA', epoch: 1, confidence: .9, evidence_quality: .9, uncertainty: .1, missing_evidence: [], payload, ...extra }; }
function market(id, price = 10, observedAt = at) { return event(id, 'MarketSnapshot', 'MARKET_DATA', { token: 'token', price, liquidityUsd: 100000, volume24hUsd: 200000, observedAt }); }
function fill(rawRuntime, id, side, price, { observedAt = null, referencePrice = price, strategyVersion = 'v1', quantity = 1, realizedPnl = 999 } = {}) {
  const timestamp = rawRuntime.snapshot().events.at(-1)?.timestamp ?? at;
  const runtime = { publish: e => rawRuntime.publish({ ...e, timestamp }) };
  const snapshot = market('snapshot/' + id, price, observedAt ?? timestamp); runtime.publish(snapshot);
  runtime.publish(event('candidate/' + id, 'TokenCandidate', 'JEV', { token: 'token', symbol: 'TEST', snapshotId: snapshot.id, liquidityUsd: 100000, volume24hUsd: 200000, rank: 1, anomalies: [] }));
  runtime.publish(event('signal/' + id, 'SignalObservation', 'JEV', { candidateId: 'candidate/' + id, snapshotId: snapshot.id, signals: [{ name: 'momentum', value: .1 }] }));
  runtime.publish(event('regime/' + id, 'MarketRegimeState', 'MARKET_DATA', { regime: 'TRENDING', snapshotIds: [snapshot.id], reason: 'Observed test regime' }));
  const trace = { candidateId: 'candidate/' + id, snapshotId: snapshot.id, signalIds: ['signal/' + id], strategyVersion, decisionId: 'decision/' + id, riskDecisionId: 'risk/' + id }, correlationId = 'correlation/' + id;
  runtime.publish(event(trace.decisionId, 'StrategyDecision', 'CODEX_1', { candidateId: trace.candidateId, snapshotId: trace.snapshotId, signalIds: trace.signalIds, strategyVersion, quantEvidenceIds: [], criticReportIds: [], regimeId: 'regime/' + id, action: side, disposition: side === 'BUY' ? 'TRADE' : 'EXIT', reason: 'Test trace decision' }, { correlationId }));
  runtime.publish(event(trace.riskDecisionId, 'RiskDecision', 'RISK_ENGINE', { decisionId: trace.decisionId, approved: true, quantity, maxExposureUsd: 1000, reason: 'Test risk budget' }, { status: 'APPROVED', correlationId }));
  runtime.publish(event('intent/' + id, 'ExecutionIntent', 'STRATEGY_ENGINE', { mode: 'paper', token: 'token', ...trace, action: side, quantity, referencePrice }, { status: 'APPROVED', correlationId }));
  runtime.publish(event(id, 'TradeResult', 'PAPER_EXECUTION', { mode: 'paper', token: 'token', ...trace, intentId: 'intent/' + id, side, quantity, entryPrice: side === 'BUY' ? price : 1234, exitPrice: side === 'BUY' ? null : price, realizedPnl: side === 'BUY' ? 0 : realizedPnl, fees: 0, slippageBps: 0, state: side === 'BUY' ? 'OPEN' : 'CLOSED' }, { correlationId }));
}
function setup(t, policy = {}) {
  const runtime = createRuntime({ now }), store = createTradeStore({ runtime, now }), forensic = createForensic({ runtime, tradeStore: store, now, policy });
  forensic.start(); t.after(async () => { forensic.stop(); await runtime.close(); }); return { runtime, store, forensic };
}
test('forensic loss uses computed basis, preserves unknown cause and emits no orders', async t => {
  const { runtime } = setup(t); fill(runtime, 'buy', 'BUY', 10); fill(runtime, 'sell', 'SELL', 8, { realizedPnl: 900 }); await runtime.flush();
  assert.deepEqual(runtime.snapshot().deliveryErrors, []);
  const report = runtime.snapshot().events.find(e => e.type === 'RootCauseReport');
  assert.equal(report.payload.category, null); assert.equal(report.status, 'CHUA_XAC_MINH'); assert.ok(report.missing_evidence.length);
  assert.ok(report.evidence.every(id => runtime.get(id))); assert.ok(!runtime.snapshot().events.some(e => e.producer === 'CODEX_3' && ['ExecutionIntent', 'StrategyDecision'].includes(e.type)));
});
test('forensic measures fill slippage independently of claimed zero and identifies stale data', async t => {
  const { runtime } = setup(t); fill(runtime, 'buy', 'BUY', 11, { referencePrice: 10, observedAt: '2026-09-24T09:58:00.000Z' }); await runtime.flush();
  assert.deepEqual(runtime.snapshot().deliveryErrors, []);
  assert.deepEqual(runtime.snapshot().events.filter(e => e.type === 'RootCauseReport').map(e => e.payload.category).sort(), ['DATA_FAILURE', 'EXECUTION_FAILURE']);
});
test('forensic does not classify a computed winner as loser from claimed PnL', async t => {
  const { runtime } = setup(t); fill(runtime, 'buy', 'BUY', 10); fill(runtime, 'sell', 'SELL', 12, { realizedPnl: -999 }); await runtime.flush();
  assert.deepEqual(runtime.snapshot().deliveryErrors, []); assert.equal(runtime.snapshot().events.filter(e => e.type === 'FailureReport').length, 0);
});
test('forensic automatically critiques real quant output without paper or promotion claims', async t => {
  const { runtime } = setup(t), quant = createQuant({ runtime, now, policy: { thresholds: [.01], horizons: [1] } }); quant.start(); t.after(() => quant.stop());
  for (let i = 0; i < 40; i++) { const timestamp = new Date(Date.parse(at) + i * 1000).toISOString(); const m = market('history/' + i, 100 * 1.02 ** i, timestamp); m.timestamp = timestamp; runtime.publish(m); }
  await runtime.flush(); assert.deepEqual(runtime.snapshot().deliveryErrors, []);
  const critiques = runtime.snapshot().events.filter(e => e.type === 'ProposalCritique'); assert.equal(critiques.length, 1);
  assert.equal(critiques[0].payload.verdict, 'SUPPORTED'); assert.deepEqual(critiques[0].payload.paperTradeIds, []); assert.match(critiques[0].payload.reason, /not yet validated/);
  assert.ok(critiques[0].evidence.every(id => runtime.get(id))); assert.equal(runtime.snapshot().events.filter(e => e.type === 'StrategyLifecycleDecision').length, 0);
});
test('forensic stop and restart are idempotent and policy cannot reduce five paper observations', async t => {
  const { runtime, forensic, store } = setup(t); fill(runtime, 'buy', 'BUY', 11, { referencePrice: 10 }); await runtime.flush();
  const count = runtime.snapshot().events.length; forensic.stop(); forensic.start(); await runtime.flush(); assert.equal(runtime.snapshot().events.length, count);
  assert.throws(() => createForensic({ runtime, tradeStore: store, policy: { minPaperTrades: 1 } }), /INVALID_FORENSIC_POLICY/);
});
test('forensic rejects negative research and marks overlapping OOS evidence unknown', async t => {
  const { runtime } = setup(t), quant = createQuant({ runtime, now, policy: { thresholds: [.01], horizons: [1] } }); quant.start();
  for (let i = 0; i < 40; i++) { const timestamp = new Date(Date.parse(at) + i * 1000).toISOString(); const m = market('research/' + i, 100 * 1.02 ** i, timestamp); m.timestamp = timestamp; runtime.publish(m); }
  await runtime.flush(); quant.stop();
  const proposal = runtime.snapshot().events.find(e => e.type === 'StrategyProposal' && e.payload.lifecycle === 'CHALLENGER');
  assert.ok(proposal);
  const bt = runtime.get(proposal.payload.backtestId), wf = runtime.get(proposal.payload.walkForwardId);
  for (const kind of ['negative', 'overlap', 'version']) {
    const badBt = structuredClone(bt), badWf = structuredClone(wf), changed = structuredClone(proposal);
    badBt.id = 'backtest/' + kind; badWf.id = 'walkforward/' + kind; changed.id = 'proposal/' + kind;
    if (kind === 'negative') badBt.payload.expectancy = -1;
    if (kind === 'version') changed.payload.strategyVersion = 'other-version';
    badWf.payload.backtestId = badBt.id; badWf.evidence = kind === 'overlap' ? [...badBt.evidence] : [...wf.evidence];
    changed.payload.backtestId = badBt.id; changed.payload.walkForwardId = badWf.id;
    changed.evidence = [bt.payload.proposalId, badBt.id, badWf.id];
    runtime.publish(badBt); runtime.publish(badWf); runtime.publish(changed); await runtime.flush();
    const review = runtime.snapshot().events.find(e => e.type === 'ProposalCritique' && e.payload.proposalId === changed.id);
    assert.ok(review); assert.equal(review.payload.verdict, kind === 'overlap' ? 'CHUA_XAC_MINH' : 'REJECTED');
  }
  assert.deepEqual(runtime.snapshot().deliveryErrors, []);
});
test('forensic requires complete paper cycles and re-critiques using computed results', async t => {
  const { runtime } = setup(t), quant = createQuant({ runtime, now, policy: { thresholds: [.01], horizons: [1] } }); quant.start();
  for (let i = 0; i < 40; i++) { const timestamp = new Date(Date.parse(at) + i * 1000).toISOString(); const m = market('paperhistory/' + i, 100 * 1.02 ** i, timestamp); m.timestamp = timestamp; runtime.publish(m); }
  await runtime.flush(); quant.stop();
  const proposal = runtime.snapshot().events.find(e => e.type === 'StrategyProposal' && e.payload.lifecycle === 'CHALLENGER'), strategyVersion = proposal.payload.strategyVersion;
  const review = () => runtime.snapshot().events.filter(e => e.type === 'ProposalCritique').at(-1);
  fill(runtime, 'partial-buy', 'BUY', 10, { strategyVersion, quantity: 6 });
  for (let i = 0; i < 5; i++) fill(runtime, 'partial/' + i, 'REDUCE', 11, { strategyVersion });
  await runtime.flush(); assert.equal(review().payload.verdict, 'CHUA_XAC_MINH'); assert.match(review().payload.reason, /cycles/);
  fill(runtime, 'close-first', 'SELL', 11, { strategyVersion });
  for (let i = 0; i < 4; i++) { fill(runtime, 'cycle-buy/' + i, 'BUY', 10, { strategyVersion }); fill(runtime, 'cycle-sell/' + i, 'SELL', 11, { strategyVersion, realizedPnl: -123 }); }
  await runtime.flush(); assert.deepEqual(runtime.snapshot().deliveryErrors, []);
  assert.equal(review().payload.verdict, 'SUPPORTED'); assert.match(review().payload.reason, /Computed closed paper/); assert.equal(review().payload.paperTradeIds.length, 10);
});

