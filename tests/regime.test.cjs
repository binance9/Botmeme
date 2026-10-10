'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createRuntime } = require('../runtime/events/bus.cjs');
const { classify, createRegimeEngine } = require('../core/market-data/regime.cjs');
const at = '2026-09-24T10:00:00.000Z', now = () => new Date('2026-09-24T10:00:10.000Z');
function market(i, price = 100 + i * 2) { const timestamp = new Date(Date.parse(at) + i * 1000).toISOString(); return { id: 'market/' + i, type: 'MarketSnapshot', timestamp, producer: 'MARKET_DATA', source: 'regime-contract-case', evidence: ['observation/' + i], status: 'OBSERVED', correlationId: 'scan', network: 'SOLANA', epoch: 1, confidence: .9, evidence_quality: .9, uncertainty: .1, missing_evidence: [], payload: { token: 'token', price, liquidityUsd: 10000, volume24hUsd: 20000, observedAt: timestamp } }; }
test('regime insufficient samples and adverse evidence remain unknown', () => {
  assert.equal(classify([]).regime, 'UNKNOWN'); assert.equal(classify([market(0)]).regime, 'UNKNOWN');
  const samples = Array.from({ length: 5 }, (_, i) => market(i)); assert.equal(classify(samples).regime, 'TRENDING');
  samples[2].missing_evidence = ['Provider gap']; assert.equal(classify(samples).regime, 'UNKNOWN');
});
test('regime high uncertainty cannot be relabeled as confident market evidence', () => {
  const samples = Array.from({ length: 5 }, (_, i) => ({ ...market(i), uncertainty: 1 }));
  assert.equal(classify(samples).regime, 'UNKNOWN');
});
test('regime engine uses chronological prefix and automatically follows the current network', async t => {
  const runtime = createRuntime({ now }), engine = createRegimeEngine({ runtime, now }); engine.start();
  t.after(async () => { engine.stop(); await runtime.close(); });
  for (let i = 0; i < 5; i++) runtime.publish(market(i)); await runtime.flush();
  const results = runtime.snapshot().events.filter(e => e.type === 'MarketRegimeState');
  assert.equal(results.length, 5); assert.equal(results[0].payload.regime, 'UNKNOWN'); assert.equal(results[4].payload.regime, 'TRENDING');
  assert.deepEqual(results[0].payload.snapshotIds, ['market/0']);
  runtime.selectNetwork('BSC'); const bsc = market(6); bsc.network = 'BSC'; bsc.epoch = 2; runtime.publish(bsc); await runtime.flush();
  assert.equal(runtime.snapshot().events.filter(e => e.type === 'MarketRegimeState').at(-1).payload.regime, 'UNKNOWN');
  assert.deepEqual(runtime.snapshot().deliveryErrors, []);
});
test('regime stop prevents queued work and restart resumes unacknowledged inputs', async t => {
  const runtime = createRuntime({ now }), engine = createRegimeEngine({ runtime, now });
  t.after(async () => { engine.stop(); await runtime.close(); });
  engine.start(); runtime.publish(market(0)); engine.stop(); await runtime.flush();
  assert.equal(runtime.snapshot().events.filter(e => e.type === 'MarketRegimeState').length, 0);
  engine.start(); await runtime.flush(); assert.equal(runtime.snapshot().events.filter(e => e.type === 'MarketRegimeState').length, 1);
});
test('regime stale observations produce unknown with attributable source evidence', async t => {
  const runtime = createRuntime({ now: () => new Date('2026-09-24T11:00:00.000Z') });
  const engine = createRegimeEngine({ runtime, now: () => new Date('2026-09-24T11:00:00.000Z') });
  t.after(async () => { engine.stop(); await runtime.close(); }); engine.start(); runtime.publish(market(0)); await runtime.flush();
  const result = runtime.snapshot().events.find(e => e.type === 'MarketRegimeState');
  assert.equal(result.payload.regime, 'UNKNOWN'); assert.equal(result.confidence, 0); assert.equal(result.uncertainty, 1); assert.ok(result.missing_evidence.length);
});
test('regime historical horizon admits real spaced samples without weakening current freshness', async t => {
  let clock = new Date('2026-09-24T10:03:10.000Z'); const localNow = () => clock;
  const runtime = createRuntime({ now: localNow }), engine = createRegimeEngine({ runtime, now: localNow, policy: { historyWindowMs: 1800000 } });
  t.after(async () => { engine.stop(); await runtime.close(); }); engine.start();
  for (let i = 0; i < 5; i++) { const event = market(i, 100 + i * 2); const time = new Date(Date.parse(at) + i * 45000).toISOString(); event.timestamp = time; event.payload.observedAt = time; runtime.publish(event); }
  await runtime.flush(); const result = runtime.snapshot().events.filter(e => e.type === 'MarketRegimeState').at(-1);
  assert.equal(result.payload.regime, 'TRENDING'); assert.equal(result.payload.snapshotIds.length, 5);
  clock = new Date('2026-09-24T10:06:00.000Z'); const stale = market(6, 112); stale.timestamp = '2026-09-24T10:03:45.000Z'; stale.payload.observedAt = stale.timestamp;
  runtime.publish(stale); await runtime.flush(); const rejected = runtime.snapshot().events.filter(e => e.type === 'MarketRegimeState').at(-1);
  assert.equal(rejected.payload.regime, 'UNKNOWN'); assert.match(rejected.payload.reason, /stale/);
});
test('regime honors custom history window and rejects malformed policy without mutating supplied configuration', async t => {
  const localNow = () => new Date('2026-09-24T10:03:10.000Z'), runtime = createRuntime({ now: localNow });
  const policy = { historyWindowMs: 60000 }, engine = createRegimeEngine({ runtime, now: localNow, policy }); policy.historyWindowMs = 1800000;
  t.after(async () => { engine.stop(); await runtime.close(); }); engine.start();
  for (let i = 0; i < 5; i++) { const event = market(i, 100 + i * 2); event.timestamp = new Date(Date.parse(at) + i * 45000).toISOString(); event.payload.observedAt = event.timestamp; runtime.publish(event); }
  await runtime.flush(); const result = runtime.snapshot().events.filter(e => e.type === 'MarketRegimeState').at(-1); assert.equal(result.payload.regime, 'UNKNOWN'); assert.equal(result.payload.snapshotIds.length, 2);
  for (const invalid of [null, [], { historyWindowMs: Infinity }, { historyWindowMs: 0 }, { historyWindowMs: 1.5 }, { maxAgeMs: NaN }, { unexpected: 1 }, { minSamples: 21, window: 20 }]) assert.throws(() => createRegimeEngine({ runtime, policy: invalid }), /INVALID_REGIME_POLICY/);
});
test('regime invalid clock fails closed and retains unacknowledged input for recovery', async t => {
  let clock = new Date(NaN); const runtime = createRuntime({ now }), engine = createRegimeEngine({ runtime, now: () => clock });
  t.after(async () => { engine.stop(); await runtime.close(); }); engine.start(); runtime.publish(market(0)); await runtime.flush();
  assert.equal(runtime.snapshot().events.filter(e => e.type === 'MarketRegimeState').length, 0); assert.equal(runtime.snapshot().deliveryErrors.length, 1);
  clock = now(); engine.stop(); engine.start(); await runtime.flush(); assert.equal(runtime.snapshot().events.filter(e => e.type === 'MarketRegimeState').length, 1);
});
