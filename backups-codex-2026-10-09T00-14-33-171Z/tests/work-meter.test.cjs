const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createWorkMeter,WINDOW_MS}=require('C:/Botmeme/runtime/work-meter.cjs');
test('only active work grows; overlapping tasks count once; idle and refresh do not reset',()=>{
 let clock=100000,mono=0;const m=createWorkMeter({clock:()=>clock,monotonic:()=>mono});
 const first=m.begin('jev','scan');clock+=1000;mono+=1000;const second=m.begin('jev','hunter');clock+=1000;mono+=1000;first('completed');clock+=1000;mono+=1000;second('completed');
 assert.equal(m.snapshot().jev.workMs,3000);clock+=500000;mono+=500000;assert.equal(m.snapshot().jev.workMs,3000);assert.equal(m.snapshot()['codex-2'].workMs,0);
});
test('persistent receipts survive restart; reset only at anchored twelve hours; never fills early',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'botmeme-meter-'));const filename=path.join(dir,'work.jsonl');let clock=1000,mono=0;
 const m=createWorkMeter({filename,clock:()=>clock,monotonic:()=>mono});const end=m.begin('codex-1','decision');clock+=60000;mono+=60000;end('completed');
 const restarted=createWorkMeter({filename,clock:()=>clock,monotonic:()=>mono});assert.equal(restarted.snapshot()['codex-1'].workMs,60000);
 clock=1000+WINDOW_MS-1;assert.equal(restarted.snapshot()['codex-1'].workMs,60000);assert.ok(restarted.snapshot()['codex-1'].progress<100);
 clock++;assert.equal(restarted.snapshot()['codex-1'].workMs,0);assert.equal(restarted.snapshot()['codex-1'].windowStart,clock);
});
test('failed work is measured and marked failed, not a completed business task',()=>{
 let clock=1000,mono=0;const m=createWorkMeter({clock:()=>clock,monotonic:()=>mono});const finish=m.begin('codex-3','critique');clock+=10;mono+=10;finish('failed');finish('completed');assert.equal(m.snapshot()['codex-3'].completed,1);assert.equal(m.snapshot()['codex-3'].failures,1);assert.equal(m.snapshot()['codex-3'].workMs,10);
});

test('each of the four service subscriptions is timed under its own agent',async()=>{
 let clock=1000,mono=0;const handlers=new Map();
 const m=createWorkMeter({clock:()=>clock,monotonic:()=>mono});
 const wrapped=m.wrapRuntime({subscribeDurable(id,type,fn){handlers.set(id,fn);return ()=>{};}});
 for(const [id,agent] of [['jev.hunter.v1','jev'],['commander.v1.TradeResult','codex-1'],['quant.v1.MarketSnapshot','codex-2'],['forensic.v1.TradeResult','codex-3']]){
  wrapped.subscribeDurable(id,'test',()=>{clock+=250;mono+=250;});
  await handlers.get(id)({id:'unit-receipt'}, {signal:new AbortController().signal});
  assert.equal(m.snapshot()[agent].workMs,250);assert.equal(m.snapshot()[agent].completed,1);
 }
});
