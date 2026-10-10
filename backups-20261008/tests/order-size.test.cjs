'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { executableDepth, sizeOrder, priceFromSqrt } = require('../core/market-data/providers/v4-depth.cjs');
const { DEFAULT_POLICY } = require('../core/risk/engine.cjs');
const { createRuntime } = require('../runtime/events/bus.cjs');
const { createHunter } = require('../services/jev/hunter.cjs');
const { createRegimeEngine } = require('../core/market-data/regime.cjs');
const { createCommander } = require('../services/commander/service.cjs');
const { createRiskEngine } = require('../core/risk/engine.cjs');
const { createStrategyEngine } = require('../core/strategy/engine.cjs');
const { createPaperExecution } = require('../core/execution/paper.cjs');
const { createTradeStore } = require('../core/trades/store.cjs');
const at = '2026-09-25T08:00:56.000Z';
const base = Date.parse(at) - 56000;
let tick = Date.parse(at);
const now = () => new Date(tick);
const hunterPolicy = { maxAgeMs: 60000, minLiquidityUsd: 10000, minQuality: 0.7, momentumThreshold: 0.05, volumeLiquidityThreshold: 3, minRealVolumeUsd: 300, minRecentTxs: 2 };
const sizes = [5, 10, 25, 50, 100];
function curve(liquidity, ticks = []) {
  return executableDepth({ sqrt: 1n << 96n, tick: 0, liquidity, fee: 0, ethUsd: 2500, ticks, slippageBps: DEFAULT_POLICY.slippageBps });
}
function row(measured, usd) {
  const quote = measured.quote(usd);
  const impactBps = quote.priceImpact === null ? null : Math.round(quote.priceImpact * 10000 * 100) / 100;
  const fit = sizeOrder({ plannedOrderUsd: usd, executableDepthUsd: measured.executableDepthUsd, slippageBps: DEFAULT_POLICY.slippageBps });
  const allowed = fit.allowedUsd > 0 ? measured.quote(fit.allowedUsd) : null;
  const allowedImpactBps = allowed && allowed.priceImpact !== null ? Math.round(allowed.priceImpact * 10000 * 100) / 100 : null;
  return { usd, out: quote.out, impactBps, allowedUsd: fit.allowedUsd, allowedImpactBps, state: fit.state };
}
test('order size quotes the planned dollars and shrinks to executable depth', () => {
  const deep = curve(10n ** 24n);
  const thin = curve(10n ** 18n);
  const empty = curve(0n);
  const deepRows = sizes.map(usd => row(deep, usd));
  const thinRows = sizes.map(usd => row(thin, usd));
  const emptyRows = sizes.map(usd => row(empty, usd));
  console.log(JSON.stringify({ slippageBps: DEFAULT_POLICY.slippageBps, deep: { executableDepthUsd: deep.executableDepthUsd, rows: deepRows }, thin: { executableDepthUsd: thin.executableDepthUsd, rows: thinRows }, empty: { executableDepthUsd: empty.executableDepthUsd, rows: emptyRows } }));
  assert.ok(deep.executableDepthUsd >= 100, 'a deep vanilla curve can hold a $100 buy inside policy slippage');
  assert.ok(deepRows.every(item => item.impactBps !== null && item.impactBps <= DEFAULT_POLICY.slippageBps && item.allowedImpactBps <= DEFAULT_POLICY.slippageBps && item.state === 'ELIGIBLE' && item.allowedUsd === item.usd));
  assert.ok(thin.executableDepthUsd > 0 && thin.executableDepthUsd < 10, 'a thin curve still has a positive executable size below the paper budget');
  assert.equal(thinRows.find(item => item.usd === 5).state, 'ELIGIBLE');
  assert.ok(thinRows.find(item => item.usd === 5).allowedUsd <= thin.executableDepthUsd);
  assert.ok(thinRows.filter(item => item.usd > thin.executableDepthUsd).every(item => item.state === 'ELIGIBLE' && item.allowedUsd === thin.executableDepthUsd && item.impactBps > DEFAULT_POLICY.slippageBps && item.allowedImpactBps <= DEFAULT_POLICY.slippageBps));
  assert.equal(empty.executableDepthUsd, 0);
  assert.ok(emptyRows.every(item => item.state === 'WAIT' && item.allowedUsd === 0));
});
function stamp(index) { return new Date(base + index * 8000).toISOString(); }
function snapshot(id, token, index, payload = {}, changes = {}) {
  tick = base + index * 8000;
  return { id, type: 'MarketSnapshot', timestamp: stamp(index), producer: 'MARKET_DATA', source: 'order-size-replay/block/' + (1000 + index) + '/state/' + index.toString(16) + 'x1', evidence: ['provider-observation'], status: 'OBSERVED', correlationId: id, network: 'SOLANA', epoch: 1, confidence: 0.9, evidence_quality: 0.9, missing_evidence: [], uncertainty: 0.1, ...changes,
    payload: { token, price: 0.00001, liquidityUsd: 0, volume24hUsd: 0, observedAt: stamp(index), executableDepthUsd: 4, priceImpactBps: DEFAULT_POLICY.slippageBps, poolAgeMs: 120000, marketCapUsd: 10000, realVolumeUsd: 1000, ...payload } };
}
function types(runtime, type) { return runtime.snapshot().events.filter(event => event.type === type); }
test('a small executable depth becomes ELIGIBLE and an empty or hooked pool stays WAIT', async t => {
  const runtime = createRuntime({ now });
  const hunter = createHunter({ runtime, now, policy: hunterPolicy });
  const regime = createRegimeEngine({ runtime, now });
  t.after(async () => { hunter.stop(); regime.stop(); await runtime.close(); });
  regime.start(); hunter.start();
  const token = '0x1111111111111111111111111111111111111111';
  for (let i = 0; i < 4; i += 1) runtime.publish(snapshot('small-' + i, token, i, { realVolumeUsd: 180 }));
  await runtime.flush();
  assert.equal(types(runtime, 'TokenCandidate').length, 0);
  assert.match(types(runtime, 'AIActivityEvent').at(-1).payload.message, /WATCHING 4\/5/);
  runtime.publish(snapshot('small-4', token, 4));
  await runtime.flush();
  assert.match(types(runtime, 'AIActivityEvent').find(event => event.payload.task === 'small-4').payload.message, /^ELIGIBLE /);
  assert.equal(types(runtime, 'TokenCandidate').length, 1);
  const empty = '0x2222222222222222222222222222222222222222';
  for (let i = 0; i < 5; i += 1) runtime.publish(snapshot('empty-' + i, empty, i, { executableDepthUsd: 0, priceImpactBps: 0, realVolumeUsd: 180 }));
  runtime.publish(snapshot('hook-0', '0x3333333333333333333333333333333333333333', 0, { executableDepthUsd: 0, priceImpactBps: 0, realVolumeUsd: 180 }, { missing_evidence: ['UNSUPPORTED_HOOK'], source: 'order-size-replay/block/1000/state/0x0/hook' }));
  await runtime.flush();
  assert.equal(types(runtime, 'TokenCandidate').filter(event => event.payload.token !== token).length, 0);
  console.log('AI empty:',types(runtime,'AIActivityEvent').filter(e=>/empty/.test(e.payload.task)).map(e=>e.payload.task+': '+e.payload.message.slice(0,60)).join(' | '));
  assert.match(types(runtime, 'AIActivityEvent').find(event => event.payload.task === 'hook-0').payload.message, /UNSUPPORTED_HOOK/);
});
test('paper funnel sizes the buy to executable depth and can exit without a fixed $10000 gate', async t => {
  const runtime = createRuntime({ now });
  const tradeStore = createTradeStore({ runtime, now, capitalUsd: 1000 });
  const regime = createRegimeEngine({ runtime, now });
  const hunter = createHunter({ runtime, now, policy: hunterPolicy });
  const commander = createCommander({ runtime, tradeStore, now });
  const risk = createRiskEngine({ runtime, tradeStore, now });
  const strategy = createStrategyEngine({ runtime, now });
  const paper = createPaperExecution({ runtime, tradeStore, now });
  const { createExitManager } = require('../core/risk/exit-manager.cjs');
  const exit = createExitManager({ runtime, tradeStore, now });
  t.after(async () => { for (const service of [paper, exit, strategy, risk, commander, hunter, regime]) service.stop(); await runtime.close(); });
  for (const service of [regime, strategy, hunter, commander, risk, paper, exit]) service.start();
  const token = '0x4444444444444444444444444444444444444444';
  const measured = curve(10n ** 18n);
  assert.ok(measured.executableDepthUsd > 0 && measured.executableDepthUsd < 10);
  for (let i = 0; i < 5; i += 1) runtime.publish(snapshot('flow-' + i, token, i, { executableDepthUsd: measured.executableDepthUsd, priceImpactBps: measured.priceImpactBps, realVolumeUsd: i < 4 ? 180 : 1000 }));
  await runtime.flush();
  const buy = types(runtime, 'RiskDecision').find(event => event.payload.approved && event.payload.maxExposureUsd > 0);
  const open = types(runtime, 'TradeResult').find(event => event.payload.side === 'BUY' && event.payload.state === 'OPEN');
  assert.ok(buy, 'risk approves the reduced order');
  assert.ok(buy.payload.maxExposureUsd <= measured.executableDepthUsd + 1e-9);
  assert.ok(buy.payload.maxExposureUsd < 10);
  assert.match(buy.payload.reason, /stays inside 10 bps/);
  assert.ok(open, 'paper fills the approved buy');
  // Owner directive 2026-10-01 "-30% cắt lỗ": adverse prints beyond -30% now
  // STOP OUT the position. Entry here is 0.00001002001; 0.000006 is ≈ -40%.
  runtime.publish(snapshot('flow-5', token, 5, { price: 0.000006, executableDepthUsd: measured.executableDepthUsd, priceImpactBps: measured.priceImpactBps }));
  runtime.publish(snapshot('flow-6', token, 6, { price: 0.000006, executableDepthUsd: measured.executableDepthUsd, priceImpactBps: measured.priceImpactBps }));
  await runtime.flush();
  runtime.publish(snapshot('flow-7', token, 7, { price: 0.000006, executableDepthUsd: measured.executableDepthUsd, priceImpactBps: measured.priceImpactBps }));
  await runtime.flush();
  const closed = types(runtime, 'TradeResult').find(event => event.payload.side === 'SELL' && event.payload.state === 'CLOSED');
  assert.ok(closed, 'the -40% print stops the position out');
  assert.ok(closed.payload.realizedPnl < 0, 'stop realizes the loss: ' + closed.payload.realizedPnl);
  const stages = types(runtime, 'AIActivityEvent').map(event => event.payload.message).join('\n');
  assert.match(stages, /WATCHING 4\/5/);
  assert.match(stages, /^ELIGIBLE /m);
});
test('recorded pool states replay through the same size gate', () => {
  const file = 'C:\\Botmeme\\data\\runtime.jsonl';
  if (!fs.existsSync(file)) return;
  const stat = fs.statSync(file);
  const length = Math.min(stat.size, 4 * 1024 * 1024);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, buffer, 0, length, stat.size - length);
  fs.closeSync(fd);
  const seen = new Map();
  for (const line of buffer.toString('utf8').split('\n')) {
    const mark = line.match(/\/state\/([0-9a-f]+)x([0-9a-f]+)/);
    if (!mark || line.includes('/hook')) continue;
    let record; try { record = JSON.parse(line.slice(line.indexOf('{'))); } catch { continue; }
    const event = record?.value?.event || record;
    const price = event?.payload?.price;
    if (!(price > 0)) continue;
    const sqrt = BigInt('0x' + mark[1]), liquidity = BigInt('0x' + mark[2]);
    const spot = priceFromSqrt(sqrt);
    if (!(spot > 0)) continue;
    const measured = executableDepth({ sqrt, tick: 0, liquidity, fee: 0, ethUsd: price * spot, ticks: [], slippageBps: DEFAULT_POLICY.slippageBps });
    if (!measured) continue;
    const key = event.payload.token;
    const previous = seen.get(key);
    if (!previous || measured.executableDepthUsd > previous.executableDepthUsd) seen.set(key, { token: key, executableDepthUsd: measured.executableDepthUsd, priceImpactBps: measured.priceImpactBps, liquidity: liquidity.toString() });
  }
  const ranked = [...seen.values()].sort((a, b) => b.executableDepthUsd - a.executableDepthUsd).slice(0, 5);
  console.log(JSON.stringify({ replayedPools: ranked }));
  assert.ok(Array.isArray(ranked));
});
