'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createApplication } = require('../runtime/application.cjs');
const { seedPosition } = require('./helpers/manual-paper-fixture.cjs');
const { createDashboardServer } = require('../scripts/serve-meme-trader.cjs');
const { createDashboardAdapter } = require('../dashboard/adapter/index.cjs');
const { openPositions, markers } = require('../public/meme-trader/app.js');
function setup(t, close = true) {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-paper-exit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = new Date('2026-10-01T12:00:00Z'); const now = () => clock;
  const app = createApplication({ now, capitalUsd:10000, providers:{}, liveConfig: { root, env: {} } });
  if (close) t.after(() => app.close());
  return { app, now, advance: ms => { clock = new Date(clock.getTime()+ms); } };
}
const request = trade => ({tradeId:trade.id,side:'SELL',percent:100,execute:true});
test('FOMO +125% paper exit uses risk/intent/fill while scanner stopped; concurrent duplicate cannot oversell', async t => {
  const {app,now}=setup(t),trade=await seedPosition({...app,now}); assert.ok(trade);
  const before=app.tradeStore.snapshot().positions[0].quantity;
  const results=await Promise.allSettled([app.sellPaper(request(trade)),app.sellPaper(request(trade))]);
  assert.equal(results[0].value.status,'FILLED'); assert.equal(results[0].value.quantity,before);
  assert.match(results[1].reason.message,/OPEN_POSITION_NOT_FOUND/);
  assert.equal(app.tradeStore.snapshot().positions.length,0); assert.equal(app.control().running,false);
  const events=app.runtime.snapshot().events.filter(e=>e.correlationId===results[0].value.decisionId);
  assert.deepEqual(events.filter(e=>['StrategyDecision','RiskDecision','ExecutionIntent','TradeResult'].includes(e.type)).map(e=>e.type),['StrategyDecision','RiskDecision','ExecutionIntent','TradeResult']);
  assert.equal(events.find(e=>e.type==='TradeResult').payload.mode,'paper');
  assert.ok(events.find(e=>e.type==='TradeResult').payload.realizedPnl>0);
});
test('manual SELL accepts hours-old prices with an audit note while stopped',async t=>{
  const {app,now,advance}=setup(t),trade=await seedPosition({...app,now}); advance(3*3600000);
  const result=await app.sellPaper(request(trade));assert.equal(result.status,'FILLED');
  assert.match(app.runtime.get(result.decisionId).payload.reason,/stale quote accepted, quoteAgeMs=10800000/);
  assert.equal(app.runtime.get(result.fillId).payload.exitPrice,.00225*.999);
  assert.equal(app.tradeStore.snapshot().positions.length,0);
});
test('invalid, buy, partial, old epoch and closed requests never execute',async t=>{
  const {app,now}=setup(t),trade=await seedPosition({...app,now});
  for(const body of [{...request(trade),side:'BUY'},{...request(trade),percent:50},{...request(trade),mode:'live'}])await assert.rejects(app.sellPaper(body),/INVALID_PAPER_EXIT_REQUEST/);
  await app.selectNetwork('BSC');await app.selectNetwork('SOLANA');await assert.rejects(app.sellPaper(request(trade)),/POSITION_SESSION_MISMATCH/);
  assert.equal(app.tradeStore.snapshot().positions.length,1);
});
test('existing HTTP order route returns updated snapshot; preview stays read-only',async t=>{
  const {app,now}=setup(t,false),trade=await seedPosition({...app,now});
  const server=createDashboardServer({application:app,now,copyWatch:false,copyPath:null});
  await new Promise(r=>server.server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const url='http://127.0.0.1:'+server.server.address().port+'/api/orders/preview';
  const post=body=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const {execute,...preview}=request(trade);const p=await(await post(preview)).json();assert.equal(p.submitted,false);
  const response=await post(request(trade)),result=await response.json();assert.equal(response.status,200);assert.equal(result.status,'FILLED');
  assert.equal(openPositions(result.snapshot.trades).length,0);assert.equal(result.snapshot.protection.length,0);
  assert.equal(result.snapshot.summary.openPositions,0);
});
test('UI groups open buys once, separates reductions/history and places markers only on matching candles',()=>{
  const at='2026-10-01T12:00:10Z',base={network:'SOLANA',tokenId:'FOMO',status:'open',updatedAt:at,entryPriceUsd:1,exitPriceUsd:2};
  const rows=[{...base,id:'reduce',side:'REDUCE'},{...base,id:'new',side:'BUY'},{...base,id:'old',side:'BUY'},{...base,id:'closed',side:'BUY',status:'closed'},{...base,id:'other',side:'BUY',network:'BSC'}];
  assert.deepEqual(openPositions(rows).map(t=>t.id),['new','other']);
  const market={network:'SOLANA',tokenId:'FOMO'},candles=[{timestamp:Date.parse('2026-10-01T12:00:00Z')}];
  const points=markers(rows,market,candles,60000);assert.equal(points.length,4);assert.equal(points[0].value,2);assert.equal(points[1].value,1);
  assert.equal(markers(rows,{...market,priceSource:'REFERENCE_FEED'},candles,60000).length,0);
  assert.equal(markers(rows,market,[{timestamp:Date.parse(at)+60000}],60000).length,0);
});
test('live quote leaves fill updatedAt immutable for markers and values remaining position after a reduction',async t=>{
  const {app,now}=setup(t),trade=await seedPosition({...app,now});
  const inputs={...app,now};
  const modules=[require('../core/risk/engine.cjs').createRiskEngine(inputs),require('../core/strategy/engine.cjs').createStrategyEngine(inputs),require('../core/risk/exit-manager.cjs').createExitManager(inputs),require('../core/execution/paper.cjs').createPaperExecution(inputs)];
  modules.forEach(m=>m.start());await app.runtime.flush();modules.forEach(m=>m.stop());
  const reduced=app.tradeStore.snapshot().trades.find(t=>t.side==='REDUCE');assert.ok(reduced,'x2 protective tranche filled');
  const position=app.tradeStore.snapshot().positions[0];assert.equal(position.quantity,trade.quantity/2);
  const adapter=createDashboardAdapter({...app,now});t.after(()=>adapter.close());
  adapter.quote({network:'SOLANA',token:'FOMO',priceUsd:.0023,at:now().getTime()});
  const row=adapter.snapshot().trades.find(t=>t.id===trade.id);assert.equal(row.updatedAt,trade.timestamp);
  assert.ok(row.pnlPct>120);assert.equal(row.pnlUsd,adapter.snapshot().summary.unrealizedPnlUsd);
  assert.equal(row.pnlUsd,.0023*position.quantity-position.costBasis);
  assert.equal(adapter.snapshot().trades.find(t=>t.id===reduced.id).pnlUsd,reduced.realizedPnl,'realized REDUCE PnL is not overwritten by a live mark');
  const sold=await app.sellPaper(request(trade));assert.equal(sold.status,'FILLED');assert.equal(sold.quantity,position.quantity);
});
test('manual exit coexists with active normal consumers without duplicate fills',async t=>{
  const {app,now,advance}=setup(t),trade=await seedPosition({...app,now}); advance(3*3600000);
  const inputs={...app,now};
  const modules=[require('../core/risk/engine.cjs').createRiskEngine(inputs),require('../core/strategy/engine.cjs').createStrategyEngine(inputs),require('../core/execution/paper.cjs').createPaperExecution(inputs)];
  modules.forEach(m=>m.start());
  try {const result=await app.sellPaper(request(trade));assert.equal(result.status,'FILLED');assert.equal(app.tradeStore.snapshot().trades.filter(t=>t.side==='SELL').length,1);}
  finally{modules.forEach(m=>m.stop());}
});
