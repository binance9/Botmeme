'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createCopyPaper}=require('../services/copy-paper/service.cjs'),{decode}=require('../services/copy-paper/solana.cjs'),{tx,wallet}=require('./copy-paper-fixtures.cjs');
const {createWatcher}=require('../services/copy-paper/watcher.cjs');
const at=Date.now();
function setup(opts={}){const ledger=createCopyPaper({now:()=>at,isRunning:()=>true,...opts});ledger.add({name:'fixture',wallet,chain:'SOLANA'});ledger.configure({budgetUsd:100,buyUsd:10});return ledger;}
const fill=(l,t,o)=>l.process(t.transaction.signatures[0],t,o);
test('BUY -> duplicate -> 40% SELL -> full SELL, durable positions and dedupe after restart',()=>{
 const filename=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'copy-test-')),'ledger.json');let l=setup({filename});const buy=tx({now:at+1000});assert.equal(fill(l,buy).rows[0].copyQuantity,10);assert.equal(fill(l,buy).duplicate,true);
 l.close();l=createCopyPaper({filename,isRunning:()=>true,now:()=>at});assert.equal(fill(l,buy).duplicate,true);const partial=fill(l,tx({side:'SELL',before:100,quantity:40,slot:2,now:at+1000})).rows[0];assert.equal(partial.copyQuantity,4);assert.equal(partial.sellFraction,.4);
 assert.equal(fill(l,tx({side:'SELL',before:60,quantity:60,slot:3,now:at+1000})).rows[0].copyQuantity,6);const s=l.snapshot();assert.equal(Object.values(s.positions)[0].raw,'0');assert.equal(s.cashUsd,100);assert.equal(s.history.length,3);l.close();
});
test('transfer, LP/bridge wrappers, failed tx, mismatched authority, multi-token all refuse copies',()=>{
 for(const mutate of [t=>t.transaction.message.instructions=[],t=>t.transaction.message.instructions.push({programId:'BridgeOrLP'}),t=>t.meta.err={failed:true},t=>t.transaction.message.instructions[0].accounts[1]='other',t=>t.meta.postTokenBalances.push({...t.meta.postTokenBalances[0],mint:'OtherToken'}),t=>t.transaction.message.instructions.push({programId:'11111111111111111111111111111111',parsed:{type:'transfer'}})]){const t=tx();mutate(t);assert.equal(decode(t,wallet).swap,undefined);}
});
test('STOP, replay, old/same slot, stale and zero budget never fill',()=>{
 let l=setup({isRunning:()=>false});assert.equal(fill(l,tx({now:at+1000})).rows[0].reason,'PAPER_STOPPED');l.close();
 l=setup();assert.equal(fill(l,tx({now:at+1000}),{replay:true}).rows[0].status,'WATCH_ONLY');assert.equal(fill(l,tx({now:at+1000,sig:'3'.repeat(88)})).rows[0].status,'WATCH_ONLY');l.close();
 l=setup();assert.equal(fill(l,tx({now:at-180000})).rows[0].status,'WATCH_ONLY');l.close();
 l=setup();l.configure({budgetUsd:0,buyUsd:0});assert.equal(fill(l,tx({now:at+1000})).rows[0].status,'WATCH_ONLY');l.close();
});
test('signature binding and unknown chain rejected',()=>{const l=setup();assert.throws(()=>l.process('9'.repeat(88),tx()),/SIGNATURE/);assert.throws(()=>l.add({name:'x',wallet,chain:'BSC'}),/CHUA_XAC_MINH/);l.close();});
test('WebSocket notification -> RPC decode -> dedupe -> persisted paper, no polling',async()=>{
 const l=setup();let ws,reads=0;const t=tx({now:at+1000});
 class FakeWS extends EventTarget{constructor(){super();ws=this;this.readyState=1;this.sent=[];}send(s){this.sent.push(JSON.parse(s));}close(){this.readyState=3;}emit(type,data){this.dispatchEvent(type==='message'?new MessageEvent(type,{data:JSON.stringify(data)}):new Event(type));}}
 const w=createWatcher({ledger:l,rpcUrl:'https://fixture.invalid',wsUrl:'wss://fixture.invalid',WebSocketImpl:FakeWS,fetchImpl:async()=>{reads++;return {ok:true,json:async()=>({result:t})};}});
 ws.emit('open');assert.equal(ws.sent[0].method,'logsSubscribe');assert.deepEqual(ws.sent[0].params[0],{mentions:[wallet]});assert.equal(reads,0);ws.emit('message',{id:ws.sent[0].id,result:10});
 const event={method:'logsNotification',params:{subscription:10,result:{value:{signature:t.transaction.signatures[0],err:null}}}};ws.emit('message',event);ws.emit('message',event);await w.idle();assert.equal(reads,1);assert.equal(l.snapshot().history[0].status,'PAPER_FILLED');assert.equal(l.snapshot().history.length,1);w.close();l.close();
});
test('missing RPC/WS is explicitly unverified',()=>{const l=setup(),w=createWatcher({ledger:l,rpcUrl:'',wsUrl:''});assert.match(l.snapshot().traders[0].realtime,/CHƯA XÁC MINH/);w.close();l.close();});
