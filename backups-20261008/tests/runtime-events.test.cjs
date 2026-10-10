'use strict';
// Deterministic contract/integration tests, never a simulated market feed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRuntime } = require('../runtime/events/bus.cjs');
const at = '2026-09-24T09:00:00.000Z', now = () => new Date(at);
function market(id = 'snapshot-1', network = 'SOLANA', epoch = 1) {
  return { id, type: 'MarketSnapshot', timestamp: at, producer: 'MARKET_DATA', source: 'contract-test', evidence: ['source-record-1'], status: 'OBSERVED', correlationId: 'research-1', network, epoch, confidence: 0.8, evidence_quality: 0.8, missing_evidence: [], uncertainty: 0.2, payload: { token: 'token-1', price: 2, liquidityUsd: 10000, volume24hUsd: 20000, observedAt: at } };
}
function candidate(snapshotId = 'snapshot-1') {
  return { ...market('candidate-1'), type: 'TokenCandidate', producer: 'JEV', payload: { token: 'token-1', symbol: 'TKN', snapshotId, liquidityUsd: 10000, volume24hUsd: 20000, rank: 1, anomalies: ['volume'] } };
}
test('runtime persists exact events and restores network epoch without inventing market data', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'botmeme-runtime-'));
  const journalPath = path.join(directory, 'events.jsonl');
  let runtime = createRuntime({ journalPath, now });
  t.after(async () => { await runtime.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  assert.equal(runtime.snapshot().events.length, 0);
  runtime.publish(market()); runtime.publish(candidate()); await runtime.flush();
  runtime.selectNetwork('BSC'); runtime.publish(market('bsc-1', 'BSC', 2));
  await runtime.close();
  runtime = createRuntime({ journalPath, now });
  assert.equal(runtime.snapshot().network, 'BSC'); assert.equal(runtime.snapshot().epoch, 2);
  assert.equal(runtime.snapshot().events.length, 3); assert.deepEqual(runtime.get('snapshot-1'), market());
  assert.equal(runtime.publish(market()).duplicate, true);
  assert.throws(() => runtime.publish(market('late-sol')), /STALE_NETWORK_EVENT/);
});
test('runtime rejects trace gaps cross-network references and payload identity collisions atomically', async t => {
  const runtime = createRuntime({ now }); t.after(() => runtime.close());
  assert.throws(() => runtime.publish(candidate()), /MISSING_OR_INVALID_TRACE/);
  assert.equal(runtime.snapshot().events.length, 0);
  runtime.publish(market());
  const collision = market(); collision.payload.price = 3;
  assert.throws(() => runtime.publish(collision), /EVENT_ID_COLLISION/);
  runtime.selectNetwork('ETHEREUM');
  const cross = candidate(); cross.network = 'ETHEREUM'; cross.epoch = 2;
  assert.throws(() => runtime.publish(cross), /CROSS_NETWORK_TRACE/);
  assert.equal(runtime.snapshot().events.length, 1);
});
test('runtime event consumers can emit causally linked work without recursive dispatch or mutable shared state', async t => {
  const runtime = createRuntime({ now }); t.after(() => runtime.close());
  const delivered = [];
  runtime.subscribe('MarketSnapshot', event => { event.payload.price = 999; runtime.publish(candidate()); });
  runtime.subscribe('*', event => delivered.push([event.id, event.payload.price]));
  runtime.publish(market()); await runtime.flush();
  assert.deepEqual(delivered, [['snapshot-1', 2], ['candidate-1', undefined]]);
  assert.equal(runtime.get('snapshot-1').payload.price, 2);
  const view = runtime.snapshot();
  assert.throws(() => { view.events[0].payload.price = 100; }, TypeError, 'published events are frozen: mutation is impossible, not just invisible');
  assert.equal(runtime.get('snapshot-1').payload.price, 2);
});
test('runtime consumer failure and timeout do not kill other consumers or leak raw errors', async t => {
  const runtime = createRuntime({ now, handlerTimeoutMs: 15 }); t.after(() => runtime.close());
  let count = 0;
  runtime.subscribe('MarketSnapshot', () => { throw Error('private diagnostic never persisted'); });
  runtime.subscribe('MarketSnapshot', () => new Promise(() => {}));
  runtime.subscribe('MarketSnapshot', () => count++);
  runtime.publish(market()); await runtime.flush();
  assert.equal(count, 1); assert.equal(runtime.snapshot().deliveryErrors.length, 2);
  assert.ok(runtime.snapshot().deliveryErrors.every(e => e.code === 'CONSUMER_FAILED'));
  assert.ok(!JSON.stringify(runtime.snapshot()).includes('private diagnostic'));
});
test('runtime network switch quarantines queued work and aborts active consumers', async t => {
  const runtime = createRuntime({ now }); t.after(() => runtime.close());
  let called = 0, activeSignal;
  runtime.subscribe('MarketSnapshot', async (_event, { signal }) => { called++; activeSignal = signal; runtime.selectNetwork('BSC'); });
  runtime.publish(market()); runtime.publish(market('queued'));
  await runtime.flush();
  assert.equal(called, 1); assert.equal(activeSignal.aborted, true);
  assert.equal(runtime.snapshot().events.length, 2);
  assert.throws(() => runtime.publish(market('late')), /STALE_NETWORK_EVENT/);
  runtime.publish(market('new-network', 'BSC', 2)); await runtime.flush(); assert.equal(called, 2);
});
test('runtime bounds queued work before persistence and admits it once consumers drain', async t => {
  const runtime = createRuntime({ now, maxPending: 1 }); t.after(() => runtime.close());
  runtime.publish(market());
  assert.throws(() => runtime.publish(market('second')), /RUNTIME_BACKPRESSURE/);
  assert.equal(runtime.snapshot().events.length, 1);
  await runtime.flush(); runtime.publish(market('second')); await runtime.flush();
  assert.equal(runtime.snapshot().events.length, 2);
});
test('runtime refuses concurrent writers and damaged journals without modifying original data', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'botmeme-runtime-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journalPath = path.join(directory, 'events.jsonl');
  const runtime = createRuntime({ journalPath, now }); runtime.publish(market());
  assert.throws(() => createRuntime({ journalPath, now }), /EEXIST/);
  await runtime.close();
  const original = fs.readFileSync(journalPath, 'utf8');
  const damaged = original.replace('"price":2', '"price":3');
  fs.writeFileSync(journalPath, damaged);
  assert.throws(() => createRuntime({ journalPath, now }), /INVALID_RUNTIME_JOURNAL/);
  assert.equal(fs.readFileSync(journalPath, 'utf8'), damaged);
  fs.writeFileSync(journalPath, original.slice(0, -1));
  assert.throws(() => createRuntime({ journalPath, now }), /INCOMPLETE_RUNTIME_JOURNAL/);
});
