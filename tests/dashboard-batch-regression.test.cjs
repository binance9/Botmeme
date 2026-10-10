'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createRuntime}=require('../runtime/events/bus.cjs');
const {createDashboardAdapter}=require('../dashboard/adapter/index.cjs');
const {createHeldFeed}=require('../dashboard/held-feed.cjs');
test('batch quotes preserve serial final projection with one subscriber rebuild',async()=>{
 const at=Date.UTC(2026,9,9),now=()=>new Date(at);
 const a=createRuntime({now}),b=createRuntime({now});
 const serial=createDashboardAdapter({runtime:a,now}),batch=createDashboardAdapter({runtime:b,now});
 try{
  let singles=0,batches=0;serial.subscribe(()=>singles++);batch.subscribe(()=>batches++);
  const points=Array.from({length:100},(_,i)=>({network:'SOLANA',token:'test-token',priceUsd:1+i/100,at:at-100000+i*1000}));
  points.forEach(p=>serial.quote(p));batch.quotes(points);
  assert.equal(singles,100);assert.equal(batches,1);assert.deepEqual(batch.snapshot(),serial.snapshot());
  batch.quotes([]);assert.equal(batches,1);
  batch.quote(points[0]);assert.equal(batches,2);
 }finally{serial.close();batch.close();await a.close();await b.close();}
});
test('held feed submits sorted trade prints in one batch, with legacy fallback',async()=>{
 for(const batch of [true,false]){
  let calls=0,received=[];const at=Date.UTC(2026,9,9);
  const store={snapshot:()=>({markets:{x:{tokenId:'token',network:'SOLANA',poolAddress:'pool',discovery:true}},activeToken:'x'}),quote:p=>{calls++;received.push(p);}};
  if(batch)store.quotes=points=>{calls++;received.push(...points);};
  const feed=createHeldFeed({store,now:()=>at,intervalMs:2147483647,fetchImpl:async()=>({ok:true,status:200,json:async()=>({data:[0,2,1].map(i=>({attributes:{from_token_address:'token',to_token_address:'other',block_timestamp:new Date(at-i*1000).toISOString(),price_from_in_usd:String(1+i)}}))})})});
  try{await feed.poll();assert.equal(calls,batch?1:3);assert.deepEqual(received.map(x=>x.at),[at-2000,at-1000,at]);assert.equal(feed.status().count,3);}finally{feed.close();}
 }
});
