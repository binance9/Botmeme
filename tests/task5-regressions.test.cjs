'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { plan } = require('../services/commander/decision.cjs');
const { projectProgress } = require('../dashboard/adapter/progress.cjs');
const { createTradeDetails } = require('../dashboard/adapter/trade-details.cjs');
const view = require('../public/meme-trader/app.js');
const { createRuntime } = require('../runtime/events/bus.cjs');
const { createDashboardAdapter } = require('../dashboard/adapter/index.cjs');
const at = '2026-10-02T10:00:00.000Z', now = () => new Date(at);
const event = (id,type,payload,producer='MARKET_DATA') => ({id,type,payload,producer,timestamp:at,network:'SOLANA',epoch:1,source:'task5-fixture',correlationId:id,evidence:['fixture'],missing_evidence:[],confidence:.9,evidence_quality:.9,uncertainty:.1,status:'OBSERVED'});
const { createHunter } = require('../services/jev/hunter.cjs');
const { createCommander } = require('../services/commander/service.cjs');
const { createTradeStore } = require('../core/trades/store.cjs');
const { createRegimeEngine } = require('../core/market-data/regime.cjs');
function refreshSeed(runtime) {
  const quote = event('seed-quote', 'MarketSnapshot', { token: 'refresh-token', price: 1, liquidityUsd: 12000, volume24hUsd: 100, observedAt: '2026-10-02T09:00:00.000Z', poolAgeMs: 120000, marketCapUsd: 1000 });
  runtime.publish(quote);
  runtime.publish(event('seed-candidate', 'TokenCandidate', { token: quote.payload.token, symbol: 'REFRESH', snapshotId: quote.id, liquidityUsd: 12000, volume24hUsd: 100, rank: 1, anomalies: ['TOKEN_DISCOVERY'] }, 'JEV'));
  return quote;
}
const typed = (runtime, type) => runtime.snapshot().events.filter(e => e.type === type);
test('snapshot refresh emits five signals and commander buys on the fifth qualified sample, then stops for decided token', async t => {
  const runtime = createRuntime({ now });
  const seed = refreshSeed(runtime);
  const hunter = createHunter({ runtime, now });
  const regime = createRegimeEngine({ runtime, now });
  const commander = createCommander({ runtime, now, tradeStore: createTradeStore({ runtime, now }) });
  t.after(async () => { hunter.stop(); regime.stop(); commander.stop(); await runtime.close(); });
  hunter.start(); regime.start(); commander.start();
  for (let i = 1; i <= 5; i++) {
    runtime.publish({ ...seed, id: 'refresh-' + i, payload: { ...seed.payload, observedAt: new Date(Date.parse(at) - (5 - i) * 1000).toISOString(), marketCapUsd: i < 4 ? 1000 : 10000, volume24hUsd: i < 4 ? 100 : 1000 } });
    await runtime.flush();
    assert.equal(typed(runtime, 'SignalObservation').length, i);
    assert.equal(typed(runtime, 'StrategyDecision').length, i === 5 ? 1 : 0);
  }
  assert.equal(typed(runtime, 'StrategyDecision')[0].payload.action, 'BUY');
  assert.equal(typed(runtime, 'TokenCandidate').length, 1);
  const signals = typed(runtime, 'SignalObservation');
  for (const signal of signals) {
    assert.equal(signal.payload.candidateId, 'seed-candidate');
    assert.deepEqual(signal.evidence, [signal.payload.snapshotId]);
    assert.equal(signal.confidence, .9);
  }
  runtime.publish(event('new-candidate', 'TokenCandidate', { ...runtime.get('seed-candidate').payload, snapshotId: 'refresh-5' }, 'JEV'));
  runtime.publish({ ...seed, id: 'after-decision', payload: { ...seed.payload, observedAt: at, volume24hUsd: 1000, marketCapUsd: 10000 } });
  await runtime.flush();
  assert.deepEqual(typed(runtime, 'SignalObservation'), signals);
  assert.deepEqual(runtime.snapshot().deliveryErrors, []);
});
test('refresh IDs survive journal restart and unacknowledged event replay without duplication', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'botmeme-refresh-'));
  const journalPath = path.join(directory, 'events.jsonl');
  let runtime = createRuntime({ now, journalPath }), hunter = createHunter({ runtime, now });
  const replay = createRuntime({ now });
  let replayHunter;
  t.after(async () => {
    hunter.stop(); replayHunter?.stop(); await runtime.close(); await replay.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('botmeme-refresh-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const seed = refreshSeed(runtime);
  hunter.start();
  runtime.publish({ ...seed, id: 'fresh-replay', payload: { ...seed.payload, observedAt: at } });
  await runtime.flush();
  const original = runtime.snapshot().events;
  assert.equal(typed(runtime, 'SignalObservation').length, 1);
  const expected = 'jev.signal/' + require('node:crypto').createHash('sha256').update(JSON.stringify(['SOLANA', 1, 'seed-candidate', 'fresh-replay'])).digest('hex');
  assert.equal(typed(runtime, 'SignalObservation')[0].id, expected);
  hunter.stop(); await runtime.close();
  runtime = createRuntime({ now, journalPath }); hunter = createHunter({ runtime, now });
  hunter.start(); await runtime.flush();
  assert.deepEqual(runtime.snapshot().events, original);
  for (const e of original) replay.publish(e);
  replayHunter = createHunter({ runtime: replay, now }); replayHunter.start(); await replay.flush();
  assert.deepEqual(replay.snapshot().events, original);
  assert.deepEqual(replay.snapshot().deliveryErrors, []);
});
test('refresh rejects stale or weak observations and never borrows candidates across epochs', async t => {
  const runtime = createRuntime({ now }), hunter = createHunter({ runtime, now });
  t.after(async () => { hunter.stop(); await runtime.close(); });
  const seed = refreshSeed(runtime); hunter.start();
  for (const extra of [{}, { confidence: .6 }, { evidence: [] }, { missing_evidence: ['missing'] }, { uncertainty: .5 }]) {
    runtime.publish({ ...seed, id: 'weak-' + runtime.snapshot().events.length, ...extra, payload: { ...seed.payload, observedAt: Object.keys(extra).length ? at : seed.payload.observedAt } });
  }
  await runtime.flush();
  assert.equal(typed(runtime, 'SignalObservation').length, 0);
  runtime.selectNetwork('BSC');
  runtime.publish({ ...seed, id: 'other-epoch', network: 'BSC', epoch: 2, payload: { ...seed.payload, liquidityUsd: 0, observedAt: at } });
  await runtime.flush();
  assert.equal(typed(runtime, 'SignalObservation').length, 0);
  assert.deepEqual(runtime.snapshot().deliveryErrors, []);
});
function entry(cap, age, extra={}) {
  const data=event('quote','MarketSnapshot',{token:'T',price:1,observedAt:at,liquidityUsd:15000,marketCapUsd:cap,poolAgeMs:age,realVolumeUsd:1500,recentVolumeUsd:1500});
  const candidate=event('candidate','TokenCandidate',{token:'T',anomalies:['TOKEN_DISCOVERY','REAL_VOLUME'],...extra},'JEV');
  const signal=event('signal','SignalObservation',{snapshotId:data.id});
  const regime=event('regime','MarketRegimeState',{snapshotIds:[data.id],regime:'TRENDING'});
  const world={history:[data],local:[data],regimes:[regime],strategies:[],critiques:[],network:'SOLANA',candidates:[candidate],portfolio:{positions:[],trades:[],performance:{equity:10000,maxDrawdown:0,capitalUsed:0}}};
  return plan(world,candidate,signal,now());
}
for (const [name,cap,age,action] of [['fresh $10k',10000,180000,'BUY'],['fresh $1k',1000,180000,'NO_ACTION'],['old $20k',20000,45*86400000,'BUY'],['old $25k',25000,45*86400000,'NO_ACTION'],['old $15k',15000,45*86400000,'BUY'],['old $5k',5000,45*86400000,'NO_ACTION'],['60 minute pool',10000,3600000,'BUY'],['2h pool',10000,7200000,'BUY'],['above band ceiling',30001,180000,'NO_ACTION'],['above hard ceiling',10000001,180000,'NO_ACTION'],['unknown age',10000,undefined,'NO_ACTION'],['invalid negative age',10000,-1,'NO_ACTION']]) {
  test('shared band: '+name,()=>{const result=entry(cap,age);assert.equal(result.action,action);if(action==='NO_ACTION')assert.equal(result.disposition,'WAIT');});
}
test('onchain discovery requires age, REAL_VOLUME still required for one-sample fast track',()=>{
  assert.equal(entry(10000,undefined,{discoverySource:'onchain-ws'}).action,'NO_ACTION');
  assert.equal(entry(10000,1000,{anomalies:['TOKEN_DISCOVERY']}).action,'NO_ACTION');
});
test('scan SSE projections advance and complete even with tiny work-meter fraction',async t=>{
  const runtime=createRuntime({now});
  const workMeter={snapshot:()=>Object.fromEntries(['jev','codex-1','codex-2','codex-3'].map(id=>[id,{progress:.000001,running:0}]))};
  const adapter=createDashboardAdapter({runtime,now,workMeter});t.after(async()=>{adapter.close();await runtime.close();});
  const updates=[];adapter.subscribe(s=>updates.push(s.agents[0]));
  for(const [n,state] of [[1,'RUNNING'],[2,'COMPLETED']]) {runtime.publish(event('scan-'+n,'ScanProgress',{runId:'scan:1',state,total:2,completed:n,failed:0,skipped:0}));await runtime.flush();}
  assert.deepEqual(updates.map(a=>a.progress),[50,null]);assert.equal(updates[1].status,'completed');
  assert.deepEqual(updates.map(a=>a.metric),[{done:1,total:null,label:'Token đã quét'},{done:2,total:null,label:'Token đã quét'}]);
});
test('commander deduplicates safety/strategy and excludes prior-hour signals; quant uses real per-token samples; forensic counts reports',()=>{
  const agents=Array.from({length:4},()=>({progress:null}));
  const events=[event('s','SignalObservation',{candidateId:'c'}),event('s2','SignalObservation',{candidateId:'c2'}),event('safe','SafetyDecision',{candidateId:'c'}),event('d','StrategyDecision',{candidateId:'c'},'CODEX_1')];
  for(let i=0;i<20;i++)events.push(event('q'+i,'MarketSnapshot',{token:'T'}));
  events.push(event('other','MarketSnapshot',{token:'OTHER'}));
  events.push(event('learn','AIActivityEvent',{task:'q19'},'CODEX_2'));
  events.push(event('r','RootCauseReport',{failureId:'f'},'CODEX_3'));
  projectProgress(agents,events,{trades:[{state:'CLOSED'}]},now());
  assert.equal(agents[1].progress,null);assert.equal(agents[2].progress,null);assert.equal(agents[3].progress,null);
  assert.deepEqual(agents.slice(1).map(a=>a.metric),[{done:1,total:null,label:'Signal đã xét giờ qua'},{done:20,total:null,label:'Mẫu giá đã phân tích'},{done:1,total:null,label:'Vụ đã điều tra'}]);
  assert.equal(agents[2].closedTrades,1);assert.equal(agents[3].reportsProcessed,1);
});
test('history matches exact decision and position cycle, preserves birth despite later missing age, renders all fields',()=>{
  const buy={id:'buy',network:'SOLANA',token:'T',cycleId:'cycle1',side:'BUY',timestamp:'2026-10-02T09:00:00Z',positionState:'CLOSED'};
  const sell={...buy,id:'sell',side:'SELL',timestamp:at,decisionId:'exit',exitPrice:2,quantity:5,realizedPnl:5,allocatedCostBasis:5};
  const events=[event('quote','MarketSnapshot',{token:'T',poolAgeMs:7200000,observedAt:at}),event('later','MarketSnapshot',{token:'T',observedAt:at}),event('exit','StrategyDecision',{reason:'RECOVER_ORIGINAL: x2'},'EXIT_MANAGER'),event('wrong','StrategyDecision',{reason:'STOP_LOSS'},'EXIT_MANAGER')];
  const detail=createTradeDetails(events,[buy,sell],[],now())(sell);
  assert.equal(detail.tokenCreatedAt,'2026-10-02T08:00:00.000Z');assert.equal(detail.closeReason,'RECOVER_ORIGINAL: x2');assert.equal(detail.holdingMs,3600000);
  const html=view.detailCells({...detail,entryPriceUsd:1,exitPriceUsd:2,pnlUsd:5,pnlPct:100,status:'closed'});
  for(const text of ['16:00:00 02/10','17:00:00 02/10','$1','$2','+$5.00 / 100.00%','RECOVER_ORIGINAL: x2','1h 0m 0s'])assert.ok(html.includes(text),text);
  assert.equal(view.dateTime(detail.tokenCreatedAt),'15:00:00 02/10');assert.equal(view.dateTime('invalid'),'—');
  assert.ok(!view.detailCells({closeReason:'<script>'}).includes('<script>'));
});
test('history never truncates, sorts latest first and retains partial exits from open positions',()=>{
  const rows=Array.from({length:151},(_,i)=>({id:i,side:'SELL',status:'closed',updatedAt:new Date(Date.parse(at)+i*1000).toISOString()}));
  rows.push({id:'partial',side:'REDUCE',status:'open',updatedAt:'2026-10-02T11:00:00Z'});
  const history=view.historyRows(rows);assert.equal(history.length,152);assert.equal(history[0].id,'partial');assert.equal(history[1].id,150);
});
test('real manual exit projects entry/exit dates, pool creation, exact reason and realized PnL through adapter',async t=>{
  const {createApplication}=require('../runtime/application.cjs');
  const {seedPosition}=require('./helpers/manual-paper-fixture.cjs');
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-exit-projection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app=createApplication({now,capitalUsd:10000,providers:{},liveConfig:{root,env:{}}});t.after(()=>app.close());
  const buy=await seedPosition({...app,now});
  await app.sellPaper({tradeId:buy.id,side:'SELL',percent:100,execute:true});
  const adapter=createDashboardAdapter({...app,now});t.after(()=>adapter.close());
  const rows=adapter.snapshot().trades;const sold=rows.find(t=>t.side==='SELL');
  assert.equal(sold.enteredAt,at);assert.equal(sold.exitedAt,at);assert.equal(sold.tokenCreatedAt,'2026-10-02T09:57:00.000Z');
  const decision=app.runtime.get(sold.decisionId);assert.equal(sold.closeReason,decision.payload.reason);assert.equal(sold.closeReasonCode,'MANUAL');assert.ok(sold.pnlUsd>0);assert.ok(rows.find(t=>t.side==='BUY').pnlUsd>0);
});
test('actual card renderer consumes SSE state, shows running progress, idle age and stopped dimming',()=>{
  const fs=require('node:fs'),vm=require('node:vm');
  const source=fs.readFileSync(require.resolve('../public/meme-trader/app.js'),'utf8');
  function node(){const children=new Map();return {style:{},dataset:{},attrs:{},classList:{toggle(){}},setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k];},querySelector(k){if(!children.has(k))children.set(k,node());return children.get(k);}};}
  const cards=Array.from({length:4},node);
  const ids=['jev','codex-1','codex-2','codex-3'];
  const snapshot={agents:ids.map(id=>({id,status:'running',progress:50,updatedAt:at,metric:{label:'processed',done:1,total:2}})),control:{running:true},trades:[]};
  snapshot.agents[0].work={workMs:1250,completed:3,failures:1};
  const context={document:{querySelectorAll:()=>cards},snapshot,connected:true,ids,roles:ids,headlines:ids,descriptions:ids,activityLine:()=>'',networkLabel:()=>'',time:()=>'',esc:String};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  function renderAgents()'),source.indexOf('  const pendingExits')),context);
  vm.runInContext('renderAgents()',context);assert.equal(cards[0].querySelector('.agent-percent').textContent,'50.0%');assert.equal(cards[0].querySelector('.progress-track').querySelector('i').style.width,'50%');
  for(const card of cards)assert.match(card.querySelector('.agent-detail').innerHTML,/^processed: <b>1<\/b>/);
  assert.match(cards[0].querySelector('.agent-detail').innerHTML,/Đã xử lý: <b>1\.3 giây<\/b><br>Receipt: 3 · Lỗi: 1/);
  assert.ok(!cards[0].querySelector('.agent-detail').innerHTML.includes(' / '));
  snapshot.agents[0].status='waiting';vm.runInContext('renderAgents()',context);assert.match(cards[0].querySelector('.agent-percent').textContent,/s trước/);assert.equal(cards[0].querySelector('.progress-track').attrs['aria-valuenow'],undefined);
  snapshot.control.running=false;vm.runInContext('renderAgents()',context);assert.equal(cards[0].dataset.status,'STOPPED');assert.equal(cards[0].querySelector('.progress-track').querySelector('i').style.opacity,'.25');
});
