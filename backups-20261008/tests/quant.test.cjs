'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { backtest, walkforward } = require('../core/strategy/replay.cjs');
const { createQuant } = require('../services/quant/service.cjs');
const { createRuntime } = require('../runtime/events/bus.cjs');
const { createTradeStore } = require('../core/trades/store.cjs');
const now = () => new Date('2026-09-24T20:00:00.000Z');
const params = { threshold: 0.01, horizon: 1, feeBps: 10, slippageBps: 10 };
function market(i, price = 100 * 1.02 ** i, network = 'SOLANA', epoch = 1) {
  const timestamp = new Date(Date.UTC(2026, 8, 24, 10, 0, i)).toISOString();
  return { id: 'snapshot/' + network + '/' + i, type: 'MarketSnapshot', timestamp, producer: 'MARKET_DATA', source: 'quant-test-observation', evidence: ['test-observation/' + i], status: 'OBSERVED', correlationId: 'series/' + i, network, epoch, confidence: 0.9, evidence_quality: 0.9, missing_evidence: [], uncertainty: 0.1, payload: { token: 'token-1', price, liquidityUsd: 100000, volume24hUsd: 50000, observedAt: timestamp } };
}
const history = n => Array.from({ length: n }, (_, i) => market(i));
const policy = { minSamples: 30, minTrain: 20, testSize: 10, minTrades: 2, every: 10, thresholds: [0.01], horizons: [1] };
test('replay enters next observation and includes both fill costs with no overlapping positions', () => {
  const rows = [100, 110, 200, 220, 230, 240, 250].map((price, i) => market(i, price));
  const result = backtest(rows, params);
  assert.equal(result.details[0].signalId, rows[1].id); assert.equal(result.details[0].entryId, rows[2].id); assert.equal(result.details[0].exitId, rows[3].id);
  assert.ok(Math.abs(result.details[0].return - (220 * .999 * .999 / (200 * 1.001 * 1.001) - 1)) < 1e-12);
  assert.equal(result.details[1].signalId, rows[4].id);
  const prefix = backtest(rows.slice(0, 4), params); assert.deepEqual(result.details[0], prefix.details[0]);
});
test('zero edge after costs loses money; drawdown and no trades are honest', () => {
  const result = backtest(Array.from({ length: 10 }, (_, i) => market(i, 100)), { ...params, threshold: 0 });
  assert.ok(result.netPnl < 0); assert.ok(result.maxDrawdown > 0); assert.equal(result.expectancy, result.details[0].return);
  const idle = backtest(history(10), { ...params, threshold: 1 }); assert.equal(idle.trades, 0); assert.equal(idle.sharpe, 0);
});
test('drawdown measures intra-position losses even when the position eventually wins', () => {
  const rows = [100, 110, 100, 40, 120].map((price, i) => market(i, price));
  const result = backtest(rows, { ...params, horizon: 2, feeBps: 0, slippageBps: 0 });
  assert.ok(Math.abs(result.netPnl - .2) < 1e-12); assert.equal(result.maxDrawdown, .6);
});
test('walkforward selects using training only and publishes final fixed-version OOS metrics', () => {
  const rows = history(40), options = { candidates: [params, { ...params, threshold: .015, horizon: 3 }], minTrain: 20, testSize: 10, minTrades: 1 };
  const before = walkforward(rows, options), changed = structuredClone(rows);
  for (let i = 30; i < 40; i++) changed[i].payload.price = 10 + 40 - i;
  const after = walkforward(changed, { ...options, candidates: [{ ...params, threshold: 0 }] });
  const fixed = walkforward(rows, { ...options, candidates: [{ ...params, threshold: 0 }] });
  assert.deepEqual(after.folds[0].parameters, fixed.folds[0].parameters);
  assert.deepEqual(after.folds[0].trainIds, fixed.folds[0].trainIds);
  assert.equal(before.netPnl, before.folds.at(-1).result.netPnl);
  for (const fold of before.folds) assert.ok(fold.trainIds.every(id => !fold.testIds.includes(id)));
  assert.equal(walkforward(rows.slice(0, 20), options).status, 'CHUA_XAC_MINH');
});
test('replay rejects unordered duplicate mixed-token/network and nonfinite samples', () => {
  for (const mutate of [r => r.reverse(), r => { r[1].id = r[0].id; }, r => { r[1].network = 'BSC'; }, r => { r[1].payload.token = 'other'; }, r => { r[1].payload.price = Infinity; }]) {
    const rows = history(4); mutate(rows); assert.throws(() => backtest(rows, params), /INVALID_REPLAY_HISTORY/);
  }
});
test('quant durable runtime generates attributed evidence lifecycle without orders or champion and survives restart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botmeme-quant-')), journalPath = path.join(dir, 'journal.jsonl');
  let runtime = createRuntime({ now, journalPath }), quant = createQuant({ runtime, now, policy });
  t.after(async () => { quant.stop(); await runtime.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  quant.start(); for (const row of history(40)) runtime.publish(row); await runtime.flush();
  const events = runtime.snapshot().events, proposals = events.filter(e => e.type === 'StrategyProposal');
  assert.equal(runtime.snapshot().deliveryErrors.length, 0);
  assert.deepEqual(proposals.slice(0, 4).map(e => e.payload.lifecycle), ['IDEA', 'BACKTEST', 'WALK_FORWARD', 'CHALLENGER']);
  assert.equal(proposals.filter(e => e.payload.lifecycle === 'CHALLENGER').length, 2);
  assert.ok(events.filter(e => e.producer === 'CODEX_2').every(e => e.evidence.every(id => runtime.get(id))));
  assert.ok(events.every(e => !['ExecutionIntent', 'TradeResult', 'StrategyDecision'].includes(e.type)));
  const first = proposals[0]; assert.ok(first.evidence.every(id => Number(id.split('/').at(-1)) < 30));
  const count = events.length; quant.stop(); await runtime.close();
  runtime = createRuntime({ now, journalPath }); quant = createQuant({ runtime, now, policy }); quant.start(); await runtime.flush();
  assert.equal(runtime.snapshot().events.length, count);
});
test('quant waits for reliable samples and never combines old-network history', async t => {
  const runtime = createRuntime({ now }), quant = createQuant({ runtime, now, policy }); t.after(async () => { quant.stop(); await runtime.close(); });
  quant.start(); for (const row of history(29)) runtime.publish(row); await runtime.flush();
  runtime.selectNetwork('BSC'); runtime.publish(market(40, 123, 'BSC', 2)); await runtime.flush();
  assert.equal(runtime.snapshot().events.filter(e => e.type === 'StrategyProposal').length, 0);
  assert.equal(runtime.snapshot().events.at(-1).status, 'CHUA_XAC_MINH');
});
function tradeChain(runtime, suffix, side, price, claimedPnl) {
  const snapshot = market(0), prefix = 'chain/' + suffix + '/', timestamp = market(50).timestamp;
  const event = (id, type, producer, payload, status = 'OBSERVED') => ({ ...snapshot, id: prefix + id, type, producer, payload, status, timestamp, correlationId: prefix + 'decision' });
  runtime.publish(event('candidate', 'TokenCandidate', 'JEV', { token: 'token-1', symbol: 'T', snapshotId: snapshot.id, liquidityUsd: 100000, volume24hUsd: 50000, rank: 1, anomalies: [] }));
  runtime.publish(event('signal', 'SignalObservation', 'JEV', { candidateId: prefix + 'candidate', snapshotId: snapshot.id, signals: [{ name: 'price', value: price }] }));
  runtime.publish(event('regime', 'MarketRegimeState', 'MARKET_DATA', { regime: 'TRENDING', snapshotIds: [snapshot.id], reason: 'Test chronological chain.' }));
  const trace = { candidateId: prefix + 'candidate', snapshotId: snapshot.id, signalIds: [prefix + 'signal'], strategyVersion: 'strategy-v1', decisionId: prefix + 'decision', riskDecisionId: prefix + 'risk' };
  runtime.publish(event('decision', 'StrategyDecision', 'CODEX_1', { candidateId: trace.candidateId, snapshotId: trace.snapshotId, signalIds: trace.signalIds, strategyVersion: trace.strategyVersion, quantEvidenceIds: [], criticReportIds: [], regimeId: prefix + 'regime', action: side, disposition: side === 'BUY' ? 'TRADE' : 'EXIT', reason: 'Accounting boundary test.' }));
  runtime.publish(event('risk', 'RiskDecision', 'RISK_ENGINE', { decisionId: trace.decisionId, approved: true, quantity: 1, maxExposureUsd: 1000, reason: 'Test.' }, 'APPROVED'));
  runtime.publish(event('intent', 'ExecutionIntent', 'STRATEGY_ENGINE', { mode: 'paper', token: 'token-1', ...trace, action: side, quantity: 1, referencePrice: price }, 'APPROVED'));
  runtime.publish(event('fill', 'TradeResult', 'PAPER_EXECUTION', { mode: 'paper', intentId: prefix + 'intent', token: 'token-1', ...trace, side, quantity: 1, entryPrice: 100, exitPrice: side === 'BUY' ? null : price, realizedPnl: side === 'BUY' ? 0 : claimedPnl, fees: 0, slippageBps: 0, state: side === 'BUY' ? 'OPEN' : 'CLOSED' }, 'COMPLETED'));
  return prefix + 'fill';
}
test('quant loss learning uses authoritative cost basis instead of forged claimed PnL', async t => {
  for (const [exitPrice, claimedPnl, expectedLoss] of [[80, 999999, true], [120, -999999, false]]) {
    const runtime = createRuntime({ now }), tradeStore = createTradeStore({ runtime, now });
    const quant = createQuant({ runtime, now, tradeStore, policy });
    t.after(async () => { quant.stop(); await runtime.close(); });
    quant.start(); for (const row of history(30)) runtime.publish(row); await runtime.flush();
    tradeChain(runtime, 'buy', 'BUY', 100, 0); const closeId = tradeChain(runtime, 'sell', 'SELL', exitPrice, claimedPnl); await runtime.flush();
    const triggered = runtime.snapshot().events.filter(e => e.type === 'StrategyProposal' && e.payload.lifecycle === 'IDEA' && e.evidence.includes(closeId));
    assert.equal(triggered.length, expectedLoss ? 1 : 0);
    assert.equal(tradeStore.snapshot({ throughId: closeId }).trades.find(row => row.id === closeId).realizedPnl, exitPrice - 100);
    assert.equal(runtime.snapshot().deliveryErrors.length, 0);
  }
});
test('quant trade feedback without authoritative projection stays unknown', async t => {
  const runtime = createRuntime({ now }), quant = createQuant({ runtime, now, policy });
  t.after(async () => { quant.stop(); await runtime.close(); }); quant.start(); runtime.publish(market(0));
  tradeChain(runtime, 'buy', 'BUY', 100, 0); const closeId = tradeChain(runtime, 'sell', 'SELL', 80, -20); await runtime.flush();
  const activity = runtime.snapshot().events.find(e => e.type === 'AIActivityEvent' && e.payload.task === closeId);
  assert.equal(activity.status, 'CHUA_XAC_MINH'); assert.match(activity.payload.message, /Authoritative/);
});
