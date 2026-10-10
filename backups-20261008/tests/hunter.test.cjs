'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRuntime } = require('../runtime/events/bus.cjs');
const { createHunter } = require('../services/jev/hunter.cjs');
const at = '2026-09-24T10:00:00.000Z', now = () => new Date(at);
const policy = { maxAgeMs: 60000, minLiquidityUsd: 10000, minQuality: 0.7, momentumThreshold: 0.05, volumeLiquidityThreshold: 3, minRealVolumeUsd: 500, minRecentTxs: 2 };
function market(id, changes = {}) {
  return { id, type: 'MarketSnapshot', timestamp: at, producer: 'MARKET_DATA', source: 'hunter-contract-check', evidence: ['provider-observation'], status: 'OBSERVED', correlationId: id, network: 'SOLANA', epoch: 1, confidence: 0.9, evidence_quality: 0.9, missing_evidence: [], uncertainty: 0.1, payload: { token: 'token-address-1', price: 100, liquidityUsd: 10000, volume24hUsd: 100, observedAt: at }, ...changes };
}
function setup(t, options = {}) {
  const runtime = createRuntime({ now, ...options }), hunter = createHunter({ runtime, now, policy });
  t.after(async () => { hunter.stop(); await runtime.close(); });
  hunter.start(); return { runtime, hunter };
}
const ofType = (runtime, type) => runtime.snapshot().events.filter(e => e.type === type);
test('real 24h turnover admits a candidate on the first snapshot', async t => {
  const { runtime } = setup(t);
  runtime.publish(market('real-vol', { payload: { ...market('x').payload, volume24hUsd: 800 } }));
  await runtime.flush();
  const candidate = ofType(runtime, 'TokenCandidate')[0];
  assert.ok(candidate, 'genuine $800/24h volume is an immediate candidate');
  assert.ok(candidate.payload.anomalies.includes('REAL_VOLUME'));
});
test('thin 24h turnover never becomes a REAL_VOLUME candidate', async t => {
  const { runtime } = setup(t);
  for (const [id, vol] of [['thin', 499], ['tiny', 300]]) {
    runtime.publish(market(id, { id: 'snap-' + id, payload: { ...market('x').payload, token: 'token-' + id, volume24hUsd: vol } }));
  }
  await runtime.flush();
  const cands = ofType(runtime, 'TokenCandidate');
  assert.ok(cands.every(c => !c.payload.anomalies.includes('REAL_VOLUME')), 'below $500 vol24h never flags REAL_VOLUME');
});
test('hunter keeps a watched meme at WATCHING until five liquid snapshots', async t => {  const { runtime } = setup(t);
  const payload = { ...market('x').payload, liquidityUsd: 12000, poolAgeMs: 120000, marketCapUsd: 40000, realVolumeUsd: 180 };
  for (let i = 0; i < 4; i += 1) runtime.publish(market('watch-' + i, { source: 'trade-sha256', payload: { ...payload, observedAt: new Date(Date.parse(at) - (4 - i) * 60000).toISOString() } }));
  await runtime.flush();
  assert.equal(ofType(runtime, 'TokenCandidate').length, 0);
  assert.match(ofType(runtime, 'AIActivityEvent').at(-1).payload.message, /WATCHING 4\/5/);
  runtime.publish(market('watch-4', { source: 'trade-sha256', payload }));
  await runtime.flush();
  assert.ok(ofType(runtime, 'TokenCandidate')[0].payload.anomalies.includes('TOKEN_DISCOVERY'));
  assert.match(ofType(runtime, 'AIActivityEvent').at(-1).payload.message, /^ELIGIBLE /);
});
test('hunter autonomously emits research candidate signals and real activity without orders or fabricated progress', async t => {
  const { runtime } = setup(t); runtime.publish(market('first')); await runtime.flush();
  const candidate = ofType(runtime, 'TokenCandidate')[0], signal = ofType(runtime, 'SignalObservation')[0], activity = ofType(runtime, 'AIActivityEvent')[0];
  assert.equal(candidate.payload.rank, 1); assert.deepEqual(candidate.payload.anomalies, ['TOKEN_DISCOVERY']);
  assert.equal(candidate.payload.symbol, candidate.payload.token.slice(0, 32));
  assert.equal(signal.payload.candidateId, candidate.id); assert.equal(signal.payload.snapshotId, 'first');
  assert.equal(activity.payload.progress, null); assert.match(activity.payload.message, /Ticker unavailable/);
  for (const event of [candidate, signal, activity]) { assert.deepEqual(event.evidence, ['first']); assert.equal(event.timestamp, at); assert.equal(event.correlationId, 'first'); assert.equal(event.producer, 'JEV'); }
  assert.equal(ofType(runtime, 'ExecutionIntent').length, 0); assert.equal(ofType(runtime, 'TradeResult').length, 0);
});
test('hunter rejects stale missing unreliable and illiquid input with waiting activity only', async t => {
  const { runtime } = setup(t);
  const cases = [
    { evidence: [] }, { missing_evidence: ['Unverified provider response.'] }, { evidence_quality: 0.69 }, { confidence: 0.69 }, { uncertainty: 0.31 }, { status: 'CHUA_XAC_MINH' },
    { payload: { ...market('x').payload, liquidityUsd: 9999 } },
    { payload: { ...market('x').payload, observedAt: '2026-09-24T09:58:59.999Z' } }
  ];
  cases.forEach((changes, i) => runtime.publish(market('bad-' + i, changes))); await runtime.flush();
  assert.equal(ofType(runtime, 'TokenCandidate').length, 0); assert.equal(ofType(runtime, 'SignalObservation').length, 0);
  assert.equal(ofType(runtime, 'AIActivityEvent').length, cases.length);
  assert.ok(ofType(runtime, 'AIActivityEvent').every(e => e.payload.state === 'WAITING' && e.payload.progress === null));
});
test('hunter uses only snapshots before current input even when later market observations are already persisted', async t => {
  const { runtime } = setup(t);
  runtime.publish(market('a'));
  runtime.publish(market('b', { payload: { ...market('x').payload, price: 105 } }));
  runtime.publish(market('c', { payload: { ...market('x').payload, price: 1000 } }));
  await runtime.flush();
  const signal = ofType(runtime, 'SignalObservation').find(e => e.payload.snapshotId === 'b');
  assert.equal(signal.payload.signals.find(s => s.name === 'price_change_fraction').value, 0.05);
  assert.equal(signal.payload.candidateId, ofType(runtime, 'TokenCandidate')[0].id);
  assert.equal(ofType(runtime, 'TokenCandidate').length, 1);
  assert.equal(ofType(runtime, 'SignalObservation').find(e => e.payload.snapshotId === 'a').payload.signals.some(s => s.name === 'price_change_fraction'), false);
});
test('hunter watches unchanged tokens and ranks discoveries against preceding reliable universe', async t => {
  const { runtime } = setup(t);
  runtime.publish(market('a', { payload: { ...market('x').payload, token: 'high-volume', volume24hUsd: 40000 } }));
  runtime.publish(market('b'));
  runtime.publish(market('same'));
  await runtime.flush();
  assert.equal(ofType(runtime, 'TokenCandidate').find(e => e.payload.snapshotId === 'b').payload.rank, 2);
  assert.equal(ofType(runtime, 'TokenCandidate').some(e => e.payload.snapshotId === 'same'), false);
  assert.ok(ofType(runtime, 'SignalObservation').some(e => e.payload.snapshotId === 'same'));
});
test('hunter stops queued work and resumes unacknowledged inputs on start across active networks', async t => {
  const { runtime, hunter } = setup(t);
  runtime.publish(market('stopped')); hunter.stop(); await runtime.flush();
  assert.equal(ofType(runtime, 'TokenCandidate').length, 0);
  hunter.start(); await runtime.flush(); assert.equal(ofType(runtime, 'TokenCandidate').length, 1);
  runtime.selectNetwork('BSC'); runtime.publish(market('bsc', { network: 'BSC', epoch: 2 })); await runtime.flush();
  const candidate = ofType(runtime, 'TokenCandidate').find(e => e.network === 'BSC');
  assert.equal(candidate.epoch, 2); assert.deepEqual(candidate.payload.anomalies, ['TOKEN_DISCOVERY']);
});
test('hunter durable restart reuses handled IDs even when the wall clock makes old observations stale', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'botmeme-hunter-')), journalPath = path.join(directory, 'events.jsonl');
  let runtime = createRuntime({ journalPath, now }), hunter = createHunter({ runtime, now, policy });
  t.after(async () => {
    hunter.stop(); await runtime.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('botmeme-hunter-')); fs.rmSync(directory, { recursive: true, force: true });
  });
  hunter.start(); runtime.publish(market('source')); await runtime.flush(); const original = runtime.snapshot().events;
  hunter.stop(); await runtime.close();
  const later = () => new Date('2026-09-24T11:00:00.000Z');
  runtime = createRuntime({ journalPath, now: later }); hunter = createHunter({ runtime, now: later, policy });
  hunter.start(); await runtime.flush(); runtime.publish(market('source')); await runtime.flush();
  assert.deepEqual(runtime.snapshot().events, original); assert.equal(runtime.snapshot().deliveryErrors.length, 0);
});
test('hunter rejects malformed research policy before registering a consumer', async t => {
  const runtime = createRuntime({ now }); t.after(() => runtime.close());
  for (const bad of [{ ...policy, minQuality: 1.1 }, { ...policy, maxAgeMs: 0 }, { ...policy, momentumThreshold: NaN }, { ...policy, minLiquidityUsd: -1 }, { ...policy, volumeLiquidityThreshold: Infinity }, { ...policy, extra: 1 }]) {
    assert.throws(() => createHunter({ runtime, now, policy: bad }), /INVALID_HUNTER_POLICY/);
  }
  assert.equal(runtime.snapshot().events.length, 0);
});
test('hunter includes configured freshness quality liquidity and volume-ratio boundaries', async t => {
  const { runtime } = setup(t);
  runtime.publish(market('boundary', { confidence: 0.7, evidence_quality: 0.7, uncertainty: 0.3, payload: { ...market('x').payload, observedAt: '2026-09-24T09:59:00.000Z', volume24hUsd: 100 } }));
  await runtime.flush();
  assert.deepEqual(ofType(runtime, 'TokenCandidate')[0].payload.anomalies, ['TOKEN_DISCOVERY']);
});
test('hunter resumes a partially persisted candidate without changing its decision after clock advances', async t => {
  let time = new Date(at);
  const runtime = createRuntime({ now: () => time, maxPending: 2 }), hunter = createHunter({ runtime, now: () => time, policy });
  t.after(async () => { hunter.stop(); await runtime.close(); });
  hunter.start(); await runtime.flush();
  runtime.publish(market('partial')); await runtime.flush();
  const original = ofType(runtime, 'TokenCandidate')[0];
  assert.ok(original); assert.equal(ofType(runtime, 'SignalObservation').length, 0);
  assert.equal(ofType(runtime, 'AIActivityEvent').length, 0);
  time = new Date('2026-09-24T11:00:00.000Z');
  hunter.stop(); hunter.start(); await runtime.flush();
  assert.equal(ofType(runtime, 'SignalObservation').length, 1);
  hunter.stop(); hunter.start(); await runtime.flush();
  assert.deepEqual(ofType(runtime, 'TokenCandidate'), [original]);
  assert.equal(ofType(runtime, 'AIActivityEvent').length, 1);
  assert.equal(ofType(runtime, 'AIActivityEvent')[0].payload.state, 'COMPLETED');
});
