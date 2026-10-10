'use strict';
// Pure world fixtures exercise decision contracts, not real market acceptance.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createRuntime } = require('../runtime/events/bus.cjs');
const { createTradeStore } = require('../core/trades/store.cjs');
const { buildWorld } = require('../services/commander/world.cjs');
const { plan } = require('../services/commander/decision.cjs');
const { DEFAULTS: regimePolicy } = require('../core/market-data/regime.cjs');
const { createCommander } = require('../services/commander/service.cjs');
const { transition } = require('../core/strategy/lifecycle.cjs');
const at = '2026-09-24T10:00:00.000Z', now = () => new Date(at);
function event(id, type, producer, payload, extra = {}) { return { id, type, timestamp: at, producer, source: 'commander-contract-case', evidence: ['observation/' + id], status: 'OBSERVED', correlationId: 'study', network: 'SOLANA', epoch: 1, confidence: .9, evidence_quality: .9, uncertainty: .1, missing_evidence: [], payload, ...extra }; }
function inputs(runtime, withRegime = true) {
  const snapshot = event('snapshot', 'MarketSnapshot', 'MARKET_DATA', { token: 'token', price: 10, liquidityUsd: 10000, volume24hUsd: 20000, observedAt: at });
  const candidate = event('candidate', 'TokenCandidate', 'JEV', { token: 'token', symbol: 'TOKEN', snapshotId: snapshot.id, liquidityUsd: 10000, volume24hUsd: 20000, rank: 1, anomalies: [] });
  const regime = event('regime', 'MarketRegimeState', 'MARKET_DATA', { regime: 'TRENDING', snapshotIds: [snapshot.id], reason: 'Protocol regime fixture.' });
  const signal = event('signal', 'SignalObservation', 'JEV', { candidateId: candidate.id, snapshotId: snapshot.id, signals: [{ name: 'price_change_fraction', value: .1 }] });
  if (runtime) { runtime.publish(snapshot); runtime.publish(candidate); if (withRegime) runtime.publish(regime); runtime.publish(signal); }
  return { snapshot, candidate, regime, signal };
}
function worldFixture() {
  const { snapshot, candidate, regime, signal } = inputs();
  const proposal = event('proposal', 'StrategyProposal', 'CODEX_2', { strategyVersion: 'v1', regimes: ['TRENDING'], parameters: [{ name: 'threshold', value: .01 }], backtestId: 'backtest', walkForwardId: 'walk' });
  const backtest = event('backtest', 'BacktestResult', 'CODEX_2', { expectancy: 1 });
  const walk = event('walk', 'WalkForwardResult', 'CODEX_2', { outOfSamplePnl: 2 });
  const critic = event('critic', 'ProposalCritique', 'CODEX_3', { proposalId: proposal.id, verdict: 'SUPPORTED', paperTradeIds: [] });
  const world = { network: 'SOLANA', epoch: 1, history: [snapshot, candidate, regime, signal, backtest, walk], local: [snapshot, candidate, regime, signal], candidates: [candidate], signals: [signal], regimes: [regime], strategies: [{ stage: 'PAPER_EVALUATION', proposal }], critiques: [critic], portfolio: { positions: [], trades: [], performance: { equity: 1000, maxDrawdown: 0, capitalUsed: 0 } } };
  return { world, candidate, signal };
}
function research(runtime) {
  const idea = event('idea', 'StrategyProposal', 'CODEX_2', { strategyVersion: 'v1', parentVersion: null, regimes: ['TRENDING'], parameters: [{ name: 'threshold', value: .01 }], backtestId: null, walkForwardId: null, lifecycle: 'IDEA' }); runtime.publish(idea);
  const bt = event('bt', 'BacktestResult', 'CODEX_2', { proposalId: idea.id, strategyVersion: 'v1', trades: 20, netPnl: 5, maxDrawdown: .1, expectancy: 1, sharpe: 1, sampleStart: '2026-09-23T10:00:00.000Z', sampleEnd: at }, { status: 'COMPLETED' }); runtime.publish(bt);
  const wf = event('wf', 'WalkForwardResult', 'CODEX_2', { proposalId: idea.id, strategyVersion: 'v1', backtestId: bt.id, folds: 3, outOfSamplePnl: 4, maxDrawdown: .1 }, { status: 'COMPLETED' }); runtime.publish(wf);
  const proposal = { ...idea, id: 'challenger', payload: { ...idea.payload, lifecycle: 'CHALLENGER', backtestId: bt.id, walkForwardId: wf.id } }; runtime.publish(proposal);
  return proposal;
}
test('commander chooses no action without quant and waits for missing or unknown regime', () => {
  const { world, candidate, signal } = worldFixture();
  assert.equal(plan(world, candidate, signal, now()).action, 'BUY', 'The positive protocol baseline must actually reach the entry path');
  world.strategies = []; assert.equal(plan(world, candidate, signal, now()).action, 'NO_ACTION');
  world.regimes[0].payload.regime = 'UNKNOWN'; assert.equal(plan(world, candidate, signal, now()).action, 'NO_ACTION');
  world.regimes = []; assert.equal(plan(world, candidate, signal, now()).action, 'NO_ACTION', 'regime chưa chấm: chờ, không tự bịa regimeId');
});
test('commander compares candidates and obeys capital drawdown stale and uncertainty constraints', () => {
  for (const mutate of [
    w => { w.candidates.push({ ...w.candidates[0], id: 'stronger', payload: { ...w.candidates[0].payload, rank: 1 } }); w.candidates[0].payload.rank = 2; },
    w => { w.portfolio.performance.capitalUsed = 950; }, w => { w.portfolio.performance.maxDrawdown = .6; },
    w => { w.history[0].payload.observedAt = '2026-09-24T09:54:00.000Z'; }, w => { w.candidates[0].uncertainty = 1; }
  ]) { const { world, candidate, signal } = worldFixture(); assert.equal(plan(world, candidate, signal, now()).action, 'BUY'); mutate(world); assert.equal(plan(world, candidate, signal, now()).action, 'NO_ACTION'); }
});
test('commander weak evidence quality and newer rejected critique cannot authorize entry', () => {
  for (const mutate of [w => { w.history[0].evidence_quality = 0; }, w => { w.critiques.push({ ...w.critiques[0], id: 'rejected', payload: { ...w.critiques[0].payload, verdict: 'REJECTED' } }); }]) {
    const { world, candidate, signal } = worldFixture(); assert.equal(plan(world, candidate, signal, now()).action, 'BUY'); mutate(world); assert.equal(plan(world, candidate, signal, now()).action, 'NO_ACTION');
  }
});
test('commander world is an isolated history prefix unaffected by later persisted state', async t => {
  const runtime = createRuntime({ now }), store = createTradeStore({ runtime, now }); t.after(() => runtime.close());
  const { snapshot, signal } = inputs(runtime); const later = { ...snapshot, id: 'future-snapshot', payload: { ...snapshot.payload, price: 900 } }; runtime.publish(later);
  const world = buildWorld(runtime, store, signal.id); assert.equal(world.history.some(e => e.id === later.id), false);
  assert.throws(() => { world.history[0].payload.price = 1234; }, TypeError, 'world events are frozen copies: mutation is impossible');
  assert.equal(runtime.get(snapshot.id).payload.price, 10);
  assert.equal(buildWorld(runtime, store, signal.id).history[0].payload.price, 10);
});
test('commander lifecycle cannot skip fork or accept quant self-promotion', async t => {
  const runtime = createRuntime({ now }); t.after(() => runtime.close()); const proposal = research(runtime);
  assert.throws(() => transition(runtime, proposal, proposal, 'CHAMPION'), /INVALID_LIFECYCLE_TRANSITION/);
  const first = transition(runtime, proposal, proposal, 'PAPER_EVALUATION');
  const fork = { ...first, id: 'fork', payload: { ...first.payload, previousId: null } };
  assert.throws(() => runtime.publish(fork), /LIFECYCLE_FORK/);
  assert.throws(() => runtime.publish({ ...first, id: 'quant-promotion', producer: 'CODEX_2' }), /INVALID_EVENT_PRODUCER/);
  assert.throws(() => runtime.publish({ ...proposal, id: 'self-champion', payload: { ...proposal.payload, lifecycle: 'CHAMPION' } }), /INVALID_EVENT_ENUM/);
});
test('commander keeps WAIT verdicts in the activity feed and restart does not duplicate the journal', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'botmeme-commander-')), journalPath = path.join(directory, 'events.jsonl');
  let runtime = createRuntime({ journalPath, now }), commander = createCommander({ runtime, tradeStore: createTradeStore({ runtime, now }), now });
  t.after(async () => { commander.stop(); await runtime.close(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('botmeme-commander-')); fs.rmSync(directory, { recursive: true, force: true }); });
  commander.start(); inputs(runtime); await runtime.flush(); assert.deepEqual(runtime.snapshot().deliveryErrors, []);
  const decisions = runtime.snapshot().events.filter(e => e.type === 'StrategyDecision'); assert.equal(decisions.length, 0, 'WAIT verdicts are activity events, not journaled decisions');
  assert.ok(runtime.snapshot().events.some(e => e.type === 'AIActivityEvent' && e.producer === 'CODEX_1'), 'the comparison still lands in the live feed');
  commander.stop(); await runtime.close(); runtime = createRuntime({ journalPath, now }); commander = createCommander({ runtime, tradeStore: createTradeStore({ runtime, now }), now });
  commander.start(); await runtime.flush(); assert.deepEqual(runtime.snapshot().events.filter(e => e.type === 'StrategyDecision'), decisions);
});
test('commander absent regime creates pending activity without invented decision references', async t => {
  const runtime = createRuntime({ now }), commander = createCommander({ runtime, tradeStore: createTradeStore({ runtime, now }), now });
  t.after(async () => { commander.stop(); await runtime.close(); }); commander.start(); inputs(runtime, false); await runtime.flush();
  assert.equal(runtime.snapshot().events.filter(e => e.type === 'StrategyDecision').length, 0, 'no decision without a regime');
  assert.ok(runtime.snapshot().events.some(e => e.type === 'AIActivityEvent' && e.producer === 'CODEX_1' && /pending|Regime|stale|uncertainty|Compared/i.test(e.payload.message)));
});
test('commander rejected critique never promotes a challenger or emits a trade decision', async t => {
  const runtime = createRuntime({ now }), commander = createCommander({ runtime, tradeStore: createTradeStore({ runtime, now }), now });
  t.after(async () => { commander.stop(); await runtime.close(); }); commander.start();
  const proposal = research(runtime); inputs(runtime); await runtime.flush();
  const critic = event('reject', 'ProposalCritique', 'CODEX_3', { proposalId: proposal.id, backtestId: proposal.payload.backtestId, walkForwardId: proposal.payload.walkForwardId, paperTradeIds: [], verdict: 'REJECTED', reason: 'Out-of-sample assumptions contradict this proposal.' });
  runtime.publish(critic); await runtime.flush();
  assert.deepEqual(runtime.snapshot().deliveryErrors, []);
  assert.equal(runtime.snapshot().events.filter(e => e.type === 'StrategyLifecycleDecision').length, 0);
  assert.ok(runtime.snapshot().events.filter(e => e.type === 'StrategyDecision').every(e => e.payload.action === 'NO_ACTION'));
});
test('new pool with one real snapshot waits for configured history instead of buying', () => {
  const { world, candidate, signal } = worldFixture();
  world.strategies = [];
  world.regimes[0].payload.regime = 'UNKNOWN';
  world.regimes[0].confidence = 0;
  candidate.payload.anomalies = ['TOKEN_DISCOVERY'];
  Object.assign(world.history[0].payload, { poolAgeMs: 131099, marketCapUsd: 4481.759112, realVolumeUsd: 234.161318705184, liquidityUsd: 4481.7795 });
  const result = plan(world, candidate, signal, now());
  assert.equal(result.action, 'NO_ACTION');
  assert.equal(result.disposition, 'WAIT');
  assert.match(result.reason, /Insufficient chronological observations/);
  world.history[0].payload.marketCapUsd = 100001;
  assert.equal(plan(world, candidate, signal, now()).action, 'NO_ACTION');
  const samples = Array.from({ length: regimePolicy.minSamples }, (_, index) => ({ ...world.history[0], id: 'snap-' + index, payload: { ...world.history[0].payload, poolAgeMs: 120000, marketCapUsd: 10000, realVolumeUsd: 1000, liquidityUsd: 12000, observedAt: new Date(Date.parse(at) - (regimePolicy.minSamples - 1 - index) * 60000).toISOString() } }));
  world.history.splice(0, 1, ...samples);
  world.local.splice(0, 1, ...samples);
  signal.payload.snapshotId = samples.at(-1).id;
  world.regimes[0].payload.regime = 'TRENDING';
  world.regimes[0].payload.snapshotIds = [samples.at(-1).id];
  world.regimes[0].confidence = .9;
  world.regimes[0].uncertainty = .1;
  const bought = plan(world, candidate, signal, now());
  assert.equal(bought.action, 'BUY');
  assert.equal(bought.version, 'meme-flow-v1');
  assert.equal(bought.confidenceBasis, 'flow');
});
