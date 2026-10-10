import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Scanner } from '../services/ga-signal/scanner/scanner.mjs';
import { LabJournal } from '../services/ga-signal/lib/journal.mjs';
process.env.NODE_ENV = 'test';
const bar = (i,o,h,l,c) => ({time:1700000000+i*300,open:o,high:h,low:l,close:c});
function candles() {
 const a=Array.from({length:45},(_,i)=>bar(i,100,100.5,99.5,100));
 for(const [i,h] of [[5,110],[12,114],[19,118]]) a[i].high=h;
 a[30].low=99;
 return [...a,bar(45,100,102.2,99.9,102),bar(46,101.6,101.9,100.5,101.4),bar(47,101.8,120.2,101.7,119.5)];
}
function fixture(t,rows) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ga-regression-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const journal=new LabJournal({dir}); const alerts=[];
 const f={rows,now:(rows.at(-1).time+300)*1000+2000,fetches:0};
 f.scanner=new Scanner({config:{symbols:['BTCUSDT'],timeframes:['5m'],variants:['C'],scanner:{minHistory:10,warmupBars:0}},journal,outbox:{enqueue:e=>alerts.push(e)},now:()=>f.now,fetchWindow:async()=>{f.fetches++;return {candles:f.rows,gaps:[]}},cycleLog:null});
 return Object.assign(f,{journal,alerts});
}
test('boot replay has explicit simulated/historical evidence and sends no alert even on last candle',async t=>{
 const f=fixture(t,candles());await f.scanner.pollAll();
 const e=f.journal.events.filter(e=>e.type!=='META');assert.equal(e.length,4);assert.equal(f.alerts.length,0);
 for(const x of e){assert.equal(x.execution_mode,'simulation');assert.equal(x.observation_mode,'historical_replay');assert.equal(x.level_source,'smc_structure');assert.equal(x.candle_close_time,x.candle_time+300);assert.equal(x.observed_at,f.now)}
});
test('one fetch per closed candle and current simulated setup/hits alert once',async t=>{
 const all=candles();const f=fixture(t,all.slice(0,46));await f.scanner.pollAll();
 f.now+=100000;await f.scanner.pollAll();assert.equal(f.fetches,1);
 f.rows=all.slice(0,47);f.now=(f.rows.at(-1).time+300)*1000+2000;await f.scanner.pollAll();
 assert.equal(f.alerts.length,1);assert.equal(f.journal.events.find(e=>e.type==='SETUP_CREATED').observation_mode,'closed_candle_observation');
 f.rows=all;f.now=(all.at(-1).time+300)*1000+2000;await f.scanner.pollAll();assert.equal(f.alerts.length,4);
 await f.scanner.pollAll();assert.equal(f.alerts.length,4);assert.equal(f.fetches,3);
});
test('delayed catch-up is labeled historical and cannot send stale alerts',async t=>{
 const all=candles();const f=fixture(t,all.slice(0,46));await f.scanner.pollAll();f.rows=all;f.now=(all.at(-1).time+300)*1000+120000;await f.scanner.pollAll();assert.equal(f.alerts.length,0);assert.ok(f.journal.events.filter(e=>e.type!=='META').every(e=>e.observation_mode==='historical_replay'));
});
test('failed journal persistence leaves memory unchanged and permits durable retry',t=>{
 const f=fixture(t,candles());const orig=fs.appendFileSync;const event={type:'META',event_id:'retry',symbol:'TEST',timeframe:'5m'};
 try{fs.appendFileSync=()=>{throw new Error('ENOSPC injected')};assert.throws(()=>f.journal.append(event),/ENOSPC/)}finally{fs.appendFileSync=orig}
 assert.equal(f.journal.seq,0);assert.equal(f.journal.events.length,0);assert.equal(f.journal.append(event).added,true);assert.equal(new LabJournal({dir:f.journal.dir}).events.length,1);
});

test('journal restart preserves sequence, history and identity dedupe',t=>{
 const f=fixture(t,candles());const e={type:'META',event_id:'persist',symbol:'TEST',timeframe:'5m'};
 f.journal.append(e);const j=new LabJournal({dir:f.journal.dir});
 assert.equal(j.seq,1);assert.equal(j.events.length,1);assert.equal(j.append(e).added,false);
 assert.equal(j.append({...e,event_id:'next'}).event.seq,2);
 assert.equal(new LabJournal({dir:j.dir}).events.length,2);
});
test('malformed complete and interior journal records fail closed preserving exact bytes',t=>{
 const f=fixture(t,candles());const valid=JSON.stringify({type:'META',event_id:'valid',symbol:'TEST',timeframe:'5m',seq:1})+'\n';
 for(const raw of ['{broken}\n',valid+'{broken}\n'+valid,valid+'null\n']) {
  fs.writeFileSync(f.journal.file,raw);
  assert.throws(()=>new LabJournal({dir:f.journal.dir}),error=>error.code==='JOURNAL_CORRUPT_RECORD');
  assert.equal(fs.readFileSync(f.journal.file,'utf8'),raw);
 }
});
test('torn tail leaves prefix readable but blocks append and preserves raw evidence',t=>{
 const f=fixture(t,candles());const e={type:'META',event_id:'persist',symbol:'TEST',timeframe:'5m'};
 f.journal.append(e);fs.appendFileSync(f.journal.file,'{"type":"META","cut');const raw=fs.readFileSync(f.journal.file);
 const j=new LabJournal({dir:f.journal.dir});assert.equal(j.events.length,1);assert.equal(j.loadError.code,'JOURNAL_TORN_TAIL');
 assert.throws(()=>j.append({...e,event_id:'next'}),error=>error.code==='JOURNAL_TORN_TAIL');
 assert.deepEqual(fs.readFileSync(f.journal.file),raw);
});
test('partially persisted failed append cannot concatenate a retry without restart',t=>{
 const f=fixture(t,candles());const e={type:'META',event_id:'partial',symbol:'TEST',timeframe:'5m'};const orig=fs.appendFileSync;
 try{fs.appendFileSync=(file,data)=>{orig(file,data.slice(0,12));throw new Error('ENOSPC partial')};assert.throws(()=>f.journal.append(e),/ENOSPC/)}finally{fs.appendFileSync=orig}
 const raw=fs.readFileSync(f.journal.file);assert.equal(f.journal.seq,0);
 assert.throws(()=>f.journal.append(e),error=>error.code==='JOURNAL_TORN_TAIL');assert.deepEqual(fs.readFileSync(f.journal.file),raw);
});

test('service exposes torn journal as blocked and keeps prefix readable without scanner or outbox timers',async t=>{
 const {startGaSignalService}=await import('../services/ga-signal/service.mjs');
 const f=fixture(t,candles());
 f.journal.append({type:'SETUP_CREATED',event_id:'saved',setup_id:'saved',symbol:'BTCUSDT',timeframe:'5m',candle_time:1700000000,details:{reference:{},sl:{price:90},targets:[{price:110}]}});
 fs.appendFileSync(f.journal.file,'{"broken":');const raw=fs.readFileSync(f.journal.file);
 let intervalStarts=0,fetches=0;
 t.mock.method(globalThis,'setInterval',()=>{intervalStarts++;return {unref(){}}});
 const service=await startGaSignalService({dataDir:f.journal.dir,autostart:true,fetchWindow:async()=>{fetches++;throw Error('must not fetch')}});
 t.after(()=>service.stop());
 const response=()=>({body:'',status:0,writeHead(status){this.status=status},end(body){this.body=body}});
 const state=response();await service.handle({method:'GET'},state,new URL('http://local/api/ga-signal/state'));
 const body=JSON.parse(state.body);
 assert.equal(intervalStarts,0);assert.equal(fetches,0);assert.equal(body.scanner.running,false);
 assert.equal(body.status,'BLOCKED_JOURNAL_INTEGRITY');assert.equal(body.journal.appendable,false);assert.equal(body.journal.loadError.code,'JOURNAL_TORN_TAIL');
 assert.equal(body.telegram.status,'BLOCKED_JOURNAL_INTEGRITY');
 const events=response();await service.handle({method:'GET'},events,new URL('http://local/api/ga-signal/events'));
 assert.equal(JSON.parse(events.body).events[0].setup_id,'saved');
 const send=response();await service.handle({method:'POST'},send,new URL('http://local/api/ga-signal/telegram/test'));
 assert.equal(send.status,503);assert.equal(JSON.parse(send.body).error,'JOURNAL_TORN_TAIL');
 assert.deepEqual(fs.readFileSync(f.journal.file),raw);
});
