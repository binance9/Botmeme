'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOverview } = require('../dashboard/adapter/overview.cjs');
const stamp = (day, hour = 0, month = 9) => new Date(2026, month, day, hour).toISOString();
const fill = (id, timestamp, realizedPnl, extra = {}) => ({ id, timestamp, type:'TradeResult', network:'SOLANA', payload:{ mode:'paper', state: realizedPnl == null ? 'OPEN' : 'CLOSED', realizedPnl:realizedPnl ?? 0, ...extra } });
const line = e => JSON.stringify({value:{kind:'event',event:e}})+'\n';
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'overview-')), filename=path.join(dir,'runtime.jsonl');
  fs.writeFileSync(filename,'');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const listeners=new Set(), runtime={snapshot:()=>({events:[]}),subscribe:(_,fn)=>{listeners.add(fn);return()=>listeners.delete(fn);}};
  const make=()=>{const value=createOverview({runtime,journalPath:filename});t.after(()=>value.close());return value;};
  return {filename,make,emit:e=>listeners.forEach(fn=>fn(e))};
}
test('local day/month windows replay journal and archives identically after restart',async t=>{
  const {filename,make}=fixture(t);
  const events=[fill('previous-month',stamp(30,23,8),100),fill('yesterday',stamp(1,12),-4),fill('midnight',stamp(2),5),fill('buy',stamp(2,1),null),fill('breakeven',stamp(2,2),0),fill('future',stamp(3),999),fill('live',stamp(2,2),99,{mode:'live'})];
  fs.writeFileSync(filename+'.old.archive',events.slice(0,2).map(line).join(''));
  fs.writeFileSync(filename,events.slice(2).map(line).join(''));
  const first=make();await first.refresh(true);
  const now=new Date(stamp(2,12)), result=first.snapshot('SOLANA',now);
  assert.equal(result.status,'ready');
  assert.equal(result.today.totalTrades,3);assert.equal(result.today.realizedPnlUsd,5);assert.equal(result.today.winRate,50);
  assert.equal(result.month.totalTrades,4);assert.equal(result.month.realizedPnlUsd,1);assert.equal(result.month.winRate,100/3);
  assert.equal(result.today.start,stamp(2));assert.equal(result.month.start,stamp(1));
  first.close();const second=make();await second.refresh(true);assert.deepEqual(second.snapshot('SOLANA',now),result);
  assert.equal(second.snapshot('BSC',now).today.winRate,null);
  assert.equal(second.snapshot('SOLANA',new Date(2026,10,1)).month.totalTrades,0);
  const live = second.snapshot('SOLANA', now, 'live');
  assert.equal(live.today.totalTrades, 1); assert.equal(live.today.realizedPnlUsd, 99); assert.equal(live.today.winRate, 100);
  assert.equal(live.month.totalTrades, 1);
});
test('incremental append, duplicate replay, partial lines, delayed fills and network isolation',async t=>{
  const {filename,make,emit}=fixture(t), index=make(), now=new Date(stamp(2,12));await index.refresh(true);
  const buy=fill('buy',stamp(2),null);emit(buy);fs.appendFileSync(filename,line(buy));await index.refresh(true);
  assert.equal(index.snapshot('SOLANA',now).today.totalTrades,1);assert.equal(index.snapshot('SOLANA',now).today.winRate,null);
  const sell=fill('sell',stamp(2,2),8), encoded=line(sell);
  fs.appendFileSync(filename,encoded.slice(0,30));await index.refresh(true);assert.equal(index.snapshot('SOLANA',now).today.totalTrades,1);
  fs.appendFileSync(filename,encoded.slice(30));await index.refresh(true);emit(sell);
  emit(fill('late',stamp(1),-2));emit({...fill('bsc',stamp(2),900),network:'BSC'});
  const result=index.snapshot('SOLANA',now);assert.equal(result.today.totalTrades,2);assert.equal(result.today.realizedPnlUsd,8);assert.equal(result.month.realizedPnlUsd,6);
  fs.renameSync(filename,filename+'.rotated.archive');fs.writeFileSync(filename,line(fill('after-rotation',stamp(2,3),-1)));
  await index.refresh(true);assert.equal(index.snapshot('SOLANA',now).today.totalTrades,3);
  fs.appendFileSync(filename,'bad-json\n');await index.refresh(true);assert.equal(index.snapshot('SOLANA',now).status,'error');assert.equal(index.snapshot('SOLANA',now).today.totalTrades,null);
});

test('adapter restores the same overview after a real runtime journal restart',async t=>{
  const {createApplication}=require('../runtime/application.cjs');
  const {createDashboardAdapter}=require('../dashboard/adapter/index.cjs');
  const {seedPosition}=require('./helpers/manual-paper-fixture.cjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'overview-runtime-'));
  const filename=path.join(dir,'runtime.jsonl'), now=()=>new Date(stamp(2,12));
  let app=createApplication({journalPath:filename,now,capitalUsd:10000,providers:{},liveConfig:{root:dir,env:{}}});
  const trade=await seedPosition({...app,now});
  await app.sellPaper({tradeId:trade.id,side:'SELL',percent:100,execute:true});
  let adapter=createDashboardAdapter({...app,now});
  async function loaded() {for(let i=0;i<100;i++){const s=adapter.snapshot();if(s.overview.status==='ready')return s;await new Promise(r=>setTimeout(r,5));}throw Error('overview loading timeout');}
  const before=await loaded();assert.equal(before.summary.totalTrades,2);assert.equal(before.summary.winRate,100);assert.ok(before.summary.realizedPnlUsd>0);
  adapter.close();await app.close();
  app=createApplication({journalPath:filename,now,capitalUsd:10000,providers:{},liveConfig:{root:dir,env:{}}});
  adapter=createDashboardAdapter({...app,now});
  t.after(async()=>{adapter.close();await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const after=await loaded();assert.deepEqual(after.overview,before.overview);assert.deepEqual(after.summary,before.summary);
});
