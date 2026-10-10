'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createRuntime } = require('../runtime/events/bus.cjs');
const { createTradeStore } = require('../core/trades/store.cjs');
const { executeManualExit } = require('../services/commander/manual-exit.cjs');
const { createManualPaperExecution } = require('../runtime/manual-paper-execution.cjs');
const { createDashboardAdapter } = require('../dashboard/adapter/index.cjs');
const { detailCells } = require('../public/meme-trader/app.js');
const { seedPosition } = require('./helpers/manual-paper-fixture.cjs');
async function setup(t) {
  let clock = new Date('2026-10-01T12:00:00Z'); const now = () => clock;
  const runtime = createRuntime({ now }), tradeStore = createTradeStore({ runtime, now, capitalUsd: 10000 });
  t.after(() => runtime.close());
  const ctx = { runtime, tradeStore, now, advance: ms => { clock = new Date(+clock + ms); } };
  ctx.trade = await seedPosition(ctx); return ctx;
}
const request = trade => ({ execute: true, side: 'SELL', percent: 100, tradeId: trade.id });
const withoutQuotes = runtime => ({ ...runtime, snapshot: () => { const state = runtime.snapshot(); return { ...state, events: state.events.filter(e => !['MarketSnapshot','MarketRegimeState'].includes(e.type)) }; } });
test('manual SELL without quote or regime settles on entry basis without publishing fake market data', async t => {
  const ctx = await setup(t); ctx.advance(4*3600000);
  const basis = ctx.tradeStore.snapshot().positions[0].averageCost;
  const result = await executeManualExit({ ...ctx, runtime: withoutQuotes(ctx.runtime) }, request(ctx.trade));
  assert.equal(result.status, 'FILLED');
  assert.equal(ctx.runtime.get(result.fillId).payload.exitPrice, basis*.999);
  assert.match(ctx.runtime.get(result.decisionId).payload.reason, /no market quote; settled at entry basis/);
  assert.equal(ctx.runtime.snapshot().events.filter(e => e.type === 'MarketSnapshot').length, 2);
});
test('manual SELL accepts a quote older than a committed fill; autonomous replay still fails', async t => {
  const ctx = await setup(t); ctx.advance(1000);
  await seedPosition(ctx, 'OTHER');
  const decision = ctx.runtime.get('FOMO/buy');
  const risk = ctx.runtime.snapshot().events.find(e => e.type === 'RiskDecision' && e.payload.decisionId === decision.id);
  const old = ctx.runtime.snapshot().events.find(e => e.type === 'ExecutionIntent' && e.payload.decisionId === decision.id);
  const execution = createManualPaperExecution(ctx); execution.start(); t.after(() => execution.stop());
  ctx.runtime.publish({ ...old, id: 'autonomous-replay', timestamp: ctx.now().toISOString(), payload: { ...old.payload, riskDecisionId: risk.id } });
  await ctx.runtime.flush();
  assert.ok(ctx.runtime.snapshot().events.some(e => e.type === 'AIActivityEvent' && e.payload.task === 'autonomous-replay' && /predates a committed fill/.test(e.payload.message)));
  execution.stop();
  const result = await executeManualExit(ctx, request(ctx.trade));
  assert.equal(result.status, 'FILLED');
  assert.equal(ctx.runtime.get(result.fillId).payload.exitPrice, .00225*.999);
});
for (const mode of ['fresh','stale','entry']) test('adapter open PnL and UI mark: ' + mode, async t => {
  const ctx = await setup(t);
  if (mode === 'stale') ctx.advance(4*3600000);
  const adapter = createDashboardAdapter({ ...ctx, runtime: mode === 'entry' ? withoutQuotes(ctx.runtime) : ctx.runtime });
  t.after(() => adapter.close());
  const row = adapter.snapshot().trades.find(r => r.id === ctx.trade.id);
  assert.ok(Number.isFinite(row.pnlUsd)); assert.ok(Number.isFinite(row.pnlPct));
  if (mode === 'entry') { assert.equal(row.mark, 'entry'); assert.equal(row.pnlUsd, 0); assert.equal(row.pnlPct, 0); }
  else { assert.ok(row.pnlUsd > 0); assert.ok(row.markUpdatedAt); assert.equal(row.markStale, mode === 'stale'); }
  const html = detailCells(row);
  assert.match(html, /color:#22c55e/);
  if (mode !== 'fresh') assert.ok(html.includes(mode === 'stale' ? '(giá cũ)' : '(giá vào)'));
  assert.match(detailCells({ ...row, pnlUsd: -1, pnlPct: -2 }), /color:#ef4444/);
});
