'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createRuntime } = require('../runtime/events/bus.cjs');
const { createStrategyEngine } = require('../core/strategy/engine.cjs');
const at = '2026-09-24T10:00:00.000Z';
function setup(t) {
  let clock = Date.parse(at); const now = () => new Date(clock), runtime = createRuntime({ now }), engine = createStrategyEngine({ runtime, now });
  t.after(async () => { engine.stop(); await runtime.close(); });
  const event = (id, type, producer, payload, extra = {}) => ({ id, type, producer, payload, timestamp: now().toISOString(), network: runtime.snapshot().network, epoch: runtime.snapshot().epoch, source: 'strategy-contract-fixture', evidence: ['input/' + id], status: 'OBSERVED', correlationId: 'case', confidence: .9, evidence_quality: .9, uncertainty: .1, missing_evidence: [], ...extra });
  const put = (...args) => { const e = event(...args); runtime.publish(e); return e; };
  const market = (id, price = 10) => put(id, 'MarketSnapshot', 'MARKET_DATA', { token: 'token', price, liquidityUsd: 100000, volume24hUsd: 200000, observedAt: now().toISOString() });
  function seed() {
    market('snapshot'); put('candidate', 'TokenCandidate', 'JEV', { token: 'token', symbol: 'TEST', snapshotId: 'snapshot', liquidityUsd: 100000, volume24hUsd: 200000, rank: 1, anomalies: [] });
    put('signal', 'SignalObservation', 'JEV', { candidateId: 'candidate', snapshotId: 'snapshot', signals: [{ name: 'momentum', value: .1 }] });
    put('regime', 'MarketRegimeState', 'MARKET_DATA', { regime: 'TRENDING', snapshotIds: ['snapshot'], reason: 'Fixture regime' });
    const proposal = { strategyVersion: 'v1', parentVersion: null, regimes: ['TRENDING'], parameters: [], backtestId: null, walkForwardId: null, lifecycle: 'IDEA' };
    put('idea', 'StrategyProposal', 'CODEX_2', proposal, { status: 'PROPOSED' });
    put('backtest', 'BacktestResult', 'CODEX_2', { proposalId: 'idea', strategyVersion: 'v1', trades: 10, netPnl: 20, maxDrawdown: .01, expectancy: 2, sharpe: 1, sampleStart: '2026-09-24T09:00:00.000Z', sampleEnd: at }, { status: 'COMPLETED' });
    put('walkforward', 'WalkForwardResult', 'CODEX_2', { proposalId: 'idea', strategyVersion: 'v1', backtestId: 'backtest', folds: 1, outOfSamplePnl: 5, maxDrawdown: .01 }, { status: 'COMPLETED' });
    put('challenger', 'StrategyProposal', 'CODEX_2', { ...proposal, backtestId: 'backtest', walkForwardId: 'walkforward', lifecycle: 'CHALLENGER' }, { status: 'PROPOSED' });
    put('eligible', 'StrategyLifecycleDecision', 'CODEX_1', { strategyVersion: 'v1', proposalId: 'challenger', stage: 'PAPER_EVALUATION', previousId: null, critiqueId: null, reason: 'Fixture lifecycle' }, { status: 'APPROVED' });
  }
  function risk(id, action = 'BUY', quantity = 2.5, approved = true) {
    put('decision/' + id, 'StrategyDecision', 'CODEX_1', { candidateId: 'candidate', snapshotId: 'snapshot', signalIds: ['signal'], strategyVersion: 'v1', quantEvidenceIds: ['backtest', 'walkforward'], criticReportIds: [], regimeId: 'regime', action, disposition: action === 'BUY' ? 'TRADE' : 'EXIT', reason: 'Fixture decision' });
    return put(id, 'RiskDecision', 'RISK_ENGINE', { decisionId: 'decision/' + id, approved, quantity: approved ? quantity : 0, maxExposureUsd: 100, reason: 'Fixture risk approval' }, { status: approved ? 'APPROVED' : 'REJECTED' });
  }
  const disable = () => put('disabled', 'StrategyLifecycleDecision', 'CODEX_1', { strategyVersion: 'v1', proposalId: 'challenger', stage: 'DISABLED', previousId: 'eligible', critiqueId: null, reason: 'Fixture disable' }, { status: 'APPROVED' });
  return { runtime, engine, market, seed, risk, disable, advance: ms => { clock += ms; }, intents: () => runtime.snapshot().events.filter(e => e.type === 'ExecutionIntent'), failures: () => runtime.snapshot().events.filter(e => e.type === 'AIActivityEvent' && e.producer === 'STRATEGY_ENGINE') };
}
test('strategy approved eligible risk yields exactly bounded paper intent and survives reattachment', async t => {
  const x = setup(t); x.seed(); x.engine.start(); x.risk('approved'); await x.runtime.flush();
  const intent = x.intents()[0]; assert.equal(x.intents().length, 1); assert.equal(intent.payload.quantity, 2.5); assert.equal(intent.payload.mode, 'paper'); assert.equal(intent.payload.referencePrice, 10);
  assert.deepEqual(intent.evidence, ['approved', 'decision/approved', 'snapshot']); assert.equal(intent.payload.riskDecisionId, 'approved');
  x.engine.stop(); x.engine.start(); await x.runtime.flush(); assert.equal(x.intents().length, 1); assert.deepEqual(x.runtime.snapshot().deliveryErrors, []);
});
test('strategy veto emits no execution intent and cannot bypass zero approved quantity', async t => {
  const x = setup(t); x.seed(); x.engine.start(); x.risk('veto', 'BUY', 99, false); await x.runtime.flush(); assert.equal(x.intents().length, 0); assert.deepEqual(x.runtime.snapshot().deliveryErrors, []);
});
test('strategy stale approval fails with risk task reference', async t => {
  const x = setup(t); x.seed(); x.risk('stale'); x.advance(900001); x.engine.start(); await x.runtime.flush();
  assert.equal(x.intents().length, 0); assert.equal(x.failures().length, 1); assert.equal(x.failures()[0].payload.task, 'stale'); assert.equal(x.failures()[0].status, 'FAILED');
});
test('strategy disabled version cannot open but can exit old positions', async t => {
  const x = setup(t); x.seed(); x.disable(); x.engine.start(); x.risk('buy'); x.risk('sell', 'SELL', 1); await x.runtime.flush();
  assert.deepEqual(x.intents().map(e => [e.payload.action, e.payload.quantity]), [['SELL', 1]]); assert.equal(x.failures()[0].payload.task, 'buy'); assert.deepEqual(x.runtime.snapshot().deliveryErrors, []);
});
test('strategy derives next observation features only for an existing same-network candidate', async t => {
  const x = setup(t); x.seed(); x.engine.start(); x.advance(1000); x.market('next', 12); await x.runtime.flush();
  const rows = x.runtime.snapshot().events.filter(e => e.type === 'SignalObservation' && e.producer === 'STRATEGY_ENGINE'); assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.candidateId, 'candidate'); assert.equal(rows[0].payload.snapshotId, 'next'); assert.ok(Math.abs(rows[0].payload.signals.find(s => s.name === 'price_change_fraction').value - .2) < 1e-12);
  x.runtime.selectNetwork('BSC'); x.market('bsc', 50); await x.runtime.flush(); assert.equal(x.runtime.snapshot().events.filter(e => e.type === 'SignalObservation' && e.producer === 'STRATEGY_ENGINE').length, 1);
});
test('strategy stop cancels queued handling and durable restart processes outstanding approval once', async t => {
  const x = setup(t); x.seed(); x.engine.start(); x.risk('queued'); x.engine.stop(); await x.runtime.flush(); assert.equal(x.intents().length, 0);
  x.engine.start(); await x.runtime.flush(); assert.equal(x.intents().length, 1);
});
test('paper executor and quant service defaults agree on declared slippage and fee costs', () => {
  const execution = require('../core/execution/paper.cjs').DEFAULT_POLICY, quant = require('../services/quant/service.cjs').DEFAULT_POLICY;
  assert.equal(execution.feeBps, 10); assert.equal(execution.slippageBps, 10); assert.equal(quant.feeBps, execution.feeBps); assert.equal(quant.slippageBps, execution.slippageBps);
});
test('strategy invalid clock cannot authorize an intent', async t => {
  const x = setup(t); x.seed(); x.risk('clock-check');
  const engine = createStrategyEngine({ runtime: x.runtime, now: () => new Date(NaN) }); t.after(() => engine.stop()); engine.start(); await x.runtime.flush();
  assert.equal(x.intents().length, 0, 'Unknown current time must not authorize execution.');
});
