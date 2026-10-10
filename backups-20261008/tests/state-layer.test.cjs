'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../state/store.cjs');
const { runScan } = require('../state/scanner.cjs');
const { createDashboardServer } = require('../scripts/serve-meme-trader.cjs');
const at = '2026-09-24T05:00:00.000Z';
const now = () => new Date('2026-09-24T06:00:00Z');
let serial = 0;
const event = (type, source, data, extra = {}) => ({ id: `test-${++serial}`, type, source, occurredAt: at, data, ...extra });
const tick = (price, extra = {}) => event('market.tick', 'market', { tokenId: 'token-a', symbol: 'TEST', priceUsd: price, volumeUsd: 10 }, extra);
const fill = (side, quantity, priceUsd, feeUsd = 0, positionId = 'position-a') => event('trade.filled', 'paper-ledger', { fillId: `fill-${serial+1}`, positionId, mode: 'paper', tokenId: 'token-a', symbol: 'TEST', side, quantity, priceUsd, feeUsd });
const tempJournal = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'botmeme-state-')), 'events.jsonl');

test('paper capital persists deposits/withdrawals, rejects invalid values and serializes overdraws', async t => {
  const { createApplication } = require('../runtime/application.cjs');
  const journalPath = tempJournal();
  const options = { liveConfig: { root: path.dirname(journalPath), env: {} }, journalPath, now, capitalUsd: 100, providers: {} };
  const app = createApplication(options);
  try {
    const deposit = await app.depositPaper(50, 'Nạp thử');
    assert.equal(deposit.paperCapitalUsd, 150); assert.equal(deposit.entries.length, 1);
    assert.equal(deposit.entries[0].type, 'deposit'); assert.equal(deposit.entries[0].resultingCapitalUsd, 150);
    assert.equal(app.tradeStore.snapshot().performance.cash, 150);
    assert.equal(app.tradeStore.snapshot().performance.equity, 150);
    assert.equal(app.tradeStore.snapshot().performance.budgetUsd, 150);
    for (const value of [0, -1, NaN, Infinity, '5', null]) for (const method of ['depositPaper','withdrawPaper']) await assert.rejects(app[method](value), { status: 400 });
    await assert.rejects(app.depositPaper(1, {}), { status: 400 });
    await assert.rejects(app.withdrawPaper(151), { status: 400 });
    const results = await Promise.allSettled([app.withdrawPaper(100), app.withdrawPaper(100)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(app.paperCapital().paperCapitalUsd, 50);
    assert.equal(app.paperCapital().entries.length, 2);
  } finally { await app.close(); }
  const restored = createApplication(options); t.after(() => restored.close());
  assert.equal(restored.paperCapital().paperCapitalUsd, 50);
  assert.equal(restored.paperCapital().entries[0].type, 'withdraw');
  assert.equal(restored.tradeStore.snapshot().performance.realizedPnl, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(journalPath), 'capital-ledger.json'), 'utf8')).length, 2);
  await restored.withdrawPaper(50); assert.equal(restored.paperCapital().paperCapitalUsd, 0);
  await restored.selectNetwork('BSC'); assert.equal(restored.paperCapital().entries.length, 0);
  assert.equal(restored.paperCapital().paperCapitalUsd, 100);
});

test('capital ledger HTTP endpoints expose Settings projection and return 400 on invalid requests', async t => {
  const application = require('../runtime/application.cjs').createApplication({ liveConfig: { root: path.dirname(tempJournal()), env: {} }, now, capitalUsd: 100, providers: {} });
  const service = createDashboardServer({ application, now, copyPath: null, copyWatch: false });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve)); t.after(() => service.close());
  const url = 'http://127.0.0.1:' + service.server.address().port;
  const post = body => fetch(url + '/api/capital/ledger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ action: 'deposit', amountUsd: 25, note: 'test' })).status, 200);
  assert.equal((await post({ action: 'withdraw', amountUsd: 5 })).status, 200);
  for (const body of [{ action: 'withdraw', amountUsd: 121 }, { action: 'deposit', amountUsd: '5' }, { action: 'other', amountUsd: 1 }, null]) assert.equal((await post(body)).status, 400);
  const ledger = await (await fetch(url + '/api/capital/ledger')).json();
  assert.equal(ledger.paperCapitalUsd, 120); assert.deepEqual(ledger.entries.map(e => e.type), ['withdraw','deposit']);
  const state = await (await fetch(url + '/api/state')).json();
  assert.equal(state.settings.paperCapitalUsd, 120); assert.deepEqual(state.settings.capitalLedger, ledger.entries);
  assert.equal(state.summary.paperCapitalUsd, 120); assert.equal(state.summary.cashUsd, 120);
  const html = await (await fetch(url + '/')).text();
  assert.doesNotMatch(html, /id="settings"|id="capital-history"|data-capital-action/);
  for (const file of ['index.html', 'app.js', 'styles.css']) {
    const source = fs.readFileSync(path.join(__dirname, '../public/meme-trader', file), 'utf8');
    // The SOL shortfall notice is informational; funding controls stay absent.
    assert.doesNotMatch(source.replaceAll('(thiếu SOL: nạp thêm)', ''), /capital-history|data-capital-action|capital-form|capital-ledger|\/api\/capital\/ledger/i, file);
  }
});

test('live withdraw exposes balance hints and quick buttons within the native submit form', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/meme-trader/index.html'), 'utf8');
  const form = html.match(/<form id="trading-withdraw-form"[^>]*>[\s\S]*?<\/form>/)[0];
  assert.match(form, /id="trading-amount"[^>]*step="0.000000001"/);
  assert.match(form, /aria-describedby="trading-available trading-error"/);
  for (const [id, label] of [['all', 'TOÀN BỘ'], ['half', '50%'], ['quarter', '25%']]) {
    assert.ok(form.includes(`id="trading-${id}" type="button">${label}</button>`));
  }
  assert.match(form, /id="trading-submit" type="submit"/);
  assert.match(form, /id="trading-destination"/);
});

test('empty state has no invented prices, trades, activity, progress or budget', () => {
  const s=createStore({now}).snapshot();
  assert.equal(s.version,0);assert.deepEqual(s.markets,{});assert.deepEqual(s.trades,[]);assert.deepEqual(s.activities,[]);
  assert.equal(s.summary.budgetUsd,null);assert.equal(s.summary.winRate,null);
  assert.ok(s.agents.every(a=>a.status==='waiting'&&a.progress===null));
  assert.equal(s.agents[3].role,'Forensic Analyst');
});
test('JEV shows a plain completed count and running sweep progress; duplicates cannot advance it', () => {
  const store=createStore({now});
  store.publish(event('scan.started','scanner',{runId:'scan-a',total:4}));
  const first=event('scan.item','scanner',{runId:'scan-a',itemId:'item-a',tokenId:'token-a',symbol:'TEST',candidate:true});
  store.publish(first);assert.equal(store.snapshot().agents[0].progress,25);
  assert.deepEqual(store.snapshot().agents[0].metric,{done:1,total:null,label:'Token đã quét'});
  assert.equal(store.snapshot().agents[0].total,null);
  assert.equal(store.publish(first).duplicate,true);assert.equal(store.snapshot().agents[0].progress,25);
  assert.throws(()=>store.publish({...first,id:'duplicate-item'}),/already counted/);
  assert.throws(()=>store.publish(event('scan.finished','scanner',{runId:'scan-a'})),/incomplete/);
  assert.throws(()=>store.publish(event('ai.work','jev',{taskId:'x',task:'bad',status:'running',completed:4,total:4})),/cannot publish/);
  assert.equal(store.snapshot().scan.candidates,1);
});
test('scan errors count processed work and completion reports error instead of fake success', () => {
  const store=createStore({now});store.publish(event('scan.started','scanner',{runId:'scan',total:1}));
  store.publish(event('scan.item','scanner',{runId:'scan',itemId:'a',error:'Source unavailable'}));
  store.publish(event('scan.finished','scanner',{runId:'scan'}));
  const s=store.snapshot();assert.equal(s.agents[0].progress,null);assert.equal(s.agents[0].status,'error');assert.equal(s.scan.found,0);
  assert.deepEqual(s.agents[0].metric,{done:1,total:null,label:'Token đã quét'});
  assert.throws(()=>store.publish(event('scan.started','scanner',{runId:'scan',total:1})),/must be new/);
});
test('scanner adapter waits for actual work completion and logs a real file-read failure', async () => {
  const store=createStore();let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const running=runScan({runId:'adapter-run',items:[{id:'first'},{id:'missing'}],publish:e=>store.publish(e),scanOne:async item=>{
    if(item.id==='first'){await gate;return null;}
    await fs.promises.readFile(path.join(os.tmpdir(),'botmeme-not-created-file'));return null;
  }});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(store.snapshot().scan.completed,0);
  release();await running;
  assert.equal(store.snapshot().scan.completed,2);assert.equal(store.snapshot().scan.failed,1);assert.equal(store.snapshot().agents[0].status,'error');
});
test('AI shows completed work without quota progress and Forensic Analyst cannot become execution', () => {
  const store=createStore({now});store.publish(event('ai.work','codex-3',{taskId:'audit',task:'Investigate fills',status:'running',completed:2,total:8}));
  assert.equal(store.snapshot().agents[3].progress,null);assert.equal(store.snapshot().agents[3].completed,2);assert.equal(store.snapshot().agents[3].total,null);assert.equal(store.snapshot().agents[3].role,'Forensic Analyst');
  assert.throws(()=>store.publish(event('ai.work','codex-3',{taskId:'audit',task:'bad',status:'running',completed:1,total:8})),/regress/);
  assert.throws(()=>store.publish(event('ai.work','codex-3',{taskId:'audit',task:'bad',status:'done',completed:3,total:8})),/counts/);
});
test('Activity retains producer identity; quotes do not invent an AI action', () => {
  const store=createStore({now});store.publish(tick(10));assert.equal(store.snapshot().activities.length,0);
  store.publish(event('activity.logged','codex-3',{message:'Found an accounting discrepancy'}));
  const activity=store.snapshot().activities[0];assert.equal(activity.agentId,'codex-3');assert.equal(activity.message,'Found an accounting discrepancy');
});
test('BUY, market marks, partial SELL and full SELL reconcile fees across every projection', () => {
  // Contract: buy 10*10 + 1 = cost 101. Sell 4*12 - .5 = 47.5;
  // allocated cost 40.4 => realized 7.1, remaining cost 60.6. Sell 6*9-.5=53.5 => -7.1.
  const store=createStore({now});store.publish(event('portfolio.configured','operator',{budgetUsd:1000}));
  store.publish(tick(10));store.publish(fill('BUY',10,10,1));
  let s=store.snapshot();assert.equal(s.summary.capitalUsedUsd,101);assert.equal(s.summary.totalTrades,1);assert.equal(s.trades[0].pnlUsd,-1);
  store.publish(tick(12));assert.equal(store.snapshot().trades[0].pnlUsd,19);
  store.publish(fill('SELL',4,12,.5));s=store.snapshot();
  assert.equal(s.summary.realizedPnlUsd,7.1);assert.equal(s.summary.capitalUsedUsd,60.6);assert.equal(s.trades[0].quantity,6);assert.equal(s.trades[0].pnlUsd,18.5);
  store.publish(fill('SELL',6,9,.5));s=store.snapshot();
  assert.equal(s.summary.realizedPnlUsd,0);assert.equal(s.summary.capitalUsedUsd,0);assert.equal(s.summary.openPositions,0);assert.equal(s.summary.totalTrades,3);
  assert.equal(s.summary.winRate,0);assert.equal(s.trades[0].status,'closed');assert.equal(s.trades[0].pnlUsd,0);assert.equal(s.activeToken,'token-a');
  assert.equal(s.activities[0].source,'paper-ledger');assert.equal(s.activities[0].agentId,null);
});
test('multiple BUY fills use weighted cost and do not create phantom fractional positions', () => {
  const store=createStore({now});store.publish(fill('BUY',.1,10));store.publish(fill('BUY',.2,20));
  assert.equal(store.snapshot().trades[0].quantity,.3);assert.equal(store.snapshot().summary.capitalUsedUsd,5);
  store.publish(fill('SELL',.3,20));assert.equal(store.snapshot().summary.realizedPnlUsd,1);assert.equal(store.snapshot().summary.winRate,100);assert.equal(store.snapshot().summary.openPositions,0);
});
test('no price means unknown unrealized PnL; a fill never fabricates chart candles', () => {
  const store=createStore({now});store.publish(fill('BUY',1,10));const s=store.snapshot();
  assert.equal(s.trades[0].pnlUsd,null);assert.equal(s.markets['token-a'].priceUsd,null);assert.deepEqual(s.markets['token-a'].candles,[]);
});
test('idempotency prevents duplicate fills across different event IDs; collisions reject atomically', () => {
  const store=createStore({now}),buy=fill('BUY',1,10);store.publish(buy);const before=store.snapshot();
  assert.equal(store.publish(buy).duplicate,true);
  assert.throws(()=>store.publish({...buy,id:'another-envelope'}),/fillId already/);
  assert.throws(()=>store.publish({...buy,data:{...buy.data,quantity:2}}),/reused/);
  assert.deepEqual(store.snapshot(),before);
});
test('oversell, conflicting token, late fill, execution source and real money are rejected', () => {
  const store=createStore({now});store.publish(fill('BUY',1,10));const before=store.snapshot();
  assert.throws(()=>store.publish(fill('SELL',2,12)),/exceeds/);
  const bad=fill('SELL',1,12);assert.throws(()=>store.publish({...bad,source:'codex-3'}),/cannot publish/);
  assert.throws(()=>store.publish({...bad,data:{...bad.data,mode:'live'}}),/disabled/);
  assert.throws(()=>store.publish({...bad,data:{...bad.data,tokenId:'different'}}),/conflicts/);
  assert.throws(()=>store.publish({...bad,occurredAt:'2026-09-24T04:59:00Z'}),/Out-of-order/);
  assert.deepEqual(store.snapshot(),before);
});
test('market candles use event time, aggregate OHLCV and reject late prices', () => {
  const store=createStore({now});store.publish(tick(10));store.publish(tick(12));store.publish(tick(9));
  const market=store.snapshot().markets['token-a'];assert.deepEqual(market.candles,[{at:Date.parse(at),open:10,high:12,low:9,close:9,volumeUsd:30}]);
  assert.throws(()=>store.publish(tick(99,{occurredAt:'2026-09-24T04:59:00Z'})),/Out-of-order/);
  assert.equal(store.snapshot().markets['token-a'].priceUsd,9);
});
test('today metrics roll over in Vietnam timezone while positions remain open', () => {
  let clock=new Date('2026-09-24T16:59:00Z');const store=createStore({now:()=>clock});
  store.publish(fill('BUY',1,10));assert.equal(store.snapshot().summary.totalTrades,1);
  clock=new Date('2026-09-24T17:00:00Z');assert.equal(store.snapshot().summary.totalTrades,0);assert.equal(store.snapshot().summary.openPositions,1);assert.equal(store.snapshot().summary.capitalUsedUsd,10);
});
test('journal replay restores state and duplicate protection after restart', () => {
  const journalPath=tempJournal(),store=createStore({journalPath,now}),buy=fill('BUY',2,10,1);
  store.publish(tick(12));store.publish(buy);const before=store.snapshot();store.close();
  const reopened=createStore({journalPath,now});assert.deepEqual(reopened.snapshot(),before);assert.equal(reopened.publish(buy).duplicate,true);reopened.close();
});
test('corrupt/truncated journal fails loudly without changing or deleting it', () => {
  const journalPath=tempJournal();fs.writeFileSync(journalPath,'{"incomplete":');
  assert.throws(()=>createStore({journalPath,now}),/Incomplete event journal/);assert.equal(fs.readFileSync(journalPath,'utf8'),'{"incomplete":');
});
test('unknown fields, NaN, future timestamps and prototype identities cannot mutate state', () => {
  const store=createStore({now});
  assert.throws(()=>store.publish({...tick(10),data:{tokenId:'__proto__',symbol:'x',priceUsd:10,volumeUsd:0}}),/tokenId/);
  assert.throws(()=>store.publish(tick(NaN)),/priceUsd/);
  assert.throws(()=>store.publish({...tick(10),extra:true}),/Unexpected/);
  assert.throws(()=>store.publish(tick(10,{occurredAt:'2030-01-01T00:00:00Z'})),/future/);
  assert.throws(()=>store.publish(tick(10,{occurredAt:'2026-02-30T00:00:00Z'})),/calendar/);
  assert.throws(()=>store.publish(tick(1e100)),/priceUsd/);
  assert.equal(store.snapshot().version,0);assert.deepEqual({}.candles,undefined);
});
test('subscriber receives one atomic complete snapshot; caller cannot mutate stored state', () => {
  const store=createStore({now}),seen=[];store.subscribe(s=>seen.push(s));store.publish(fill('BUY',1,10));
  assert.equal(seen.length,1);assert.equal(seen[0].version,1);assert.equal(seen[0].summary.totalTrades,1);assert.equal(seen[0].activities.length,1);assert.equal(seen[0].trades.length,1);
  seen[0].summary.totalTrades=999;assert.equal(store.snapshot().summary.totalTrades,1);
});

test('real HTTP/SSE transport, duplicate replay, isolation and durable server restart', async () => {
  const journalPath=tempJournal();let service=createDashboardServer({journalPath,now});
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  let origin=`http://127.0.0.1:${service.server.address().port}`;
  const abort=new AbortController();let reader;
  try {
    const response=await fetch(origin+'/api/events',{signal:abort.signal});assert.equal(response.headers.get('content-type'),'text/event-stream');
    reader=response.body.getReader();let buffer='';const decoder=new TextDecoder();
    const nextState=async()=>{while(true){const end=buffer.indexOf('\n\n');if(end>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=block.split('\n').find(line=>line.startsWith('data: '));if(data)return JSON.parse(data.slice(6));}else{const part=await reader.read();if(part.done)throw new Error('Stream closed');buffer+=decoder.decode(part.value);}}};
    assert.equal((await nextState()).version,0);
    const buy=fill('BUY',2,10,1),post=body=>fetch(origin+'/api/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal((await post(buy)).status,201);const pushed=await nextState();assert.equal(pushed.summary.capitalUsedUsd,21);assert.equal(pushed.trades.length,1);
    assert.equal((await post(buy)).status,200);assert.equal((await(await fetch(origin+'/api/state')).json()).summary.totalTrades,1);
    const retries=await Promise.all([post(buy),post(buy),post(buy)]);assert.ok(retries.every(r=>r.status===200));
    assert.equal((await(await fetch(origin+'/api/state')).json()).version,1);
    assert.equal((await fetch(origin+'/api/events',{method:'POST',headers:{'content-type':'application/json',origin:'https://untrusted.example'},body:JSON.stringify(tick(99))})).status,403);
    assert.equal((await fetch(origin+'/data/events.jsonl')).status,404);
    assert.equal((await fetch(origin+'/api/orders',{method:'POST'})).status,404);
    assert.equal((await fetch(origin+'/api/events',{method:'POST',headers:{'content-type':'application/json'},body:'x'.repeat(65537)})).status,413);
    await reader.cancel();abort.abort();await service.close();
    service=createDashboardServer({journalPath,now});await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${service.server.address().port}`;
    const restored=await(await fetch(origin+'/api/state')).json();assert.equal(restored.version,1);assert.equal(restored.summary.capitalUsedUsd,21);
  } finally {abort.abort();await service.close();}
});
