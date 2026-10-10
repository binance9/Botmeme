'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createRuntime } = require('../runtime/events/bus.cjs');
const { createTradeStore } = require('../core/trades/store.cjs');
const { createRiskEngine } = require('../core/risk/engine.cjs');
const { createPaperExecution } = require('../core/execution/paper.cjs');
const { createStrategyEngine } = require('../core/strategy/engine.cjs');
const { derived } = require('../runtime/events/derived.cjs');
const at = '2026-09-24T10:00:00.000Z', now = () => new Date(at);
function envelope(id, type, producer, payload, changes = {}) { return { id, type, producer, payload, timestamp: at, source: 'risk-test', evidence: ['observation'], status: 'OBSERVED', correlationId: 'decision', network: 'SOLANA', epoch: 1, confidence: .9, evidence_quality: .9, missing_evidence: [], uncertainty: .1, ...changes }; }
function seed(runtime, options = {}) {
  const emit = (...args) => runtime.publish(envelope(...args));
  emit('snapshot', 'MarketSnapshot', 'MARKET_DATA', { token: 'token', price: 10, liquidityUsd: options.liquidity ?? 100000, volume24hUsd: 20000, observedAt: options.observedAt ?? at, ...(options.marketCapUsd === undefined ? {} : { marketCapUsd: options.marketCapUsd, poolAgeMs: 45 * 86400000 }) });
  emit('candidate', 'TokenCandidate', 'JEV', { token: 'token', symbol: 'T', snapshotId: 'snapshot', liquidityUsd: 100000, volume24hUsd: 20000, rank: 1, anomalies: [] });
  emit('signal', 'SignalObservation', 'JEV', { candidateId: 'candidate', snapshotId: 'snapshot', signals: [{ name: 'momentum', value: .1 }] });
  emit('regime', 'MarketRegimeState', 'MARKET_DATA', { regime: options.regime ?? 'TRENDING', snapshotIds: ['snapshot'], reason: 'Observed test regime.' });
  const proposal = { strategyVersion: 'v1', parentVersion: null, regimes: ['TRENDING'], parameters: [], backtestId: null, walkForwardId: null, lifecycle: 'IDEA' };
  emit('idea', 'StrategyProposal', 'CODEX_2', proposal);
  emit('bt', 'BacktestResult', 'CODEX_2', { proposalId: 'idea', strategyVersion: 'v1', trades: 5, netPnl: options.netPnl ?? .1, maxDrawdown: .01, expectancy: .02, sharpe: .5, sampleStart: '2026-09-23T10:00:00.000Z', sampleEnd: at }, { status: 'COMPLETED' });
  emit('wf', 'WalkForwardResult', 'CODEX_2', { proposalId: 'idea', strategyVersion: 'v1', backtestId: 'bt', folds: 1, outOfSamplePnl: .05, maxDrawdown: .02 }, { status: 'COMPLETED' });
  emit('challenger', 'StrategyProposal', 'CODEX_2', { ...proposal, backtestId: 'bt', walkForwardId: 'wf', lifecycle: 'CHALLENGER' });
  emit('critic', 'ProposalCritique', 'CODEX_3', { proposalId: 'challenger', backtestId: 'bt', walkForwardId: 'wf', paperTradeIds: [], verdict: options.verdict ?? 'SUPPORTED', reason: 'Test evidence assessment.' });
  emit('lifecycle', 'StrategyLifecycleDecision', 'CODEX_1', { strategyVersion: 'v1', proposalId: 'challenger', stage: 'PAPER_EVALUATION', previousId: null, critiqueId: 'critic', reason: 'Bounded research only.' });
  if (options.stage === 'DISABLED') emit('disabled', 'StrategyLifecycleDecision', 'CODEX_1', { strategyVersion: 'v1', proposalId: 'challenger', stage: 'DISABLED', previousId: 'lifecycle', critiqueId: 'critic', reason: 'Disabled test strategy.' });
}
function decision(id = 'decision', changes = {}) { return envelope(id, 'StrategyDecision', 'CODEX_1', { candidateId: 'candidate', snapshotId: 'snapshot', signalIds: ['signal'], strategyVersion: 'v1', quantEvidenceIds: ['bt', 'wf'], criticReportIds: ['critic'], regimeId: 'regime', action: 'BUY', disposition: 'TRADE', reason: 'Research action.', ...changes.payload }, { correlationId: id, ...changes, payload: { candidateId: 'candidate', snapshotId: 'snapshot', signalIds: ['signal'], strategyVersion: 'v1', quantEvidenceIds: ['bt', 'wf'], criticReportIds: ['critic'], regimeId: 'regime', action: 'BUY', disposition: 'TRADE', reason: 'Research action.', ...changes.payload } }); }
function setup(t, options = {}, policy = {}) { const runtime = createRuntime({ now }), tradeStore = createTradeStore({ runtime, now, capitalUsd: 1000 }), risk = createRiskEngine({ runtime, tradeStore, now, policy }); t.after(async () => { risk.stop(); await runtime.close(); }); seed(runtime, options); risk.start(); return { runtime, tradeStore, risk }; }
const results = runtime => runtime.snapshot().events.filter(e => e.type === 'RiskDecision');

for (const [name, options] of [
  ['zero depth', {}],
  ['rounded dust', { depth: 1e-15 }],
  ['viability dust', { depth: .001, gas: .001 }],
  ['inclusive lower age', { age: 60000 }],
  ['inclusive upper age', { age: 1800000 }],
  ['old entry shares sizing', { age: 30 * 86400000, cap: 20000 }],
  ['cash bounded', { cash: .2, maximum: .2 }],
  ['exposure bounded', { used: 22.32, maximum: .1 }],
  ['concentration bounded', { concentration: 1.9, maximum: .106 }],
  ['equity bounded', { equity: 2, maximum: .17 }],
  ['execution cap bounded', { entryCap: .1, maximum: .1 }],
  ['tunable floor capped', { floor: 100, maximum: 2 }],
  ['8.5% equity sizing', { floor: 100, entryCap: Infinity, maximum: 2.006 }],
  ['equity growth scales sizing', { floor: 100, entryCap: Infinity, equity: 47.2, maximum: 4.012 }],
  ['no cash', { cash: 0, reject: /budget exhausted/ }],
  ['exposure exhausted', { used: 23.6, reject: /budget exhausted/ }],
  ['unrepresentable floor', { price: 3, decimals: 0, reject: /below one token unit/ }],
  ['costs still too high', { gas: 1, reject: /viability failed after fresh-window floor/ }]
]) test('fresh thin-pool sizing: ' + name, async t => {
  const runtime = createRuntime({ now });
  seed(runtime);
  const tradeStore = { maxEntryUsd: () => options.entryCap ?? 2, snapshot: () => ({
    performance: { equity: options.equity ?? 23.6, cash: options.cash ?? 23.6, capitalUsed: options.used ?? 0, maxDrawdown: 0 },
    positions: options.concentration ? [{ network: 'SOLANA', token: 'thin', costBasis: options.concentration, quantity: 1 }] : [], trades: []
  }) };
  const risk = createRiskEngine({ runtime, tradeStore, now, policy: { minFreshOrderUsd: options.floor ?? .5 } });
  t.after(async () => { risk.stop(); await runtime.close(); });
  runtime.publish(envelope('thin-snapshot', 'MarketSnapshot', 'MARKET_DATA', { token: 'thin', price: options.price ?? .00001, tokenDecimals: options.decimals ?? 6, liquidityUsd: 1, volume24hUsd: 1000, realVolumeUsd: 1000, marketCapUsd: options.cap ?? 10000, poolAgeMs: options.age ?? 120000, observedAt: at, executableDepthUsd: options.depth ?? 0, priceImpactBps: 10, gasUsd: options.gas ?? 0 }));
  runtime.publish(envelope('thin-candidate', 'TokenCandidate', 'JEV', { token: 'thin', symbol: 'T', snapshotId: 'thin-snapshot', liquidityUsd: 1, volume24hUsd: 1000, rank: 1, anomalies: ['TOKEN_DISCOVERY', 'REAL_VOLUME'] }));
  risk.start();
  runtime.publish(decision('thin-decision', { payload: { snapshotId: 'thin-snapshot', candidateId: 'thin-candidate', signalIds: [], strategyVersion: 'meme-flow-v1' } }));
  await runtime.flush();
  assert.deepEqual(runtime.snapshot().deliveryErrors, []);
  const result = results(runtime)[0];
  if (options.reject) {
    assert.equal(result.status, 'REJECTED'); assert.match(result.payload.reason, options.reject);
  } else {
    assert.equal(result.status, 'APPROVED'); assert.ok(result.payload.quantity > 0);
    assert.match(result.payload.reason, /fresh-window floor applied/);
    const maximum = options.maximum ?? .5;
    assert.ok(result.payload.maxExposureUsd <= maximum + 1e-12);
    assert.ok(result.payload.maxExposureUsd > maximum * .99);
    assert.ok(Math.abs(result.payload.quantity * .00001 * 1.001 - result.payload.maxExposureUsd) < 1e-12);
  }
});

test('non-meme zero depth retains its sizing veto', async t => {
  const { runtime } = setup(t);
  runtime.publish(envelope('empty-depth', 'MarketSnapshot', 'MARKET_DATA', { token: 'token', price: 10, liquidityUsd: 1, volume24hUsd: 1000, observedAt: at, executableDepthUsd: 0, priceImpactBps: 0 }));
  runtime.publish(decision('empty-buy', { payload: { snapshotId: 'empty-depth', signalIds: [] } }));
  await runtime.flush();
  assert.equal(results(runtime)[0].status, 'REJECTED');
  assert.match(results(runtime)[0].payload.reason, /no executable size/);
});

for (const [age, volume, approved, reason] of [
  [0, 1000, true], [59000, 1000, true], [60000, 1000, true],
  [300000, 1000, true], [301000, 1000, true], [360000, 1000, true],
  [29 * 60000, 1000, true], [30 * 60000, 1000, true], [31 * 60000, 1000, true],
  [180000, 199, false, /Insufficient volume/], [180000, 999, false, /Insufficient volume/], [180000, 1000, true],
  [180000, 2000, true], [180000, 2001, true]
]) test('independent meme risk boundary: age ' + age + ', volume ' + volume, async t => {
  const { runtime } = setup(t);
  runtime.publish(envelope('meme-snapshot', 'MarketSnapshot', 'MARKET_DATA', { token: 'token', price: 10, liquidityUsd: 100000, volume24hUsd: volume, realVolumeUsd: volume, marketCapUsd: 10000, poolAgeMs: age, observedAt: at }));
  runtime.publish(envelope('meme-candidate', 'TokenCandidate', 'JEV', { token: 'token', symbol: 'T', snapshotId: 'meme-snapshot', liquidityUsd: 100000, volume24hUsd: volume, rank: 1, anomalies: ['TOKEN_DISCOVERY', 'REAL_VOLUME'] }));
  runtime.publish(decision('meme-decision', { payload: { candidateId: 'meme-candidate', snapshotId: 'meme-snapshot', signalIds: [], strategyVersion: 'meme-flow-v1' } }));
  await runtime.flush();
  const result = results(runtime)[0];
  assert.equal(result.status, approved ? 'APPROVED' : 'REJECTED');
  if (reason) assert.match(result.payload.reason, reason);
  assert.deepEqual(runtime.snapshot().deliveryErrors, []);
});

for (const age of [60000, 180000, 300000, 30 * 86400000]) test('EZzimpx9 liquidity 50: shared entry exemption at age ' + age, async t => {
  const { runtime } = setup(t);
  runtime.publish(envelope('fresh-snapshot', 'MarketSnapshot', 'MARKET_DATA', { token: 'EZzimpx9', price: 0.001, liquidityUsd: 50, volume24hUsd: 1000, realVolumeUsd: 1000, marketCapUsd: 10000, poolAgeMs: age, observedAt: at }));
  runtime.publish(envelope('fresh-candidate', 'TokenCandidate', 'JEV', { token: 'EZzimpx9', symbol: 'EZ', snapshotId: 'fresh-snapshot', liquidityUsd: 50, volume24hUsd: 1000, rank: 1, anomalies: ['TOKEN_DISCOVERY', 'REAL_VOLUME'] }));
  runtime.publish(decision('fresh-decision', { payload: { candidateId: 'fresh-candidate', snapshotId: 'fresh-snapshot', signalIds: [], strategyVersion: 'meme-flow-v1' } }));
  await runtime.flush();
  assert.deepEqual(runtime.snapshot().deliveryErrors, []);
  assert.equal(results(runtime)[0].status, 'APPROVED');
});

for (const marketCapUsd of [9999, 10000, 20000, 20001, 25000, 30000, 10000000, 10000001, 50000000, 1000000000]) test('independent meme risk cap boundary: ' + marketCapUsd, async t => {
  const { runtime } = setup(t);
  runtime.publish(envelope('band-snapshot', 'MarketSnapshot', 'MARKET_DATA', { token: 'token', price: 10, liquidityUsd: 100000, volume24hUsd: 1000, realVolumeUsd: 1000, marketCapUsd, poolAgeMs: 180000, observedAt: at }));
  runtime.publish(envelope('band-candidate', 'TokenCandidate', 'JEV', { token: 'token', symbol: 'T', snapshotId: 'band-snapshot', liquidityUsd: 100000, volume24hUsd: 1000, rank: 1, anomalies: ['TOKEN_DISCOVERY', 'REAL_VOLUME'] }));
  runtime.publish(decision('band-decision', { payload: { candidateId: 'band-candidate', snapshotId: 'band-snapshot', signalIds: [], strategyVersion: 'meme-flow-v1' } }));
  await runtime.flush();
  const approved = marketCapUsd >= 10000 && marketCapUsd <= 20000, result = results(runtime)[0];
  assert.equal(result.status, approved ? 'APPROVED' : 'REJECTED');
  if (!approved) assert.equal(result.payload.reason, 'VETO: Cap outside the $10000-$20000 entry band.');
  assert.deepEqual(runtime.snapshot().deliveryErrors, []);
});

for (const marketCapUsd of [25000, 10000000]) test('non-band risk retains separate absolute ceiling: ' + marketCapUsd, async t => {
  const { runtime } = setup(t, { marketCapUsd }); runtime.publish(decision()); await runtime.flush();
  assert.equal(results(runtime)[0].status, 'APPROVED');
});

for (const marketCapUsd of [10000001, 50000000, 1000000000]) test('independent risk rejects oversized BUY even outside meme strategy: ' + marketCapUsd, async t => {
  const { runtime } = setup(t, { marketCapUsd }); runtime.publish(decision()); await runtime.flush();
  assert.equal(results(runtime)[0].status, 'REJECTED');
  assert.equal(results(runtime)[0].payload.reason, 'Cap above the $10M hard ceiling — not a meme.');
});
test('risk independently approves bounded paper evaluation size and preserves trace', async t => {
  const { runtime } = setup(t); runtime.publish(decision()); await runtime.flush();
  assert.equal(runtime.snapshot().deliveryErrors.length, 0); const result = results(runtime)[0];
  assert.equal(result.payload.approved, true); assert.equal(result.payload.quantity, 1); assert.equal(result.payload.maxExposureUsd, 10);
  assert.equal(result.correlationId, 'decision'); assert.ok(result.evidence.includes('critic'));
});
test('risk vetoes stale uncertain adverse unsupported and losing research despite commander BUY', async t => {
  for (const [options, changes] of [[{ regime: 'UNKNOWN' }, {}], [{ regime: 'RISK_OFF' }, {}], [{ verdict: 'REJECTED' }, {}], [{ netPnl: -.1 }, {}], [{ stage: 'DISABLED' }, {}], [{ liquidity: 100 }, {}], [{ observedAt: '2026-09-24T09:58:00.000Z' }, {}], [{}, { confidence: .2 }], [{}, { payload: { quantEvidenceIds: [] } }]]) {
    const { runtime } = setup(t, options); runtime.publish(decision('decision', changes)); await runtime.flush();
    const result = results(runtime)[0]; assert.equal(result.payload.approved, false); assert.equal(result.payload.quantity, 0); assert.equal(result.status, 'REJECTED');
  }
});
for (const [liquidity, approved] of [[150, false], [200, true], [300, true]]) test('risk liquidity floor: ' + liquidity + ' USD', async t => {
  const { runtime } = setup(t, { liquidity }); runtime.publish(decision()); await runtime.flush();
  assert.deepEqual(runtime.snapshot().deliveryErrors, []);
  const result = results(runtime)[0];
  assert.equal(result.payload.approved, approved);
  if (!approved) assert.equal(result.payload.reason, 'VETO: insufficient liquidity.');
});

test('risk queued approvals reserve global capital and concentration without duplicate grants', async t => {
  const { runtime, risk } = setup(t, {}, { positionFraction: .02, maxExposureFraction: .02 });
  for (let i = 0; i < 4; i++) runtime.publish(decision('d' + i)); await runtime.flush();
  assert.equal(results(runtime).filter(e => e.payload.approved).length, 2);
  assert.equal(results(runtime).filter(e => !e.payload.approved).length, 2);
  risk.stop(); risk.start(); await runtime.flush(); assert.equal(results(runtime).length, 4);
});
test('risk skips HOLD and NO_ACTION and refuses nonexistent exit positions', async t => {
  const { runtime } = setup(t);
  runtime.publish(decision('hold', { payload: { action: 'HOLD', disposition: 'WATCH' } }));
  runtime.publish(decision('none', { payload: { action: 'NO_ACTION', disposition: 'NO_ACTION' } }));
  runtime.publish(decision('exit', { payload: { action: 'SELL', disposition: 'EXIT' } }));
  await runtime.flush(); assert.equal(results(runtime).length, 1); assert.equal(results(runtime)[0].payload.approved, false);
});
test('risk allows a position-reducing exit despite low regime confidence and reserves its quantity', async t => {
  const { runtime } = setup(t); runtime.publish(decision()); await runtime.flush();
  const risk = results(runtime)[0], trace = { candidateId: 'candidate', snapshotId: 'snapshot', signalIds: ['signal'], strategyVersion: 'v1', decisionId: 'decision', riskDecisionId: risk.id };
  runtime.publish(envelope('intent', 'ExecutionIntent', 'STRATEGY_ENGINE', { mode: 'paper', token: 'token', ...trace, action: 'BUY', quantity: 1, referencePrice: 10 }, { status: 'APPROVED' }));
  runtime.publish(envelope('fill', 'TradeResult', 'PAPER_EXECUTION', { mode: 'paper', intentId: 'intent', token: 'token', ...trace, side: 'BUY', quantity: 1, entryPrice: 10, exitPrice: null, realizedPnl: 0, fees: 0, slippageBps: 0, state: 'OPEN' }, { status: 'COMPLETED' }));
  runtime.publish(decision('exit', { confidence: .1, uncertainty: .9, payload: { action: 'SELL', disposition: 'EXIT' } }));
  runtime.publish(decision('exit-again', { payload: { action: 'SELL', disposition: 'EXIT' } }));
  await runtime.flush(); assert.equal(results(runtime).find(e => e.payload.decisionId === 'exit').payload.quantity, 1); assert.equal(results(runtime).find(e => e.payload.decisionId === 'exit-again').payload.approved, false);
});
test('risk policy rejects unbounded nonfinite or unknown configuration', () => {
  const runtime = createRuntime({ now }), tradeStore = createTradeStore({ runtime, now });
  for (const policy of [{ feeBps: Infinity }, { maxPositions: 1.5 }, { stopDistance: 0 }, { maxExposureFraction: 2 }, { surprise: 1 }]) assert.throws(() => createRiskEngine({ runtime, tradeStore, now, policy }), /INVALID_RISK_POLICY/);
  return runtime.close();
});
test('risk cash sizing reserves fee and slippage rather than spending the whole balance', async t => {
  const { runtime } = setup(t, { liquidity: 1e9 }, { positionFraction: 1, maxExposureFraction: 1, perTradeRisk: 1, stopDistance: .1, paperEvaluationFraction: 1 });
  runtime.publish(decision()); await runtime.flush();
  const result = results(runtime)[0]; assert.equal(result.payload.approved, true);
  assert.ok(result.payload.maxExposureUsd < 1000); assert.ok(Math.abs(result.payload.maxExposureUsd * 1.001 * 1.001 - 1000) < 1e-9);
});
test('risk approves after five realized losses even with compatibility cooldown policy', async t => {
  const { runtime, tradeStore } = setup(t, {}, { lossCount: 1, maxDrawdown: 1 });
  runtime.publish(decision()); await runtime.flush();
  const publishFill = (id, side, risk, price, claimedPnl) => {
    const quantity = risk.payload.quantity;
    const d = runtime.get(risk.payload.decisionId), trace = { candidateId: 'candidate', snapshotId: 'snapshot', signalIds: ['signal'], strategyVersion: 'v1', decisionId: d.id, riskDecisionId: risk.id };
    runtime.publish(envelope(id + '-intent', 'ExecutionIntent', 'STRATEGY_ENGINE', { mode: 'paper', token: 'token', ...trace, action: side, quantity, referencePrice: price }, { status: 'APPROVED', correlationId: d.id }));
    runtime.publish(envelope(id + '-fill', 'TradeResult', 'PAPER_EXECUTION', { mode: 'paper', intentId: id + '-intent', token: 'token', ...trace, side, quantity, entryPrice: 10, exitPrice: side === 'BUY' ? null : price, realizedPnl: side === 'BUY' ? 0 : claimedPnl, fees: 0, slippageBps: 0, state: side === 'BUY' ? 'OPEN' : 'CLOSED' }, { status: 'COMPLETED', correlationId: d.id }));
  };
  for (let i = 0; i < 5; i++) {
    if (i) { runtime.publish(decision('buy-' + i)); await runtime.flush(); }
    const buy = results(runtime).find(e => e.payload.decisionId === (i ? 'buy-' + i : 'decision'));
    assert.equal(buy.payload.approved, true);
    publishFill('buy-' + i, 'BUY', buy, 10, 0);
    runtime.publish(decision('exit-' + i, { payload: { action: 'SELL', disposition: 'EXIT' } })); await runtime.flush();
    publishFill('sell-' + i, 'SELL', results(runtime).find(e => e.payload.decisionId === 'exit-' + i), 8, 99999);
  }
  assert.equal(tradeStore.snapshot().trades.filter(t => t.side === 'SELL' && t.realizedPnl < 0).length, 5);
  runtime.publish(decision('after-loss')); await runtime.flush();
  const rejection = results(runtime).find(e => e.payload.decisionId === 'after-loss');
  assert.equal(rejection.payload.approved, true);
  assert.ok(results(runtime).every(e => !/consecutive-loss cooldown/.test(e.payload.reason)));
});
test('risk cannot reuse old supported critique after newer rejection', async t => {
  const { runtime } = setup(t);
  runtime.publish(envelope('new-critic', 'ProposalCritique', 'CODEX_3', { proposalId: 'challenger', backtestId: 'bt', walkForwardId: 'wf', paperTradeIds: [], verdict: 'REJECTED', reason: 'New contrary evidence.' }));
  runtime.publish(decision()); await runtime.flush();
  assert.equal(results(runtime)[0].payload.approved, false); assert.match(results(runtime)[0].payload.reason, /latest critique/);
});
test('risk releases only canonical evidenced terminal paper failure, not an unrelated failed activity', async t => {
  const { runtime, tradeStore } = setup(t, {}, { positionFraction: .01 });
  runtime.publish(decision()); await runtime.flush();
  const risk = results(runtime)[0], trace = { candidateId: 'candidate', snapshotId: 'snapshot', signalIds: ['signal'], strategyVersion: 'v1', decisionId: 'decision', riskDecisionId: risk.id };
  runtime.publish(envelope('intent', 'ExecutionIntent', 'STRATEGY_ENGINE', { mode: 'paper', token: 'token', ...trace, action: 'BUY', quantity: 1, referencePrice: 10 }, { status: 'APPROVED' }));
  runtime.publish(envelope('unrelated-failure', 'AIActivityEvent', 'PAPER_EXECUTION', { agent: 'PAPER_EXECUTION', task: 'intent', state: 'FAILED', progress: null, message: 'Unbound failure.' }, { source: 'paper.next-observation', status: 'FAILED', evidence: ['intent', risk.id, 'snapshot'] }));
  runtime.publish(decision('still-reserved')); await runtime.flush();
  assert.equal(results(runtime).find(e => e.payload.decisionId === 'still-reserved').payload.approved, false);
  const later = '2026-09-24T10:00:01.000Z', paper = createPaperExecution({ runtime, tradeStore, now: () => new Date(later) });
  t.after(() => paper.stop()); paper.start();
  runtime.publish(envelope('bad-next-quote', 'MarketSnapshot', 'MARKET_DATA', { token: 'token', price: 10, liquidityUsd: 100000, volume24hUsd: 20000, observedAt: later }, { timestamp: later, missing_evidence: ['Provider incomplete.'] }));
  await runtime.flush();
  assert.ok(runtime.snapshot().events.some(e => e.id.startsWith('paper.failure/')));
  runtime.publish(decision('after-terminal', { timestamp: later })); await runtime.flush();
  assert.equal(results(runtime).find(e => e.payload.decisionId === 'after-terminal').payload.approved, true);
});
test('risk releases expired-epoch approvals when returning to the same network', async t => {
  const { runtime } = setup(t, {}, { positionFraction: .01 });
  runtime.publish(decision()); await runtime.flush();
  runtime.selectNetwork('BSC'); runtime.selectNetwork('SOLANA');
  const ids = new Set(['snapshot', 'candidate', 'signal', 'regime', 'idea', 'bt', 'wf', 'challenger', 'critic', 'lifecycle', 'decision']);
  const rewrite = value => typeof value === 'string' ? ids.has(value) ? value + '-epoch3' : value : Array.isArray(value) ? value.map(rewrite) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)])) : value;
  const publish = event => runtime.publish({ ...rewrite(event), epoch: 3 });
  seed({ publish }); publish(decision()); await runtime.flush();
  assert.equal(results(runtime).find(e => e.payload.decisionId === 'decision-epoch3').payload.approved, true);
});
test('risk releases canonical strategy pre-intent failure but not an unrelated failed activity', async t => {
  const { runtime } = setup(t, {}, { positionFraction: .01 });
  runtime.publish(decision()); await runtime.flush(); const risk = results(runtime)[0];
  runtime.publish(envelope('unrelated-strategy-failure', 'AIActivityEvent', 'STRATEGY_ENGINE', { agent: 'STRATEGY_ENGINE', task: risk.id, state: 'FAILED', progress: null, message: 'Not bound to approval.' }, { source: 'strategy_engine.service', status: 'FAILED', evidence: [risk.id], missing_evidence: ['Unverified failure.'] }));
  runtime.publish(decision('still-reserved')); await runtime.flush();
  assert.equal(results(runtime).find(e => e.payload.decisionId === 'still-reserved').payload.approved, false);
  const strategy = createStrategyEngine({ runtime, maxAgeMs: 60000, now: () => new Date('2026-09-24T10:02:00.000Z') });
  t.after(() => strategy.stop()); strategy.start(); await runtime.flush(); strategy.stop();
  assert.equal(runtime.snapshot().events.filter(e => e.type === 'ExecutionIntent').length, 0);
  runtime.publish(decision('after-preintent-failure')); await runtime.flush();
  assert.equal(results(runtime).find(e => e.payload.decisionId === 'after-preintent-failure').payload.approved, true);
});
test('a strategy failure cannot cancel capital already handed to execution', async t => {
  const { runtime } = setup(t, {}, { positionFraction: .01 }); runtime.publish(decision()); await runtime.flush();
  const risk = results(runtime)[0], strategy = createStrategyEngine({ runtime, now }); t.after(() => strategy.stop());
  strategy.start(); await runtime.flush(); strategy.stop();
  assert.equal(runtime.snapshot().events.filter(e => e.type === 'ExecutionIntent').length, 1);
  runtime.publish(derived(risk, { producer: 'STRATEGY_ENGINE', type: 'AIActivityEvent', status: 'FAILED', missing_evidence: ['Contradictory pre-intent failure.'], payload: { agent: 'STRATEGY_ENGINE', task: risk.id, state: 'FAILED', progress: null, message: 'Must not release live intent.' } }));
  runtime.publish(decision('still-owned-by-execution')); await runtime.flush();
  assert.equal(results(runtime).find(e => e.payload.decisionId === 'still-owned-by-execution').payload.approved, false);
});
