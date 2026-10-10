'use strict';
// Exit-manager integration tests — full chain: safety gate -> decision -> risk ->
// intent -> paper fill (OPEN), then the protective exits.
// Owner directive 2026-10-06 "-30% cắt lỗ, x2 chốt gốc, phần còn lại chốt dần":
// a -30% print cuts the WHOLE position; at x2 a single REDUCE banks 50% to
// recover the original capital; only after that tranche does a 30% trailing
// stop manage the remainder. The legacy "ko x10 ko bán" full-exit multiple is
// retired (takeProfitMultiple is accepted in wiring but no longer exits).
// Run: node --test tests/exit-manager.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('../runtime/events/bus.cjs');
const { createTradeStore } = require('../core/trades/store.cjs');
const { createRiskEngine } = require('../core/risk/engine.cjs');
const { createStrategyEngine } = require('../core/strategy/engine.cjs');
const { createExitManager } = require('../core/risk/exit-manager.cjs');
const { createPaperExecution } = require('../core/execution/paper.cjs');
const { createSafetyGate } = require('../core/safety/gate.cjs');

const goodReader = () => ({ network: 'SOLANA', async read() {
  return { mintAuthorityRevoked: true, freezeAuthorityRevoked: true, maxLpLockedPct: 85, top10HolderPct: 25, insiderHolderPct: 5, scoreNormalised: 10 };
} });

function compose({ reader, takeProfitMultiple } = {}) {
  let clock = new Date(at); const now = () => clock;
  const runtime = createRuntime({ now });
  const tradeStore = createTradeStore({ runtime, capitalUsd: 10000, now });
  const inputs = { runtime, tradeStore, now };
  const modules = [
    createRiskEngine(inputs),
    createStrategyEngine(inputs),
    createSafetyGate({ ...inputs, executionMode: () => 'paper', readers: { SOLANA: reader ?? goodReader() } }),
    createExitManager({...inputs,takeProfitMultiple}),
    createPaperExecution({ ...inputs, policy: { requireSafetyVerdict: true } })
  ];
  modules.forEach(m => m.start());
  return { runtime, tradeStore, modules, now, advance: ms => { clock = new Date(+clock + ms); }, stop: async () => { for (const m of modules.slice().reverse()) m.stop(); await runtime.close(); } };
}

let seq = 0;
test('stop remains at -30%: a -29% quote holds before recovery', async () => {
  const ctx = compose();
  try {
    await openMemePosition(ctx, { token: 'STOP-BOUNDARY', entryPrice: .001 });
    ctx.runtime.publish(snapshot('STOP-BOUNDARY', .00071)); await ctx.runtime.flush();
    assert.equal(ctx.runtime.snapshot().events.some(e => e.type === 'StrategyDecision' && e.producer === 'EXIT_MANAGER'), false);
    assert.equal(ctx.tradeStore.snapshot().positions.length, 1);
    const position = ctx.tradeStore.snapshot().positions[0];
    ctx.runtime.publish(snapshot('STOP-BOUNDARY', position.averageCost * 0.70)); await ctx.runtime.flush();
    const exit = ctx.runtime.snapshot().events.find(e => e.type === 'StrategyDecision' && e.producer === 'EXIT_MANAGER');
    assert.equal(exit.payload.action, 'SELL'); assert.match(exit.payload.reason, /STOP_LOSS/);
    const sell = ctx.tradeStore.snapshot().trades.find(t => t.side === 'SELL');
    assert.equal(sell.quantity, position.quantity, 'exact -30% boundary exits the whole position');
    assert.equal(ctx.tradeStore.snapshot().positions.length, 0);
  } finally { await ctx.stop(); }
});
for (const [name, minutes, volume, price, entryAge, exits] of [
  ['31 minutes exits fully', 31, 100, .001, 3 * 60000, true],
  ['30 minute boundary exits fully', 30, 100, .001, 3 * 60000, true],
  ['volume 500 holds', 31, 500, .001, 3 * 60000, false],
  ['volume 200 holds', 31, 200, .001, 3 * 60000, false],
  ['29 minutes holds', 29, 100, .001, 3 * 60000, false],
  ['price above entry still exits', 31, 100, .0011, 3 * 60000, true],
  ['stagnation overrides partial recovery with full exit', 31, 100, .0025, 3 * 60000, true],
  ['old entry exits fully', 31, 0, .001, 45 * 86400000, true],
  ['newborn entry exits fully', 30, 199, .001, 0, true],
  ['middle age entry exits fully', 30, 0, .001, 2 * 3600000, true],
  ['five-minute entry remains eligible after crossing the buy window', 31, 0, .001, 5 * 60000, true],
  ['missing volume holds', 31, undefined, .001, 3 * 60000, false]
]) test('stagnation: ' + name, async () => {
  const ctx = compose(), token = 'STAGNANT';
  try {
    // Simulate a position already open when the new exit manager starts.
    ctx.modules[3].stop();
    await openMemePosition(ctx, { token, entryPrice: .001, extra: { poolAgeMs: entryAge, marketCapUsd: entryAge >= 30 * 86400000 ? 20000 : 15000, realVolumeUsd: 1500 } });
    const quantity = ctx.tradeStore.snapshot().positions[0].quantity;
    ctx.advance(minutes * 60000);
    const quote = snapshot(token, price, 85000, { poolAgeMs: entryAge + minutes * 60000 });
    quote.timestamp = quote.payload.observedAt = ctx.now().toISOString();
    if (volume === undefined) { delete quote.payload.recentVolumeUsd; delete quote.payload.recentTxs5m; }
    else quote.payload.recentVolumeUsd = volume;
    ctx.modules[3].start(); ctx.runtime.publish(quote); await ctx.runtime.flush();
    const exit = ctx.runtime.snapshot().events.find(e => e.producer === 'EXIT_MANAGER' && e.type === 'StrategyDecision');
    assert.equal(Boolean(exit), exits);
    assert.deepEqual(ctx.runtime.snapshot().deliveryErrors, []);
    if (exits) {
      assert.equal(exit.payload.action, 'SELL'); assert.equal(exit.payload.reason, 'STAGNANT: new entry with no volume for 30m — rotating to next token');
      const sell = ctx.tradeStore.snapshot().trades.find(t => t.side === 'SELL');
      assert.equal(sell.quantity, quantity); assert.equal(ctx.tradeStore.snapshot().positions.length, 0);
    } else assert.equal(ctx.tradeStore.snapshot().positions[0].quantity, quantity);
  } finally { await ctx.stop(); }
});
const at = '2026-09-27T15:00:00.000Z';
function snapshot(token, price, liquidityUsd = 85000, extra = {}) { return { id: 'snap-' + token + '-' + price + '-' + (++seq), type: 'MarketSnapshot', timestamp: at, producer: 'MARKET_DATA', source: 'test.scan', evidence: ['ev'], status: 'OBSERVED', correlationId: 'corr-' + token, network: 'SOLANA', epoch: 1, confidence: 0.9, evidence_quality: 0.9, missing_evidence: [], uncertainty: 0.1, payload: { token, price, liquidityUsd, volume24hUsd: 400000, observedAt: at, marketCapUsd: 10000, poolAgeMs: 3 * 60000, realVolumeUsd: 1000, recentVolumeUsd: 2000, recentTxs5m: 4, ...extra } }; }

async function openMemePosition(ctx, { token, entryPrice, safetyReader, extra = {} }) {
  const { runtime } = ctx;
  for (let i = 0; i < 5; i++) runtime.publish(snapshot(token, entryPrice, 85000, extra));
  const last = runtime.snapshot().events.filter(e => e.type === 'MarketSnapshot').at(-1);
  runtime.publish({ id: 'cand-' + token, type: 'TokenCandidate', timestamp: last.timestamp, producer: 'JEV', source: 'test.hunter', evidence: [last.id], status: 'OBSERVED', correlationId: last.correlationId, network: 'SOLANA', epoch: 1, confidence: 0.85, evidence_quality: 0.85, missing_evidence: [], uncertainty: 0.15,
    payload: { token, symbol: 'TKA', snapshotId: last.id, liquidityUsd: last.payload.liquidityUsd, volume24hUsd: 400000, rank: 1, anomalies: ['TOKEN_DISCOVERY'] } });
  await runtime.flush();
  runtime.publish({ id: 'sig-' + token, type: 'SignalObservation', timestamp: at, producer: 'STRATEGY_ENGINE', source: 'test', evidence: [last.id, 'cand-' + token], status: 'OBSERVED', correlationId: last.correlationId, network: 'SOLANA', epoch: 1, confidence: 0.9, evidence_quality: 0.9, missing_evidence: [], uncertainty: 0.1,
    payload: { candidateId: 'cand-' + token, snapshotId: last.id, signals: [{ name: 'price', value: entryPrice }] } });
  runtime.publish({ id: 'regime-' + token, type: 'MarketRegimeState', timestamp: at, producer: 'MARKET_DATA', source: 'test', evidence: [last.id], status: 'OBSERVED', correlationId: last.correlationId, network: 'SOLANA', epoch: 1, confidence: 0.9, evidence_quality: 0.9, missing_evidence: [], uncertainty: 0.1,
    payload: { regime: 'MOMENTUM_EXPANSION', snapshotIds: runtime.snapshot().events.filter(e => e.type === 'MarketSnapshot').map(e => e.id), reason: 'test' } });
  runtime.publish({ id: 'dec-' + token, type: 'StrategyDecision', timestamp: at, producer: 'CODEX_1', source: 'test', evidence: ['cand-' + token, 'sig-' + token, last.id], status: 'APPROVED', correlationId: last.correlationId, network: 'SOLANA', epoch: 1, confidence: 0.9, evidence_quality: 0.9, missing_evidence: [], uncertainty: 0.1,
    payload: { candidateId: 'cand-' + token, snapshotId: last.id, signalIds: ['sig-' + token], strategyVersion: 'meme-flow-v1', quantEvidenceIds: [], criticReportIds: [], regimeId: 'regime-' + token, action: 'BUY', disposition: 'TRADE', reason: 'test entry' } });
  await runtime.flush();
}

test('open meme position buys only after an approved safety verdict; -31% print cuts the FULL position at -30%', async () => {
  const ctx = compose();
  try {
    const token = 'TOKEN-SL';
    await openMemePosition(ctx, { token, entryPrice: 0.001 });
    let fills = ctx.runtime.snapshot().events.filter(e => e.type === 'TradeResult');
    assert.equal(fills.length, 1, 'exactly one BUY fill after safety approval');
    assert.equal(fills[0].payload.side, 'BUY');
    assert.equal(fills[0].payload.state, 'OPEN');
    const approved = ctx.runtime.snapshot().events.find(e => e.type === 'SafetyDecision' && e.payload.approved);
    assert.ok(approved, 'safety verdict approved');

    // Owner directive 2026-10-06: a -31% print (stop -30%) must exit everything.
    ctx.runtime.publish(snapshot(token, 0.00069));
    await ctx.runtime.flush();

    const exit = ctx.runtime.snapshot().events.find(e => e.type === 'StrategyDecision' && e.producer === 'EXIT_MANAGER');
    assert.ok(exit, 'EXIT_MANAGER published a decision on the drawdown');
    assert.match(exit.payload.reason, /STOP_LOSS/);
    fills = ctx.runtime.snapshot().events.filter(e => e.type === 'TradeResult');
    assert.equal(fills.length, 2, 'BUY + protective SELL');
    assert.equal(fills[1].payload.side, 'SELL');
    assert.equal(fills[1].payload.quantity, fills[0].payload.quantity, 'whole position exits');
    assert.equal(fills[1].payload.state, 'CLOSED');
    assert.ok(fills[1].payload.realizedPnl < 0, 'stop-loss realizes a loss: ' + fills[1].payload.realizedPnl);
    assert.equal(ctx.tradeStore.snapshot().positions.length, 0, 'flat after the stop');
  } finally { await ctx.stop(); }
});

test('+20% is noise — no exit below x2 and above -30%', async () => {
  const ctx = compose();
  try {
    const token = 'TOKEN-NOISE';
    await openMemePosition(ctx, { token, entryPrice: 0.001 });
    ctx.runtime.publish(snapshot(token, 0.0012)); // +20% — old TP retired, x2 not reached
    await ctx.runtime.flush();
    const exit = ctx.runtime.snapshot().events.find(e => e.type === 'StrategyDecision' && e.producer === 'EXIT_MANAGER');
    assert.equal(exit, undefined, 'no exit on a +20% print');
    assert.equal(ctx.tradeStore.snapshot().positions.length, 1, 'position stays open');
  } finally { await ctx.stop(); }
});

test('x2 banks half once (RECOVER_ORIGINAL) and never repeats', async () => {
  const ctx = compose();
  try {
    const token = 'TOKEN-X2';
    await openMemePosition(ctx, { token, entryPrice: 0.001 });
    const openQty = ctx.tradeStore.snapshot().positions[0].quantity;
    ctx.runtime.publish(snapshot(token, 0.0025)); // ~x2.5 — clears entry*2 after 10bps slippage
    await ctx.runtime.flush();
    const exit = ctx.runtime.snapshot().events.findLast(e => e.type === 'StrategyDecision' && e.producer === 'EXIT_MANAGER');
    assert.ok(exit, 'exit manager published the recover tranche');
    assert.equal(exit.payload.action, 'REDUCE');
    assert.match(exit.payload.reason, /RECOVER_ORIGINAL/);
    const sells = ctx.runtime.snapshot().events.filter(e => e.type === 'TradeResult' && ['SELL', 'REDUCE'].includes(e.payload.side));
    assert.equal(sells.length, 1, 'one partial SELL filled');
    const pos = ctx.tradeStore.snapshot().positions[0];
    assert.ok(pos && pos.quantity > 0 && pos.quantity < openQty, 'position reduced but still riding: ' + (pos && pos.quantity));
    // A further x2-range print must NOT repeat the tranche.
    ctx.runtime.publish(snapshot(token, 0.0026));
    await ctx.runtime.flush();
    const reduces = ctx.runtime.snapshot().events.filter(e => e.type === 'StrategyDecision' && e.producer === 'EXIT_MANAGER' && e.payload.action === 'REDUCE');
    assert.equal(reduces.length, 1, 'tranche never repeats');
    assert.equal(ctx.tradeStore.snapshot().positions.length, 1, 'still riding the remainder');
  } finally { await ctx.stop(); }
});

for (const failure of ['risk veto', 'execution failure']) test('recovery retries after ' + failure + ' without enabling trailing', async () => {
  const ctx = compose(), token = 'RECOVERY-' + failure;
  try {
    await openMemePosition(ctx, { token, entryPrice: .001 });
    const quantity = ctx.tradeStore.snapshot().positions[0].quantity;
    const bad = snapshot(token, .0025);
    if (failure === 'risk veto') bad.missing_evidence = ['TEST_MISSING_PRICE_EVIDENCE'];
    else bad.confidence = .5; // Risk approves an exit; execution rejects an unreliable quote.
    ctx.runtime.publish(bad); await ctx.runtime.flush();
    const first = ctx.runtime.snapshot().events.findLast(e => e.type === 'StrategyDecision' && e.producer === 'EXIT_MANAGER');
    assert.equal(first.payload.action, 'REDUCE');
    assert.equal(ctx.tradeStore.snapshot().positions[0].quantity, quantity, 'nothing was actually sold');
    const events = ctx.runtime.snapshot().events;
    if (failure === 'risk veto') assert.ok(events.some(e => e.type === 'RiskDecision' && e.payload.decisionId === first.id && !e.payload.approved));
    else assert.ok(events.some(e => e.type === 'AIActivityEvent' && e.producer === 'PAPER_EXECUTION' && e.status === 'FAILED'));
    ctx.runtime.publish(snapshot(token, .00174)); await ctx.runtime.flush();
    assert.equal(ctx.runtime.snapshot().events.filter(e => e.type === 'StrategyDecision' && e.producer === 'EXIT_MANAGER').length, 1, 'failed recovery cannot enable trailing');
    ctx.advance(61000); // Expire risk reservation from the failed execution.
    const retry = snapshot(token, .0026); retry.timestamp = retry.payload.observedAt = ctx.now().toISOString();
    ctx.runtime.publish(retry); await ctx.runtime.flush();
    assert.equal(ctx.runtime.snapshot().events.filter(e => e.type === 'StrategyDecision' && e.producer === 'EXIT_MANAGER' && e.payload.action === 'REDUCE').length, 2);
    assert.equal(ctx.tradeStore.snapshot().positions[0].quantity, quantity / 2, 'retry fills exactly one half');
    assert.deepEqual(ctx.runtime.snapshot().deliveryErrors, []);
  } finally { await ctx.stop(); }
});

test('pending recovery neither duplicates the tranche nor enables trailing, but stop-loss remains active', async () => {
  const ctx = compose(), token = 'RECOVERY-PENDING';
  try {
    await openMemePosition(ctx, { token, entryPrice: .001 });
    ctx.modules[4].stop();
    for (const price of [.0025, .0026, .00174]) { ctx.runtime.publish(snapshot(token, price)); await ctx.runtime.flush(); }
    let exits = ctx.runtime.snapshot().events.filter(e => e.type === 'StrategyDecision' && e.producer === 'EXIT_MANAGER');
    assert.equal(exits.length, 1); assert.equal(exits[0].payload.action, 'REDUCE');
    ctx.runtime.publish(snapshot(token, .00069)); await ctx.runtime.flush();
    exits = ctx.runtime.snapshot().events.filter(e => e.type === 'StrategyDecision' && e.producer === 'EXIT_MANAGER');
    assert.equal(exits.length, 2); assert.match(exits[1].payload.reason, /STOP_LOSS/);
    assert.deepEqual(ctx.runtime.snapshot().deliveryErrors, []);
  } finally { await ctx.stop(); }
});

test('closed BUY receipt cannot govern a reopened position in the same token', async () => {
  const ctx = compose(), token = 'REOPEN-CYCLE';
  try {
    await openMemePosition(ctx, { token, entryPrice: .001 });
    ctx.runtime.publish(snapshot(token, .01)); await ctx.runtime.flush();
    ctx.runtime.publish(snapshot(token, .006)); await ctx.runtime.flush();
    assert.equal(ctx.tradeStore.snapshot().positions.length, 0, 'first cycle recovered and closed');
    const firstBuy = ctx.tradeStore.snapshot().trades.find(t => t.side === 'BUY');
    ctx.advance(1000);
    const quote = snapshot(token, .001); quote.timestamp = quote.payload.observedAt = ctx.now().toISOString();
    ctx.runtime.publish(quote); await ctx.runtime.flush();
    const original = ctx.runtime.get('dec-' + token);
    const signal = ctx.runtime.get(original.payload.signalIds[0]);
    const nextSignal = { ...signal, id: signal.id + '-reopen', timestamp: ctx.now().toISOString(),
      evidence: signal.evidence.map(id => id === signal.payload.snapshotId ? quote.id : id),
      payload: { ...signal.payload, snapshotId: quote.id } };
    ctx.runtime.publish(nextSignal); await ctx.runtime.flush();
    ctx.runtime.publish({ ...original, id: original.id + '-reopen', timestamp: ctx.now().toISOString(),
      evidence: original.evidence.map(id => id === original.payload.snapshotId ? quote.id : id === signal.id ? nextSignal.id : id),
      payload: { ...original.payload, snapshotId: quote.id, signalIds: [nextSignal.id] } });
    await ctx.runtime.flush();
    let portfolio = ctx.tradeStore.snapshot();
    assert.equal(portfolio.positions.length, 1); assert.equal(portfolio.positions[0].cycle, 2);
    assert.equal(portfolio.trades.find(t => t.id === firstBuy.id).state, 'OPEN', 'receipt state is immutable');
    assert.equal(portfolio.trades.find(t => t.id === firstBuy.id).positionState, 'CLOSED');
    const before = ctx.runtime.snapshot().events.filter(e => e.type === 'StrategyDecision' && e.producer === 'EXIT_MANAGER').length;
    const hold = snapshot(token, .0012); hold.timestamp = hold.payload.observedAt = ctx.now().toISOString();
    ctx.runtime.publish(hold); await ctx.runtime.flush();
    assert.equal(ctx.runtime.snapshot().events.filter(e => e.type === 'StrategyDecision' && e.producer === 'EXIT_MANAGER').length, before, 'previous cycle high-water and recovery cannot sell the new position');
    portfolio = ctx.tradeStore.snapshot(); assert.equal(portfolio.positions.length, 1); assert.equal(portfolio.positions[0].cycle, 2);
    assert.deepEqual(ctx.runtime.snapshot().deliveryErrors, []);
  } finally { await ctx.stop(); }
});

test('trailing only governs AFTER the recover tranche (chốt dần)', async () => {
  const ctx = compose();
  try {
    const token = 'TOKEN-TRAIL';
    await openMemePosition(ctx, { token, entryPrice: 0.001 });
    ctx.runtime.publish(snapshot(token, 0.0018)); // high-water +80%
    await ctx.runtime.flush();
    ctx.runtime.publish(snapshot(token, 0.00126)); // -30% off high-water, pre-tranche
    await ctx.runtime.flush();
    assert.equal(ctx.runtime.snapshot().events.filter(e => e.type === 'StrategyDecision' && e.producer === 'EXIT_MANAGER').length, 0, 'no trailing before the tranche');
    assert.equal(ctx.tradeStore.snapshot().positions.length, 1, 'still open');

    ctx.runtime.publish(snapshot(token, 0.0025)); // ~x2.5 — recover tranche
    await ctx.runtime.flush();
    assert.equal(ctx.runtime.snapshot().events.filter(e => e.type === 'StrategyDecision' && e.producer === 'EXIT_MANAGER' && e.payload.action === 'REDUCE').length, 1, 'tranche taken');

    ctx.runtime.publish(snapshot(token, 0.00174)); // high-water 0.0025 * (1-0.3) = 0.00175 — chốt dần
    await ctx.runtime.flush();
    const exit = ctx.runtime.snapshot().events.findLast(e => e.type === 'StrategyDecision' && e.producer === 'EXIT_MANAGER');
    assert.match(exit.payload.reason, /TRAILING_STOP/);
    const last = ctx.runtime.snapshot().events.filter(e => e.type === 'TradeResult').at(-1);
    assert.equal(last.payload.side, 'SELL');
    assert.equal(last.payload.state, 'CLOSED');
    assert.equal(ctx.tradeStore.snapshot().positions.length, 0, 'remainder closed by the trail');
  } finally { await ctx.stop(); }
});

test('legacy x10 multiple is retired — at x10 only the tranche + trail govern', async () => {
  const ctx = compose({ takeProfitMultiple: () => 10 });
  try {
    const token = 'TARGET-RETIRE';
    await openMemePosition(ctx, { token, entryPrice: 0.001 });
    ctx.runtime.publish(snapshot(token, 0.01)); // x10 — old directive would sell 100% here
    await ctx.runtime.flush();
    const decisions = ctx.runtime.snapshot().events.filter(e => e.type === 'StrategyDecision' && e.producer === 'EXIT_MANAGER');
    assert.equal(decisions.length, 1, 'exactly one exit decision');
    assert.equal(decisions[0].payload.action, 'REDUCE');
    assert.match(decisions[0].payload.reason, /RECOVER_ORIGINAL/);
    assert.equal(ctx.tradeStore.snapshot().positions.length, 1, 'remainder keeps riding — no full multiple exit');
  } finally { await ctx.stop(); }
});

test('an availability outage is UNVERIFIED-advisory, an opaque reader failure still blocks the buy', async () => {
  // RUGCHECK_HTTP_503 = availability outage → approved with UNVERIFIED advisory.
  const outage = compose({ reader: { network: 'SOLANA', async read() { throw Error('RUGCHECK_HTTP_503'); } } });
  try {
    const token = 'TOKEN-OUTAGE';
    await openMemePosition(outage, { token, entryPrice: 0.001 });
    await outage.runtime.flush();
    const approved = outage.runtime.snapshot().events.find(e => e.type === 'SafetyDecision' && e.payload.approved);
    assert.ok(approved, 'outage does not read as danger');
    assert.match(approved.payload.reason, /UNVERIFIED/);
    const fills = outage.runtime.snapshot().events.filter(e => e.type === 'TradeResult');
    assert.equal(fills.length, 1, 'buy fills under paper-mode advisory');
  } finally { await outage.stop(); }
  // An opaque, non-availability reader error stays fail-closed.
  const ctx = compose({ reader: { network: 'SOLANA', async read() { throw Error('SAFETY_READER_CORRUPTED'); } } });
  try {
    const token = 'TOKEN-BLOCKED';
    await openMemePosition(ctx, { token, entryPrice: 0.001 });
    await ctx.runtime.flush();
    const rejected = ctx.runtime.snapshot().events.filter(e => e.type === 'SafetyDecision' && !e.payload.approved);
    assert.ok(rejected.length >= 1, 'gate rejected the candidate');
    const fills = ctx.runtime.snapshot().events.filter(e => e.type === 'TradeResult');
    assert.equal(fills.length, 0, 'no fill without an approved safety verdict');
    const failure = ctx.runtime.snapshot().events.find(e => e.type === 'AIActivityEvent' && e.producer === 'PAPER_EXECUTION' && e.status === 'FAILED');
    assert.ok(failure, 'paper execution recorded the refusal');
    assert.match(failure.payload.message, /[Ss]afety verdict missing or rejected/);
  } finally { await ctx.stop(); }
});
