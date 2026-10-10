'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createRuntime } = require('../runtime/events/bus.cjs');
const { createTradeStore } = require('../core/trades/store.cjs');
const { createPaperExecution } = require('../core/execution/paper.cjs');
const base = Date.parse('2026-09-24T10:00:00.000Z');
function setup(t, options = {}) {
  let clock = base; const now = () => new Date(clock), runtime = createRuntime({ now }), tradeStore = createTradeStore({ runtime, now, capitalUsd: options.capitalUsd ?? 1000 });
  const engine = createPaperExecution({ runtime, tradeStore, now, policy: options.policy });
  t.after(async () => { engine.stop(); await runtime.close(); }); engine.start();
  function event(id, type, producer, payload, extra = {}) { const active = runtime.snapshot(); return { id, type, producer, payload, timestamp: now().toISOString(), source: 'paper-test-observation', evidence: ['source/' + id], status: 'OBSERVED', correlationId: 'case', network: active.network, epoch: active.epoch, confidence: .9, evidence_quality: .9, uncertainty: .1, missing_evidence: [], ...extra }; }
  function market(id, price, advance = 0, extra = {}) { clock += advance; const e = event(id, 'MarketSnapshot', 'MARKET_DATA', { token: 'token', price, liquidityUsd: 100000, volume24hUsd: 200000, observedAt: now().toISOString() }, extra); runtime.publish(e); return e; }
  function intent(id, snapshot, action = 'BUY', quantity = 1, maxExposureUsd = 1000, approved = true) {
    const token = snapshot.payload.token;
    runtime.publish(event('candidate/' + id, 'TokenCandidate', 'JEV', { token, symbol: 'TEST', snapshotId: snapshot.id, liquidityUsd: 100000, volume24hUsd: 200000, rank: 1, anomalies: [] }));
    runtime.publish(event('signal/' + id, 'SignalObservation', 'JEV', { candidateId: 'candidate/' + id, snapshotId: snapshot.id, signals: [{ name: 'momentum', value: .1 }] }));
    runtime.publish(event('regime/' + id, 'MarketRegimeState', 'MARKET_DATA', { regime: 'TRENDING', snapshotIds: [snapshot.id], reason: 'Test observation' }));
    const trace = { candidateId: 'candidate/' + id, snapshotId: snapshot.id, signalIds: ['signal/' + id], strategyVersion: 'v1', decisionId: 'decision/' + id, riskDecisionId: 'risk/' + id };
    runtime.publish(event(trace.decisionId, 'StrategyDecision', 'CODEX_1', { candidateId: trace.candidateId, snapshotId: trace.snapshotId, signalIds: trace.signalIds, strategyVersion: 'v1', quantEvidenceIds: [], criticReportIds: [], regimeId: 'regime/' + id, action, disposition: action === 'BUY' ? 'TRADE' : 'EXIT', reason: 'Test decision' }));
    runtime.publish(event(trace.riskDecisionId, 'RiskDecision', 'RISK_ENGINE', { decisionId: trace.decisionId, approved, quantity: approved ? quantity : 0, maxExposureUsd, reason: 'Risk test constraint' }, { status: approved ? 'APPROVED' : 'REJECTED' }));
    const result = event(id, 'ExecutionIntent', 'STRATEGY_ENGINE', { mode: 'paper', token, ...trace, action, quantity, referencePrice: snapshot.payload.price }, { status: 'APPROVED' }); runtime.publish(result); return result;
  }
  return { runtime, tradeStore, engine, event, market, intent, advance: ms => { clock += ms; }, fills: () => runtime.snapshot().events.filter(e => e.type === 'TradeResult'), failures: () => runtime.snapshot().events.filter(e => e.type === 'AIActivityEvent' && e.producer === 'PAPER_EXECUTION') };
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
test('paper executes next chronological observation with deterministic costs and exact trace, once', async t => {
  const x = setup(t), first = x.market('first', 10); x.intent('buy', first, 'BUY', 2);
  x.market('same-time', 500); await x.runtime.flush(); assert.equal(x.fills().length, 0);
  x.market('next', 20, 1000); await x.runtime.flush(); const fill = x.fills()[0];
  assert.equal(x.fills().length, 1); near(fill.payload.entryPrice, 20.02); near(fill.payload.fees, .04004); assert.equal(fill.payload.snapshotId, first.id); assert.ok(fill.evidence.includes('next')); assert.equal(fill.payload.realizedPnl, 0);
  x.engine.stop(); x.engine.start(); x.market('later', 30, 1000); await x.runtime.flush(); assert.equal(x.fills().length, 1); assert.deepEqual(x.runtime.snapshot().deliveryErrors, []);
});
test('paper exits use weighted authoritative basis, partial reduction and no oversell', async t => {
  const x = setup(t), first = x.market('first', 10); x.intent('buy', first, 'BUY', 2); const buyQuote = x.market('buy-quote', 20, 1000); await x.runtime.flush();
  x.intent('reduce', buyQuote, 'REDUCE', 1); const exitQuote = x.market('exit-quote', 30, 1000); await x.runtime.flush();
  const exit = x.fills()[1]; near(exit.payload.exitPrice, 29.97); near(exit.payload.realizedPnl, 29.97 - .02997 - 20.04002); assert.equal(exit.payload.state, 'CLOSED'); assert.equal(x.tradeStore.snapshot().positions[0].quantity, 1);
  x.intent('oversell', exitQuote, 'SELL', 2); x.market('oversell-quote', 30, 1000); await x.runtime.flush(); assert.equal(x.fills().length, 2); assert.match(x.failures()[0].payload.message, /exceeds/); assert.deepEqual(x.runtime.snapshot().deliveryErrors, []);
});
test('paper caps quantity by cash and exposure including fees across queued intents', async t => {
  const x = setup(t, { capitalUsd: 100 }), first = x.market('first', 10); x.intent('one', first, 'BUY', 20, 50); x.intent('two', first, 'BUY', 20, 50);
  x.market('next', 20, 1000); x.market('next-queued', 30, 1000); await x.runtime.flush();
  assert.equal(x.fills().length, 2); near(x.fills()[0].payload.quantity, 50 / (20.02 * 1.001)); near(x.tradeStore.snapshot().performance.capitalUsed, 100); near(x.tradeStore.snapshot().performance.cash, 0); assert.deepEqual(x.runtime.snapshot().deliveryErrors, []);
});
test('paper never fills vetoed, expired, stale, unreliable, or different network intents', async t => {
  const x = setup(t), first = x.market('first', 10); assert.throws(() => x.intent('vetoed', first, 'BUY', 1, 1000, false), /RISK_VETO/);
  x.intent('expired', first); x.market('expired-quote', 10, 60001); await x.runtime.flush(); assert.equal(x.fills().length, 0); assert.equal(x.failures().length, 1);
  const fresh = x.market('fresh', 10); x.intent('unreliable', fresh); x.market('unreliable-quote', 10, 1000, { missing_evidence: ['Provider unavailable.'] }); await x.runtime.flush(); assert.equal(x.fills().length, 0);
  const active = x.market('active', 10); x.intent('old-network', active); x.runtime.selectNetwork('BSC'); x.market('bsc', 10, 1000); await x.runtime.flush(); assert.equal(x.fills().length, 0); assert.deepEqual(x.runtime.snapshot().deliveryErrors, []);
});
test('paper stop cancels queued delivery and restart rejects stale opportunities', async t => {
  const x = setup(t), first = x.market('first', 10); x.intent('buy', first); x.market('next', 10, 1000); x.engine.stop(); await x.runtime.flush(); assert.equal(x.fills().length, 0);
  x.advance(60001); x.engine.start(); await x.runtime.flush(); assert.equal(x.fills().length, 0); assert.equal(x.failures().length, 1);
  assert.throws(() => createPaperExecution({ runtime: x.runtime, tradeStore: x.tradeStore, policy: { slippageBps: -1 } }), /INVALID_PAPER_POLICY/);
});
test('paper does not retroactively fill an older quote after a later committed fill', async t => {
  const x = setup(t), first = x.market('first', 10), committed = x.intent('committed', first), ip = committed.payload;
  x.intent('retrospective', first);
  x.runtime.publish(x.event('existing-fill', 'TradeResult', 'PAPER_EXECUTION', { mode: 'paper', intentId: committed.id, token: ip.token, candidateId: ip.candidateId, snapshotId: ip.snapshotId, signalIds: ip.signalIds, strategyVersion: ip.strategyVersion, decisionId: ip.decisionId, riskDecisionId: ip.riskDecisionId, side: 'BUY', quantity: 1, entryPrice: 10, exitPrice: null, realizedPnl: 0, fees: 0, slippageBps: 0, state: 'OPEN' }, { timestamp: new Date(base + 2000).toISOString(), status: 'COMPLETED' }));
  x.market('older-quote', 9, 1000); await x.runtime.flush();
  assert.equal(x.fills().length, 1); assert.match(x.failures()[0].payload.message, /retrospective/); assert.deepEqual(x.runtime.snapshot().deliveryErrors, []);
});
test('paper cash boundary caps actual fee-inclusive fill without overdraft', async t => {
  const x = setup(t, { capitalUsd: 10.1234567 }), first = x.market('first', 1); x.intent('cash-cap', first, 'BUY', 1000, 10000);
  x.market('cash-quote', 3.14159, 1000); await x.runtime.flush();
  assert.equal(x.fills().length, 1); const portfolio = x.tradeStore.snapshot(); assert.ok(portfolio.performance.cash >= 0); near(portfolio.performance.capitalUsed, 10.1234567); assert.deepEqual(x.runtime.snapshot().deliveryErrors, []);
});
test('paper per-intent exposure cap is not reduced twice by unrelated positions', async t => {
  const x = setup(t), first = x.market('first', 10); x.intent('first-buy', first, 'BUY', 5, 60);
  x.market('first-fill', 10, 1000); await x.runtime.flush();
  const payload = { token: 'other-token', price: 20, liquidityUsd: 100000, volume24hUsd: 200000, observedAt: new Date(base + 1000).toISOString() };
  const other = x.market('other', 20, 0, { payload }); x.intent('second-buy', other, 'BUY', 1, 30);
  x.market('other-fill', 20, 1000, { payload: { ...payload, observedAt: new Date(base + 2000).toISOString() } }); await x.runtime.flush();
  assert.equal(x.fills().length, 2); assert.equal(x.fills()[1].payload.quantity, 1); assert.equal(x.tradeStore.snapshot().positions.length, 2); assert.deepEqual(x.runtime.snapshot().deliveryErrors, []);
});
