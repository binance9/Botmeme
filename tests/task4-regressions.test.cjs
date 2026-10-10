'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createRuntime } = require('../runtime/events/bus.cjs');
const { createCommander } = require('../services/commander/service.cjs');
const { validateEvent } = require('../runtime/contracts/index.cjs');
const { noSecrets } = require('../runtime/contracts/schema.cjs');
const at = '2026-10-02T10:00:00.000Z', now = () => new Date(at);
function event(id, type, producer, payload) {
 return {id,type,producer,payload,timestamp:at,source:'task4-fixture',evidence:['fixture'],status:'OBSERVED',correlationId:'task4',network:'SOLANA',epoch:1,confidence:.9,evidence_quality:.9,uncertainty:.1,missing_evidence:[]};
}
function seed(runtime, n, {buy=false, regime=true}={}) {
 const snapshot=event('snapshot-'+n,'MarketSnapshot','MARKET_DATA',{token:'token-'+n,price:1,liquidityUsd:12000,volume24hUsd:24000,observedAt:at,...(buy?{poolAgeMs:120000,marketCapUsd:15000,realVolumeUsd:1000}:{})});
 const candidate=event('candidate-'+n,'TokenCandidate','JEV',{token:snapshot.payload.token,symbol:'T',snapshotId:snapshot.id,liquidityUsd:12000,volume24hUsd:24000,rank:1,anomalies:buy?['TOKEN_DISCOVERY','REAL_VOLUME']:[]});
 const signal=event('signal-'+n,'SignalObservation','JEV',{candidateId:candidate.id,snapshotId:snapshot.id,signals:[{name:'price_change_fraction',value:.1}]});
 runtime.publish(snapshot);runtime.publish(candidate);
 if(regime)runtime.publish(event('regime-'+n,'MarketRegimeState','MARKET_DATA',{regime:'TRENDING',snapshotIds:[snapshot.id],reason:'fixture'}));
 runtime.publish(signal);return {snapshot,candidate,signal};
}
function harness(runtime) {
 const handlers=new Map();let plans=0;
 const commander=createCommander({runtime:{...runtime,subscribeDurable:(_id,type,fn)=>{handlers.set(type,fn);return()=>{};}},now,tradeStore:{snapshot(){plans++;return {positions:[],trades:[],performance:{equity:10000,maxDrawdown:0,capitalUsed:0}};}}});
 commander.start();return {commander,get plans(){return plans;},handle:e=>handlers.get(e.type)(e,{signal:new AbortController().signal})};
}
function source(runtime,id,snapshots) {const e=event(id,'MarketRegimeState','MARKET_DATA',{regime:'TRENDING',snapshotIds:snapshots,reason:'fixture'});runtime.publish(e);return e;}
test('flood: each source handles only one batch, unchanged sources publish nothing; checkpoint survives restart',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'task4-'));const journalPath=path.join(dir,'events.jsonl');
 let runtime=createRuntime({journalPath,now,maxPending:1000});
 t.after(async()=>{await runtime.close();assert.equal(path.dirname(dir),os.tmpdir());assert.ok(path.basename(dir).startsWith('task4-'));fs.rmSync(dir,{recursive:true,force:true});});
 const snapshots=[];for(let i=0;i<45;i++)snapshots.push(seed(runtime,i).snapshot.id);await runtime.flush();
 let h=harness(runtime);const first=source(runtime,'source-1',snapshots);h.handle(first);h.handle(first);
 assert.equal(h.plans,1,'portfolio replay once for one bounded batch');
 let activity=runtime.snapshot().events.filter(e=>e.type==='AIActivityEvent');assert.equal(activity.length,1);assert.match(activity[0].payload.message,/Compared 20 candidates; journaled 0/);
 h.handle(source(runtime,'source-2',snapshots));h.handle(source(runtime,'source-3',snapshots));h.handle(source(runtime,'source-4',snapshots));
 activity=runtime.snapshot().events.filter(e=>e.type==='AIActivityEvent');assert.equal(activity.length,3);assert.match(activity.at(-1).payload.message,/Compared 5 candidates/);assert.equal(h.plans,3);
 h.commander.stop();await runtime.close();runtime=createRuntime({journalPath,now});h=harness(runtime);h.handle(source(runtime,'after-restart',snapshots));assert.equal(h.plans,0);assert.equal(runtime.snapshot().events.filter(e=>e.type==='AIActivityEvent').length,3);
});
test('new signal/snapshot on an existing token can buy once again; unrelated source cannot duplicate a decision',async t=>{
 const runtime=createRuntime({now});t.after(()=>runtime.close());const h=harness(runtime);
 const first=seed(runtime,1,{buy:true});h.handle(first.signal);h.handle(source(runtime,'next-source',[first.snapshot.id]));
 assert.equal(runtime.snapshot().events.filter(e=>e.type==='StrategyDecision').length,1);
 const second=seed(runtime,2,{buy:true});h.handle(second.signal);
 const snapshot={...first.snapshot,id:'rescan-snapshot'};runtime.publish(snapshot);
 const candidate={...first.candidate,id:'rescan-candidate',payload:{...first.candidate.payload,snapshotId:snapshot.id}};runtime.publish(candidate);
 const signal={...first.signal,id:'rescan-signal',payload:{...first.signal.payload,candidateId:candidate.id,snapshotId:snapshot.id}};
 source(runtime,'rescan-regime',[snapshot.id]);runtime.publish(signal);h.handle(signal);
 const decisions=runtime.snapshot().events.filter(e=>e.type==='StrategyDecision');assert.equal(decisions.length,3);assert.ok(decisions.every(e=>e.payload.action==='BUY'));
});
test('pending regime is reconsidered once when real regime evidence arrives',async t=>{
 const runtime=createRuntime({now});t.after(()=>runtime.close());const h=harness(runtime);const {signal,snapshot}=seed(runtime,1);
 // A separate token has no regime until the follow-up source.
 const missing=seed(runtime,2,{regime:false});h.handle(missing.signal);
 h.handle(source(runtime,'arrived',[missing.snapshot.id,snapshot.id]));
 const count=runtime.snapshot().events.filter(e=>e.type==='AIActivityEvent').length;
 h.handle(source(runtime,'unchanged',[missing.snapshot.id]));assert.equal(runtime.snapshot().events.filter(e=>e.type==='AIActivityEvent').length,count);
 assert.ok(runtime.hasCheckpoint);assert.ok(signal);
});
test('invalid publish stops exception retries, logs producer/code once per minute, never persists or delivers invalid input',async t=>{
 const logs=[], runtime=createRuntime({now,logger:line=>logs.push(JSON.parse(line))});t.after(()=>runtime.close());
 let deliveries=0;runtime.subscribe('*',()=>deliveries++);
 const bad=event('bad','AIActivityEvent','CODEX_1',{agent:'CODEX_1',task:'x',state:'WRONG',progress:null,message:'fixture'});
 let attempts=0,result;
 for(;attempts<100;attempts++){try{result=runtime.publish(structuredClone(bad));break;}catch(e){assert.equal(e.retryable,false);}}
 assert.equal(attempts,1);assert.equal(result.rejected,true);assert.equal(logs.length,1);assert.equal(logs[0].producer,'CODEX_1');assert.equal(logs[0].code,'INVALID_EVENT_ENUM');
 for(let i=0;i<100;i++)assert.equal(runtime.publish(bad).rejected,true);
 for(let i=0;i<100;i++)assert.equal(runtime.publish({...bad,id:'retry-'+i}).rejected,true);
 assert.equal(logs.length,1);await runtime.flush();assert.equal(deliveries,0);assert.equal(runtime.get('bad'),null);
 const realNow=Date.now;try{Date.now=()=>realNow()+61000;runtime.publish(bad);}finally{Date.now=realNow;}assert.equal(logs.length,2);
 const fixed={...bad,payload:{...bad.payload,state:'COMPLETED'}};assert.equal(runtime.publish(fixed).duplicate,false);await runtime.flush();assert.equal(deliveries,1);
});
test('actionable flow waits for a real regime instead of publishing an invalid placeholder trace',async t=>{
 const runtime=createRuntime({now});t.after(()=>runtime.close());const h=harness(runtime), {signal,snapshot}=seed(runtime,9,{buy:true,regime:false});
 assert.doesNotThrow(()=>h.handle(signal));assert.equal(runtime.snapshot().events.filter(e=>e.type==='StrategyDecision').length,0);
 assert.doesNotThrow(()=>h.handle(source(runtime,'real-regime',[snapshot.id])));
 const decisions=runtime.snapshot().events.filter(e=>e.type==='StrategyDecision');assert.equal(decisions.length,1);assert.equal(decisions[0].payload.regimeId,'real-regime');
});
test('noSecrets avoids JSON.parse for ordinary strings and large nested JSON, still rejects escaped secrets',()=>{
 const original=JSON.parse;let calls=0;JSON.parse=(...args)=>{calls++;return original(...args);};
 try{noSecrets('ordinary-id-not-json');noSecrets('x'.repeat(5000));assert.throws(()=>noSecrets(JSON.stringify({text:'x'.repeat(5000)})),/INVALID_EVENT_EMBEDDED_JSON_SIZE/);assert.equal(calls,0);assert.throws(()=>noSecrets('{"private\\u005fkey":"hidden"}'),/INVALID_EVENT_SECRET/);}finally{JSON.parse=original;}
 const cyclic={};cyclic.self=cyclic;assert.throws(()=>noSecrets(cyclic),/INVALID_EVENT_CYCLE/);
});
test('immutable validation cache preserves clock and nested mutation checks',()=>{
 const e=event('cache','MarketSnapshot','MARKET_DATA',{token:'t',price:1,liquidityUsd:1,volume24hUsd:1,observedAt:at});
 Object.freeze(e);validateEvent(e,{now});e.payload.price=-1;assert.throws(()=>validateEvent(e,{now}),/INVALID_EVENT/);e.payload.price=1;
 Object.freeze(e.payload);Object.freeze(e.evidence);Object.freeze(e.missing_evidence);validateEvent(e,{now});validateEvent(e,{now});
 assert.throws(()=>validateEvent(e,{now:()=>new Date(Date.parse(at)-120000)}),/INVALID_EVENT_FUTURE_TIMESTAMP/);
});
