'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { projectPortfolio } = require('../core/performance/project.cjs');
const { createTradeStore } = require('../core/trades/store.cjs');
const { createRuntime } = require('../runtime/events/bus.cjs');
const at = '2026-09-24T10:00:00.000Z', now = () => new Date(at);
function envelope(id, type, producer, payload, options = {}) {
  return { id, type, timestamp: at, producer, source: 'accounting-contract-case', evidence: ['source-1'], status: type === 'TradeResult' ? 'COMPLETED' : 'OBSERVED', correlationId: 'decision-1', network: 'SOLANA', epoch: 1, confidence: 0.9, evidence_quality: 0.9, missing_evidence: [], uncertainty: 0.1, payload, ...options };
}
function mark(id, price, options = {}) { return envelope(id, 'MarketSnapshot', 'MARKET_DATA', { token: 'token', price, liquidityUsd: 10000, volume24hUsd: 20000, observedAt: at }, options); }
function fill(id, side, quantity, price, fees = 0, options = {}) {
  return envelope(id, 'TradeResult', 'PAPER_EXECUTION', { mode: 'paper', intentId: 'intent-' + id, token: 'token', candidateId: 'candidate-1', snapshotId: 'snapshot-1', signalIds: ['signal-1'], strategyVersion: 'strategy-v1', decisionId: 'decision-1', riskDecisionId: 'risk-1', side, quantity, entryPrice: side === 'BUY' ? price : 999, exitPrice: side === 'BUY' ? null : price, realizedPnl: side === 'BUY' ? 0 : 987654, fees, slippageBps: 0, state: side === 'BUY' ? 'OPEN' : 'CLOSED' }, options);
}
const project = (events, options = {}) => projectPortfolio(events, { capitalUsd: 1000, now, ...options });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('capital adjustments replay between fills without changing PnL or breaking historical buys', () => {
  const events = [mark('m1', 10), fill('b1', 'BUY', 150, 10), mark('m2', 12), fill('s1', 'SELL', 150, 12)];
  const capitalAdjustments = [{ type: 'deposit', amountUsd: 500, eventCount: 1 }, { type: 'withdraw', amountUsd: 1700, eventCount: 4 }];
  const result = project(events, { capitalAdjustments });
  assert.equal(result.performance.paperCapitalUsd, 100);
  assert.equal(result.performance.cash, 100); assert.equal(result.performance.equity, 100);
  assert.equal(result.performance.realizedPnl, 300); assert.equal(result.performance.maxDrawdown, 0);
  assert.equal(result.trades[0].quantity, 150); assert.equal(result.positions.length, 0);
  const beforeSale = project(events.slice(0, 3), { capitalAdjustments });
  assert.equal(beforeSale.performance.paperCapitalUsd, 1500);
  assert.equal(beforeSale.performance.cash, 0); assert.equal(beforeSale.performance.equity, 1800);
});

test('trade-store sizing uses deposits without retroactively funding an earlier decision', async t => {
  const runtime = createRuntime({ now }); t.after(() => runtime.close());
  const capitalLedger = require('../runtime/capital-ledger.cjs').createCapitalLedger(null, now);
  const store = createTradeStore({ runtime, capitalUsd: 100, now, capitalLedger });
  runtime.publish(mark('before', 10));
  capitalLedger.adjust({ type: 'deposit', amountUsd: 50, network: 'SOLANA', eventCount: 1, currentCapitalUsd: 100 });
  assert.equal(store.snapshot().performance.equity, 150);
  assert.equal(store.snapshot({ throughId: 'before' }).performance.equity, 100);
  runtime.publish(mark('after', 10));
  assert.equal(store.snapshot({ throughId: 'after' }).performance.equity, 150);
});
test('portfolio computes fee-inclusive weighted basis and partial realized results independently of claimed PnL', () => {
  const events = [mark('m1', 10), fill('b1', 'BUY', 10, 10, 2), mark('m2', 20), fill('b2', 'BUY', 10, 20, 2), mark('m3', 30), fill('s1', 'REDUCE', 5, 30, 1)];
  const result = project(events), p = result.performance;
  near(p.cash, 845); near(p.capitalUsed, 228); near(p.realizedPnl, 73); near(p.unrealizedPnl, 222); near(p.equity, 1295);
  assert.equal(p.totalFills, 3); assert.equal(p.closedPositions, 0); assert.equal(p.winRate, null);
  assert.equal(result.positions[0].quantity, 15); near(result.positions[0].averageCost, 15.2);
  near(result.trades[2].realizedPnl, 73); assert.equal(result.trades[2].intentId, 'intent-s1'); assert.equal(result.trades[2].strategyVersion, 'strategy-v1');
  near(result.trades[2].allocatedCostBasis, 76); near(result.trades[2].realizedReturn, 73 / 76);
  assert.equal(result.trades[2].state, 'CLOSED'); assert.equal(result.trades[2].positionState, 'OPEN');
  assert.equal(result.trades[0].cycleId, result.trades[2].cycleId);
});
test('portfolio counts closed position cycles and starts a new win-rate cycle after reopening', () => {
  const events = [mark('m1', 10), fill('b1', 'BUY', 10, 10, 2), mark('m2', 20), fill('b2', 'BUY', 10, 20, 2), mark('m3', 30), fill('s1', 'REDUCE', 5, 30, 1), mark('m4', 10), fill('s2', 'SELL', 15, 10, 1)];
  const first = project(events);
  near(first.performance.realizedPnl, -6); near(first.performance.cash, 994); assert.equal(first.performance.closedPositions, 1); assert.equal(first.performance.wins, 0); assert.equal(first.positions.length, 0);
  // Before the first sell fee, the mark is 20 units * $30 + $696 cash = $1296.
  near(first.performance.maxDrawdown, (1296 - 994) / 1296);
  events.push(fill('b3', 'BUY', 2, 10), mark('m5', 20), fill('s3', 'SELL', 2, 20));
  const second = project(events); near(second.performance.realizedPnl, 14); near(second.performance.equity, 1014);
  assert.equal(second.performance.closedPositions, 2); assert.equal(second.performance.wins, 1); assert.equal(second.performance.winRate, 0.5);
  assert.ok(second.trades.every(t => t.positionState === 'CLOSED'));
  assert.equal(second.trades[0].state, 'OPEN');
  assert.notEqual(second.trades[0].cycleId, second.trades.at(-1).cycleId);
  assert.equal(second.trades[0].realizedReturn, null);
});
test('portfolio isolates token identity by network and retains old network positions through epoch switches', () => {
  const events = [mark('sol', 10), fill('sol-buy', 'BUY', 1, 10), mark('bsc', 20, { network: 'BSC', epoch: 2 }), fill('bsc-buy', 'BUY', 1, 20, 0, { network: 'BSC', epoch: 2 }), mark('sol-new-epoch', 30, { epoch: 3 })];
  const result = project(events, { activeNetwork: 'BSC' });
  assert.equal(result.positions.length, 2); assert.equal(result.activeNetwork, 'BSC'); near(result.performance.cash, 970); near(result.performance.capitalUsed, 30); near(result.performance.equity, 1020);
  assert.equal(result.positions.find(p => p.network === 'SOLANA').markSnapshotId, 'sol-new-epoch');
});
test('portfolio missing stale unreliable or pre-fill quotes remain unknown rather than zero', () => {
  const buy = fill('buy', 'BUY', 1, 10);
  for (const events of [[buy], [mark('stale', 10, { payload: { ...mark('x', 10).payload, observedAt: '2026-09-24T09:59:00.000Z' } }), buy], [mark('weak', 10, { missing_evidence: ['Provider unverified.'] }), buy]]) {
    const result = project(events); assert.equal(result.performance.unrealizedPnl, null); assert.equal(result.performance.equity, null); assert.equal(result.performance.maxDrawdown, null); near(result.performance.cash, 990); near(result.performance.capitalUsed, 10);
  }
  const staleNow = project([mark('m', 10), buy], { now: () => new Date('2026-09-24T10:01:00.001Z') });
  assert.equal(staleNow.performance.equity, null);
  const boundary = project([mark('m', 10), buy], { now: () => new Date('2026-09-24T10:01:00.000Z') });
  near(boundary.performance.equity, 1000);
});
test('portfolio delayed older quote cannot replace latest network-qualified mark', () => {
  const events = [mark('fresh', 20), fill('buy', 'BUY', 1, 10), mark('old', 1, { payload: { ...mark('x', 1).payload, observedAt: '2026-09-24T09:59:59.000Z' } })];
  assert.equal(project(events).positions[0].markSnapshotId, 'fresh'); near(project(events).performance.equity, 1010);
});
test('portfolio rejects oversells duplicate events incompatible fill identity and unavailable cash', () => {
  assert.throws(() => project([fill('sell', 'SELL', 1, 10)]), /INVALID_PORTFOLIO_OVERSELL/);
  assert.throws(() => project([fill('buy', 'BUY', 1, 10), fill('sell', 'SELL', 2, 20)]), /INVALID_PORTFOLIO_OVERSELL/);
  const buy = fill('buy', 'BUY', 1, 10); assert.throws(() => project([buy, buy]), /INVALID_PORTFOLIO_EVENT_IDENTITY/);
  const other = fill('other', 'BUY', 1, 10, 0, { network: 'BSC' }); other.payload.intentId = buy.payload.intentId;
  assert.throws(() => project([buy, other]), /INVALID_PORTFOLIO_INTENT_IDENTITY/);
  assert.throws(() => project([fill('expensive', 'BUY', 101, 10)]), /INVALID_PORTFOLIO_INSUFFICIENT_CASH/);
});
test('portfolio outputs do not mutate source events and include all trace identifiers', () => {
  const events = [mark('m', 10), fill('buy', 'BUY', 1, 10)], original = structuredClone(events), output = project(events);
  output.trades[0].signalIds.push('forged'); output.positions[0].quantity = 123;
  assert.deepEqual(events, original); assert.equal(project(events).positions[0].quantity, 1);
  for (const field of ['id', 'intentId', 'decisionId', 'riskDecisionId', 'candidateId', 'snapshotId', 'strategyVersion', 'network', 'epoch']) assert.ok(Object.hasOwn(output.trades[0], field));
});
test('trade store reads actual runtime state and does not fabricate fills or metrics', async t => {
  const runtime = createRuntime({ now }); t.after(() => runtime.close());
  const store = createTradeStore({ runtime, capitalUsd: 1000, now });
  runtime.publish(mark('m', 10)); await runtime.flush();
  const result = store.snapshot(); assert.equal(result.trades.length, 0); assert.equal(result.positions.length, 0); assert.equal(result.performance.winRate, null); assert.equal(result.performance.equity, 1000);
  runtime.selectNetwork('BSC'); assert.equal(store.snapshot().activeNetwork, 'BSC');
});
