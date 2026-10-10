'use strict';
const test=require('node:test'), { after }=require('node:test'), assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {createApplication}=require('C:/Botmeme/runtime/application.cjs');
// Isolated live root: keep the operator's real wallet-key.env / live-state.json
// out of these control assertions (hasKey, mode and reconciliation replays).
const roots=[];
after(()=>{for(const root of roots)fs.rmSync(root,{recursive:true,force:true});});
const isolatedRoot=()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'botmeme-chartctl-'));roots.push(root);return {root};};
const source=fs.readFileSync('C:/Botmeme/public/meme-trader/app.js','utf8');
const start=source.indexOf('  function weekStart('),end=source.indexOf('  function chartStyles()',start);
const build=vm.runInNewContext(source.slice(start,end)+';buildCandles');
test('tick-shaped fixtures normalize into finite millisecond OHLC without filling missing seconds',()=>{
 const points=[{at:1790519607000,priceUsd:122.02},{at:1790519614000,priceUsd:122.01},{at:1790519619455,priceUsd:122.03}];
 const rows=build({points},1000);
 assert.equal(rows.length,3);assert.equal(rows.at(-1).timestamp,1790519619000);
 for(let i=0;i<rows.length;i++)for(const key of ['open','high','low','close'])assert.equal(rows[i][key],points[i].priceUsd);
 assert.equal(build({points:[]},1000).length,0);
});
test('control metadata matches snapshot without copying or exposing event history',async()=>{
 const {createRuntime}=require('C:/Botmeme/runtime/events/bus.cjs');const runtime=createRuntime();
 try{runtime.selectNetwork('BSC');const light=runtime.status(),full=runtime.snapshot();for(const k of ['network','epoch','revision','pending'])assert.equal(light[k],full[k]);assert.equal('events' in light,false);light.network='SOLANA';assert.equal(runtime.status().network,'BSC');}finally{await runtime.close();}
});
test('one-second aggregation preserves high low open close; higher frames retain provider candles',()=>{
 const rows=build({points:[{at:1001,priceUsd:4},{at:1200,priceUsd:6},{at:1900,priceUsd:3}]},1000);
 assert.equal(rows[0].open,4);assert.equal(rows[0].high,6);assert.equal(rows[0].low,3);assert.equal(rows[0].close,3);
 const candle={at:60000,open:1,high:7,low:1,close:2,volumeUsd:10};assert.equal(build({candles:[candle],points:[]},60000)[0].high,7);
});
test('STOP aborts acquisition; repeated START and restart keep a single scan loop',async()=>{
 let calls=0,active=0,max=0;
 const provider={network:'SOLANA',discover({signal}){calls++;active++;max=Math.max(max,active);return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{active--;reject(Error('aborted'));},{once:true}));},snapshot(){throw Error('unexpected');}};
 const app=createApplication({capitalUsd:0,providers:{SOLANA:provider},scanIntervalMs:1000,liveConfig:isolatedRoot()});
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 try{
  await app.connect({network:'SOLANA',chainId:'mainnet-beta',address:'So11111111111111111111111111111111111111112',provider:'protocol-test'});
  await Promise.all([app.start(),app.start(),app.start()]);await sleep(30);assert.equal(calls,1);
  await app.stop();assert.equal(active,0);await sleep(1100);assert.equal(calls,1);
  await app.start();await sleep(30);assert.equal(calls,2);assert.equal(max,1);
  await app.stop();await sleep(1100);assert.equal(calls,2);
 }finally{await app.close();}
});
test('a pending balance request cannot block START or STOP and is not duplicated',async()=>{
 // Seed a completed connection valuation. Rejecting it as "offline" now enters
 // the existing retry loop, so the old fixture stalled inside connect(), before
 // it ever reached the START/STOP behavior that this test is meant to exercise.
 let calls=0,rejectRead;const app=createApplication({liveConfig:isolatedRoot(),providers:{SOLANA:{network:'SOLANA',async discover(){return [];},snapshot(){throw Error('unexpected');}}},valuationReader:{read(session){
  calls++;
  if(calls===1){const at=new Date().toISOString();return Promise.resolve({id:'funding/initial',timestamp:at,source:'test',evidence:['balance','price'],payload:{amount:'1',symbol:'SOL',balanceAt:at,priceAt:at,priceUsd:100,valueUsd:100,accountHash:require('node:crypto').createHash('sha256').update(session.network+':'+session.address).digest('hex')}});}
  return new Promise((_,reject)=>{rejectRead=reject;});
 }}});
 try {
  await app.connect({network:'SOLANA',chainId:'mainnet-beta',address:'So11111111111111111111111111111111111111112',provider:'protocol-test'});
  const at=Date.now();await app.start();await app.stop();await app.start();await app.stop();
  assert.ok(Date.now()-at<500);assert.equal(calls,2);assert.equal(app.control().running,false);
 }finally{rejectRead?.(Error('WALLET_SESSION_CHANGED'));await app.close();}
});
test('late prior-timeframe history cannot overwrite the currently selected chart',async()=>{
 const pending=[];const context=vm.createContext({fetch:()=>new Promise(resolve=>pending.push(resolve))});
 const a=source.indexOf('  const REFERENCE_QUERY ='),b=source.indexOf('  function weekStart(',a);
 const api=vm.runInContext('let interval=60000, chartKey=null;function renderChart(){}\n'+source.slice(a,b)+';({mergeReferenceHistory,change:n=>interval=n,history:()=>refHistory.candles})',context);
 const market={priceSource:'REFERENCE_FEED'};api.mergeReferenceHistory(market,[]);api.change(1000);api.mergeReferenceHistory(market,[]);
 pending[1]({ok:true,json:async()=>({candles:[{at:1000,open:2,high:2,low:2,close:2,volume:0}]})});
 await new Promise(r=>setImmediate(r));
 pending[0]({ok:true,json:async()=>({candles:[{at:60000,open:1,high:1,low:1,close:1,volume:0}]})});
 await new Promise(r=>setImmediate(r));assert.equal(api.history()[0].timestamp,1000);
});
test('legacy SSE retains heartbeat without requiring a production refresh API',async()=>{
 const {createDashboardServer}=require('C:/Botmeme/scripts/serve-meme-trader.cjs');
 const service=createDashboardServer({journalPath:null});let reader;
 try{await new Promise(r=>service.server.listen(0,'127.0.0.1',r));const response=await fetch('http://127.0.0.1:'+service.server.address().port+'/api/events',{signal:AbortSignal.timeout(19000)});reader=response.body.getReader();await reader.read();const tick=await reader.read();assert.equal(tick.done,false);assert.match(new TextDecoder().decode(tick.value),/event: state/);}finally{await reader?.cancel();await service.close();}
});
