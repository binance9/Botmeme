'use strict';
// Manual paper-entry integration tests — operator BUY through the same
// independent risk -> strategy -> safety -> intent -> paper chain.
// Mirrors tests/exit-manager.test.cjs. Run: node --test tests/manual-entry.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('../runtime/events/bus.cjs');
const { createTradeStore } = require('../core/trades/store.cjs');
const { executeManualEntry } = require('../services/commander/manual-entry.cjs');
const { createManualPaperExecution } = require('../runtime/manual-paper-execution.cjs');

const at = '2026-10-03T09:00:00.000Z';
const goodReader = () => ({ network: 'SOLANA', async read() {
  return { mintAuthorityRevoked: true, freezeAuthorityRevoked: true, maxLpLockedPct: 85, top10HolderPct: 25, insiderHolderPct: 5, scoreNormalised: 10 };
} });
function compose() {
  let clock = new Date(at);
  const now = () => clock;
  const runtime = createRuntime({ now });
  const tradeStore = createTradeStore({ runtime, capitalUsd: 10000, now });
  return { runtime, tradeStore, now, advance: ms => { clock = new Date(clock.getTime() + ms); }, stop: async () => runtime.close() };
}
let seq = 0;
for (const veto of [null, 'Jev', 'safety']) test('old volume spike returns through autonomous chain: ' + (veto || 'approved'), async () => {
  const ctx = compose(), modules = [];
  try {
    const hunter = require('../services/jev/hunter.cjs').createHunter(ctx); modules.push(hunter); hunter.start();
    const quiet = snapshot('AWAKEN', .001);
    quiet.source += '#pool-price';
    Object.assign(quiet.payload, { poolAgeMs: 45 * 86400000, marketCapUsd: 15000, realVolumeUsd: 400, volume24hUsd: 100, recentVolumeUsd: 400, recentTxs5m: 4 });
    ctx.runtime.publish(quiet); await ctx.runtime.flush();
    assert.equal(ctx.runtime.snapshot().events.some(e => e.type === 'TokenCandidate'), false);
    const spike = { ...quiet, id: quiet.id + '/spike', payload: { ...quiet.payload, recentVolumeUsd: 1500 } };
    ctx.runtime.publish(spike); await ctx.runtime.flush();
    const candidate = ctx.runtime.snapshot().events.find(e => e.type === 'TokenCandidate');
    assert.ok(candidate.payload.anomalies.includes('REAL_VOLUME'));
    ctx.runtime.publish({ ...candidate, id: candidate.id + '/verdict', type: 'JevVerdict', status: 'COMPLETED', evidence: [candidate.id],
      payload: { candidateId: candidate.id, action: veto === 'Jev' ? 'REJECT' : 'TRADE', confidence: .9, tradableProbability: .9, momentum: null, model: 'test', latencyMs: 1, violations: [] } });
    ctx.runtime.publish({ ...spike, id: spike.id + '/regime', type: 'MarketRegimeState', evidence: [spike.id],
      payload: { regime: 'MOMENTUM_EXPANSION', snapshotIds: [spike.id], reason: 'test' } });
    const reader = veto === 'safety' ? { async read() { return { ...await goodReader().read(), mintAuthorityRevoked: false }; } } : goodReader();
    modules.push(require('../core/safety/gate.cjs').createSafetyGate({ ...ctx, readers: { SOLANA: reader } }),
      require('../core/risk/engine.cjs').createRiskEngine(ctx), require('../core/strategy/engine.cjs').createStrategyEngine(ctx),
      require('../core/execution/paper.cjs').createPaperExecution({ ...ctx, policy: { requireSafetyVerdict: true } }),
      require('../services/commander/service.cjs').createCommander(ctx));
    modules.slice(1).forEach(m => m.start()); await ctx.runtime.flush();
    const events = ctx.runtime.snapshot().events;
    assert.ok(events.some(e => e.type === 'StrategyDecision' && e.payload.action === 'BUY'));
    assert.ok(events.some(e => e.type === 'RiskDecision' && e.payload.approved));
    assert.equal(events.findLast(e => e.type === 'SafetyDecision').payload.approved, !veto);
    assert.equal(ctx.tradeStore.snapshot().positions.length, veto ? 0 : 1);
    assert.deepEqual(ctx.runtime.snapshot().deliveryErrors, []);
  } finally { modules.reverse().forEach(m => m.stop()); await ctx.stop(); }
});
for (const [name, extra, approved] of [
  ['newborn', { poolAgeMs: 0 }, true],
  ['59 seconds', { poolAgeMs: 59000 }, true],
  ['1 minute', { poolAgeMs: 60000 }, true],
  ['5 minutes', { poolAgeMs: 300000 }, true],
  ['6 minutes', { poolAgeMs: 6 * 60000 }, true],
  ['30 minutes', { poolAgeMs: 30 * 60000 }, true],
  ['31 minutes', { poolAgeMs: 31 * 60000 }, true],
  ['2 hours', { poolAgeMs: 2 * 3600000 }, true],
  ['15 days', { poolAgeMs: 15 * 86400000 }, true],
  ['30 days', { poolAgeMs: 30 * 86400000 }, true],
  ['45 days', { poolAgeMs: 45 * 86400000 }, true],
  ['volume 200 rejected', { realVolumeUsd: 200 }, false],
  ['volume 999 rejected', { realVolumeUsd: 999 }, false],
  ['volume 1000 boundary', { realVolumeUsd: 1000 }, true],
  ['volume 2001 has no upper limit', { realVolumeUsd: 2001 }, true],
  ['recent volume 999 overrides real volume', { recentVolumeUsd: 999, recentTxs5m: 4 }, false],
  ['recent volume 1000 boundary', { recentVolumeUsd: 1000, recentTxs5m: 4 }, true],
  ['headline fallback', { realVolumeUsd: undefined, volume24hUsd: 1000 }, true],
  ['headline below floor', { realVolumeUsd: undefined, volume24hUsd: 999 }, false],
  ['cap 3000 rejected', { marketCapUsd: 3000 }, false],
  ['cap 8000 rejected', { marketCapUsd: 8000 }, false],
  ['cap 9999 rejected', { marketCapUsd: 9999 }, false],
  ['cap 10000 boundary', { marketCapUsd: 10000 }, true],
  ['cap 20000 boundary', { marketCapUsd: 20000 }, true],
  ['cap 20001 rejected', { marketCapUsd: 20001 }, false],
  ['cap 25000 rejected', { marketCapUsd: 25000 }, false],
  ['cap 30000 rejected', { marketCapUsd: 30000 }, false],
  ['cap 50M rejected', { marketCapUsd: 50000000 }, false],
  ['cap 1B rejected', { marketCapUsd: 1000000000 }, false],
  ['cap 30001 rejected', { marketCapUsd: 30001 }, false],
  ['cap 10M rejected', { marketCapUsd: 10000000 }, false],
  ['cap 10M plus one rejected', { marketCapUsd: 10000001 }, false],
  ['old cap 10k boundary', { poolAgeMs: 45 * 86400000, marketCapUsd: 10000 }, true],
  ['old recent volume below floor', { poolAgeMs: 45 * 86400000, recentVolumeUsd: 999, recentTxs5m: 4 }, false],
]) test('entry policy: ' + name, async () => {
  const ctx = compose(), token = 'POLICY';
  try {
    await seedEvidence(ctx, token, extra);
    const result = await executeManualEntry({ ...ctx, safetyReaders: { SOLANA: goodReader() } }, { execute: true, side: 'BUY', token });
    assert.equal(result.status, approved ? 'FILLED' : 'REJECTED');
    const risk = ctx.runtime.snapshot().events.find(e => e.type === 'RiskDecision');
    assert.equal(risk.payload.approved, approved);
    assert.equal(ctx.tradeStore.snapshot().positions.length, approved ? 1 : 0);
    assert.deepEqual(ctx.runtime.snapshot().deliveryErrors, []);
  } finally { await ctx.stop(); }
});
function snapshot(token, price) { return { id: 'snap-' + token + '-' + (++seq), type: 'MarketSnapshot', timestamp: at, producer: 'MARKET_DATA', source: 'test.scan', evidence: ['ev'], status: 'OBSERVED', correlationId: 'corr-' + token, network: 'SOLANA', epoch: 1, confidence: 0.9, evidence_quality: 0.9, missing_evidence: [], uncertainty: 0.1, payload: { token, price, liquidityUsd: 85000, volume24hUsd: 400000, observedAt: at, marketCapUsd: 10000, poolAgeMs: 3 * 60000, realVolumeUsd: 1000 } }; }
async function seedEvidence(ctx, token, extra = {}) {
  const { runtime } = ctx;
  for (let i = 0; i < 5; i++) {
    const quote = snapshot(token, 0.00001); Object.assign(quote.payload, extra);
    for (const key of Object.keys(quote.payload)) if (quote.payload[key] === undefined) delete quote.payload[key];
    runtime.publish(quote);
  }
  const last = runtime.snapshot().events.filter(e => e.type === 'MarketSnapshot').at(-1);
  runtime.publish({ id: 'cand-' + token, type: 'TokenCandidate', timestamp: last.timestamp, producer: 'JEV', source: 'test.hunter', evidence: [last.id], status: 'OBSERVED', correlationId: last.correlationId, network: 'SOLANA', epoch: 1, confidence: 0.85, evidence_quality: 0.85, missing_evidence: [], uncertainty: 0.15,
    payload: { token, symbol: 'TKB', snapshotId: last.id, liquidityUsd: 85000, volume24hUsd: 400000, rank: 1, anomalies: ['TOKEN_DISCOVERY'] } });
  runtime.publish({ id: 'regime-' + token, type: 'MarketRegimeState', timestamp: at, producer: 'MARKET_DATA', source: 'test', evidence: [last.id], status: 'OBSERVED', correlationId: last.correlationId, network: 'SOLANA', epoch: 1, confidence: 0.9, evidence_quality: 0.9, missing_evidence: [], uncertainty: 0.1,
    payload: { regime: 'MOMENTUM_EXPANSION', snapshotIds: [last.id], reason: 'test' } });
  await runtime.flush();
  return last;
}

test('manual entry rejects an invalid body without touching the journal', async () => {
  const ctx = compose();
  try {
    const before = ctx.runtime.snapshot().events.length;
    await assert.rejects(executeManualEntry(ctx, { execute: true, side: 'BUY' }), /INVALID_PAPER_ENTRY_REQUEST/);
    await assert.rejects(executeManualEntry(ctx, { execute: true, side: 'SELL', token: 'x'.repeat(44) }), /INVALID_PAPER_ENTRY_REQUEST/);
    for (const body of [null, [], { execute: false, side: 'BUY', token: 'X' }, { execute: true, side: 'BUY', token: ' ' }, { execute: true, side: 'BUY', token: 'X', mode: 'live' }]) {
      await assert.rejects(executeManualEntry(ctx, body), /INVALID_PAPER_ENTRY_REQUEST/);
    }
    assert.equal(ctx.runtime.snapshot().events.length, before);
  } finally { await ctx.stop(); }
});

test('manual entry requires quote and regime evidence for the token', async () => {
  const ctx = compose();
  try {
    await seedEvidence(ctx, 'KnownToken1111111111111111111111111111111111111');
    const result = await executeManualEntry({ ...ctx, safetyReaders: { SOLANA: goodReader() } }, { execute: true, side: 'BUY', token: 'UnknownToken11111111111111111111111111111111' });
    assert.equal(result.status, 'REJECTED');
    assert.equal(result.submitted, false);
    assert.equal(result.reason, 'ENTRY_MARKET_EVIDENCE_MISSING');
    for (const missing of ['MarketSnapshot', 'MarketRegimeState', 'TokenCandidate']) {
      const scoped = { ...ctx.runtime, snapshot: () => ({ ...ctx.runtime.snapshot(), events: ctx.runtime.snapshot().events.filter(e => e.type !== missing) }) };
      const absent = await executeManualEntry({ ...ctx, runtime: scoped }, { execute: true, side: 'BUY', token: 'KnownToken1111111111111111111111111111111111111' });
      assert.equal(absent.reason, 'ENTRY_MARKET_EVIDENCE_MISSING');
    }
  } finally { await ctx.stop(); }
});

test('manual entry buys a banded meme after safety passes (FILLED, position OPEN)', async () => {
  const ctx = compose();
  try {
    const token = 'ManualBuy11111111111111111111111111111111111';
    await seedEvidence(ctx, token);
    const result = await executeManualEntry({ runtime: ctx.runtime, tradeStore: ctx.tradeStore, now: () => new Date(at), safetyReaders: { SOLANA: goodReader() } }, { execute: true, side: 'BUY', token });
    assert.equal(result.submitted, true);
    assert.equal(result.side, 'BUY');
    assert.equal(result.status, 'FILLED');
    assert.ok(result.quantity > 0);
    assert.ok(result.reason);
    const position = ctx.tradeStore.snapshot().positions.find(p => p.token === token);
    assert.ok(position && position.quantity === result.quantity, 'paper position OPEN after manual BUY');
    assert.equal(ctx.runtime.get(result.decisionId).payload.candidateId, 'cand-' + token);
    assert.equal(ctx.runtime.snapshot().events.filter(e => e.type === 'TokenCandidate').length, 1);
  } finally { await ctx.stop(); }
});

test('manual settlement retries async safety on the newest admissible quote after another fill', async () => {
  const ctx = compose();
  let release, started;
  const reading = new Promise(resolve => { started = resolve; });
  const reader = { read: () => { started(); return new Promise(resolve => { release = resolve; }); } };
  const execution = createManualPaperExecution({ ...ctx, policy: { requireSafetyVerdict: true } });
  try {
    const original = await seedEvidence(ctx, 'Race');
    await seedEvidence(ctx, 'Other');
    execution.start();
    const pending = executeManualEntry({ ...ctx, safetyReaders: { SOLANA: reader } }, { execute: true, side: 'BUY', token: 'Race' });
    await reading;
    await ctx.runtime.flush();
    assert.equal(ctx.tradeStore.snapshot().trades.length, 0);
    ctx.advance(1000);
    const other = await executeManualEntry({ ...ctx, safetyReaders: { SOLANA: goodReader() } }, { execute: true, side: 'BUY', token: 'Other' });
    assert.equal(other.status, 'FILLED');
    assert.ok(Date.parse(ctx.runtime.get(other.fillId).timestamp) > Date.parse(original.timestamp));
    ctx.advance(1000);
    const fresh = { ...snapshot('Race', .00002), timestamp: ctx.now().toISOString() };
    fresh.payload.observedAt = fresh.timestamp;
    ctx.runtime.publish(fresh);
    // A newer, unreliable observation must not displace the admissible quote.
    ctx.advance(1000);
    const weak = { ...snapshot('Race', .00003), timestamp: ctx.now().toISOString(), confidence: .6 };
    weak.payload.observedAt = weak.timestamp;
    ctx.runtime.publish(weak);
    await ctx.runtime.flush();
    release(await goodReader().read());
    const result = await pending;
    assert.equal(result.status, 'FILLED', result.reason);
    const fill = ctx.runtime.get(result.fillId);
    assert.equal(fill.payload.entryPrice, fresh.payload.price * 1.001);
    assert.equal(fill.payload.snapshotId, original.id);
    assert.ok(fill.evidence.includes(fresh.id));
    assert.equal(ctx.tradeStore.snapshot().trades.filter(t => t.token === 'Race').length, 1);
    assert.deepEqual(ctx.runtime.snapshot().deliveryErrors, []);
  } finally { release?.(await goodReader().read()); execution.stop(); await ctx.stop(); }
});

test('timed out manual BUY stays cancelled after late safety, quotes and consumer replay', async () => {
  const ctx = compose();
  let release;
  const reader = { read: () => new Promise(resolve => { release = resolve; }) };
  const execution = createManualPaperExecution({ ...ctx, policy: { requireSafetyVerdict: true } });
  try {
    await seedEvidence(ctx, 'Cancelled');
    execution.start();
    const result = await executeManualEntry({ ...ctx, waitMs: 40, safetyReaders: { SOLANA: reader } }, { execute: true, side: 'BUY', token: 'Cancelled' });
    assert.equal(result.status, 'REJECTED');
    assert.equal(result.reason, 'ENTRY_SETTLEMENT_TIMEOUT');
    assert.ok(ctx.runtime.get(result.decisionId + '/cancelled'));
    release(await goodReader().read());
    // Simulate the always-on gate completing independently of the stopped gate.
    const candidate = ctx.runtime.get('cand-Cancelled');
    ctx.runtime.publish({ ...candidate, id: 'late-safety', type: 'SafetyDecision', producer: 'SAFETY_GATE', status: 'APPROVED',
      payload: { candidateId: candidate.id, approved: true, reason: 'Passed', checks: [] } });
    ctx.advance(1000);
    const quote = snapshot('Cancelled', .00002);
    quote.timestamp = quote.payload.observedAt = ctx.now().toISOString();
    ctx.runtime.publish(quote);
    await ctx.runtime.flush();
    execution.stop(); execution.start();
    await ctx.runtime.flush();
    assert.equal(ctx.tradeStore.snapshot().trades.length, 0);
  } finally { release?.(await goodReader().read()); execution.stop(); await ctx.stop(); }
});

test('manual BUY preserves the original candidate Jev veto', async () => {
  const ctx = compose();
  try {
    await seedEvidence(ctx, 'Veto');
    const candidate = ctx.runtime.get('cand-Veto');
    ctx.runtime.publish({ ...candidate, id: 'jev-reject', type: 'JevVerdict', status: 'COMPLETED', evidence: [candidate.id],
      payload: { candidateId: candidate.id, action: 'REJECT', confidence: .9, tradableProbability: .1, momentum: null, model: 'test', latencyMs: 1, violations: ['unsafe'] } });
    const result = await executeManualEntry({ ...ctx, safetyReaders: { SOLANA: goodReader() } }, { execute: true, side: 'BUY', token: 'Veto' });
    assert.equal(result.status, 'REJECTED');
    assert.match(result.reason, /Jev.*REJECT/);
    assert.equal(ctx.tradeStore.snapshot().trades.length, 0);
    assert.equal(ctx.runtime.snapshot().events.filter(e => e.type === 'TokenCandidate').length, 1);
  } finally { await ctx.stop(); }
});
