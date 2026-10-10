'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('../runtime/events/bus.cjs');
const at = '2026-09-24T09:00:00.000Z';
function event(id, type, producer, payload, status = 'OBSERVED') {
  return { id, type, producer, payload, status, timestamp: at, source: 'trace-contract-test', evidence: ['record-1'], correlationId: 'research-1', network: 'SOLANA', epoch: 1, confidence: 0.8, evidence_quality: 0.8, missing_evidence: [], uncertainty: 0.2 };
}
function setup(t, approved = true) {
  const runtime = createRuntime({ now: () => new Date(at) }); t.after(() => runtime.close());
  runtime.publish(event('snapshot', 'MarketSnapshot', 'MARKET_DATA', { token: 'token', price: 2, liquidityUsd: 10000, volume24hUsd: 30000, observedAt: at }));
  runtime.publish(event('candidate', 'TokenCandidate', 'JEV', { token: 'token', symbol: 'TOK', snapshotId: 'snapshot', liquidityUsd: 10000, volume24hUsd: 30000, rank: 1, anomalies: [] }));
  runtime.publish(event('signal', 'SignalObservation', 'JEV', { candidateId: 'candidate', snapshotId: 'snapshot', signals: [{ name: 'volume', value: 2 }] }));
  runtime.publish(event('regime', 'MarketRegimeState', 'MARKET_DATA', { regime: 'TRENDING', snapshotIds: ['snapshot'], reason: 'Test trace identity only.' }));
  runtime.publish(event('decision', 'StrategyDecision', 'CODEX_1', { candidateId: 'candidate', snapshotId: 'snapshot', signalIds: ['signal'], strategyVersion: 'version-1', quantEvidenceIds: [], criticReportIds: [], regimeId: 'regime', action: 'BUY', disposition: 'TRADE', reason: 'Trace tests do not authorize a strategy.' }));
  runtime.publish(event('risk', 'RiskDecision', 'RISK_ENGINE', { decisionId: 'decision', approved, quantity: approved ? 10 : 0, maxExposureUsd: 20, reason: 'Trace test boundary.' }, approved ? 'APPROVED' : 'REJECTED'));
  return runtime;
}
const trace = { token: 'token', candidateId: 'candidate', snapshotId: 'snapshot', signalIds: ['signal'], strategyVersion: 'version-1', decisionId: 'decision', riskDecisionId: 'risk' };
const intent = () => event('intent', 'ExecutionIntent', 'STRATEGY_ENGINE', { ...trace, mode: 'paper', action: 'BUY', quantity: 10, referencePrice: 2 }, 'APPROVED');
const fill = (id, quantity) => event(id, 'TradeResult', 'PAPER_EXECUTION', { ...trace, mode: 'paper', intentId: 'intent', side: 'BUY', quantity, entryPrice: 2, exitPrice: null, realizedPnl: 0, fees: 0, slippageBps: 0, state: 'OPEN' }, 'COMPLETED');

test('runtime risk veto cannot be bypassed by an otherwise valid execution intent', t => {
  const runtime = setup(t, false);
  assert.throws(() => runtime.publish(intent()), /RISK_VETO_OR_DECISION_MISMATCH/);
  assert.equal(runtime.get('intent'), null);
});
test('runtime intent cannot change approved sizing token strategy signal action or correlation', t => {
  const runtime = setup(t);
  for (const change of [e => e.payload.quantity = 11, e => e.payload.token = 'other', e => e.payload.strategyVersion = 'version-2', e => e.payload.action = 'SELL', e => e.correlationId = 'other']) {
    const e = intent(); change(e); assert.throws(() => runtime.publish(e), /MISMATCH/);
  }
  runtime.publish(intent()); assert.equal(runtime.get('intent').payload.quantity, 10);
});
test('runtime enforces cumulative fills and cannot relabel an intent into another trade', t => {
  const runtime = setup(t); runtime.publish(intent());
  runtime.publish(fill('fill-1', 6));
  assert.throws(() => runtime.publish(fill('fill-2', 5)), /TRADE_EXCEEDS_INTENT/);
  const wrongSide = fill('wrong-side', 1); wrongSide.payload.side = 'SELL';
  assert.throws(() => runtime.publish(wrongSide), /TRADE_TRACE_MISMATCH/);
  const wrongCorrelation = fill('wrong-correlation', 1); wrongCorrelation.correlationId = 'other';
  assert.throws(() => runtime.publish(wrongCorrelation), /TRADE_TRACE_MISMATCH/);
  runtime.publish(fill('fill-2', 4));
  assert.equal(runtime.publish(fill('fill-2', 4)).duplicate, true);
  assert.throws(() => runtime.publish(fill('fill-3', 1)), /TRADE_EXCEEDS_INTENT/);
});
test('runtime candidate and decision cannot borrow another token snapshot or signal', t => {
  const runtime = setup(t);
  runtime.publish(event('other-snapshot', 'MarketSnapshot', 'MARKET_DATA', { token: 'other', price: 3, liquidityUsd: 10000, volume24hUsd: 30000, observedAt: at }));
  const wrongCandidate = runtime.get('candidate'); wrongCandidate.id = 'bad-candidate'; wrongCandidate.payload.snapshotId = 'other-snapshot';
  assert.throws(() => runtime.publish(wrongCandidate), /CANDIDATE_TOKEN_MISMATCH/);
  const wrongSignal = runtime.get('signal'); wrongSignal.id = 'bad-signal'; wrongSignal.payload.snapshotId = 'other-snapshot';
  assert.throws(() => runtime.publish(wrongSignal), /CANDIDATE_SNAPSHOT_MISMATCH/);
});
