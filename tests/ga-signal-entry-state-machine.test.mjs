import test from 'node:test';
import assert from 'node:assert/strict';
import { armSetup, transition, significance, entryReceipt, inspectLevels } from '../services/ga-signal/entry-state-machine.mjs';
import { buildStructures, resolveLevels } from '../services/ga-signal/level-engine.mjs';
import { runEngine } from '../services/ga-signal/engine/ga-engine.mjs';
import { createStructureCursor } from '../tools/ga-replay.mjs';
import { createComparison, simulateExit, metrics, SPLIT } from '../tools/ga-compare.mjs';

const anchor=(id,kind,price,extra={})=>({id,kind,price,confirmed_at:100,status:'CONFIRMED',...extra});
const input=(direction='LONG')=>({direction,entry:direction==='LONG'?102:98,atr14:2,tick:.01,
  structures:{symbol:'TEST',timeframe:'5m',signal_time:300,
    swings:[anchor('lo','swing_low',100),anchor('hi','swing_high',104)],
    eqhEql:[anchor('eqh','EQH',108),anchor('eql','EQL',92)]},
  params:{symbol:'TEST',timeframe:'5m',signalTime:300}});
const bar=(low,close,high=Math.max(close,103),time=301)=>({time,open:close,low,close,high,closed:true});
const advance=(state,candle,closed_at=600,extra={})=>transition(state,{candle,closed_at,...extra});

test('ARM requires valid structural reference and SL; no targets can still arm',()=>{
  assert.equal(armSetup({...input(),structures:{}}).reason,'NO_REFERENCE');
  const a=armSetup(input());assert.equal(a.state,'ARMED');assert.ok(a.sl.price<102);
  const x=input();x.structures={swings:[anchor('far','swing_low',110)]};assert.equal(armSetup(x).state,'IDLE');
  const none=input();none.structures.eqhEql=[];assert.equal(armSetup(none).state,'ARMED');
  const invalid=input();invalid.structures={obs:[{id:'bad',side:'BULLISH',bottom:101,top:102,price:105,confirmed_at:100}]};
  assert.equal(armSetup(invalid).reason,'SL_INVALID');
});
test('LONG retest extremum must lie inside zone, inclusive; trend-side close is strict',()=>{
  const s=armSetup(input()); const {bottom,top}=s.reference;
  assert.equal(advance(s,bar(bottom-.01,top+1)).state,'ARMED');
  assert.equal(advance(s,bar(top+.01,top+1)).state,'ARMED');
  assert.equal(advance(s,bar(bottom,top)).state,'RETESTED');
  const confirmed=advance(s,bar(top,top+.1));assert.equal(confirmed.state,'CONFIRMED');
  assert.equal(confirmed.receipt.entry,top+.1);assert.deepEqual(confirmed.sl,s.sl);assert.deepEqual(confirmed.targets,s.targets);
});
test('SHORT mirror and unclosed candles',()=>{
  const s=armSetup(input('SHORT')), {top,bottom}=s.reference;
  assert.equal(advance(s,bar(bottom-1,bottom-.1,top)).state,'CONFIRMED');
  assert.equal(advance(s,bar(bottom-1,bottom-.1,top+.01)).state,'ARMED');
  assert.deepEqual(advance(s,{...bar(bottom-1,bottom-.1,top),closed:false}),s);
});
test('expiry boundary, timely retest, invalidation and SL equality',()=>{
  const s=armSetup(input()); let q=s;
  for(let i=1;i<=23;i++) q=advance(q,bar(102,103),300+i*300);
  assert.equal(q.state,'ARMED');assert.equal(advance(q,bar(102,103),7500).state,'EXPIRED');
  assert.equal(advance(q,bar(s.reference.top,s.reference.top+.1),7500).state,'CONFIRMED');
  assert.equal(advance(s,bar(s.sl.price-1,s.sl.price-.01)).state,'INVALIDATED');
  assert.notEqual(advance(s,bar(s.sl.price-1,s.sl.price)).state,'INVALIDATED');
  let touched=advance(s,bar(s.reference.bottom,s.reference.top));
  for(let i=2;i<=30;i++)touched=advance(touched,bar(102,103),300+i*300);
  assert.equal(touched.state,'RETESTED'); // contract expires only when no retest
  assert.equal(advance(touched,bar(s.sl.price-1,s.sl.price-.01),10000).state,'INVALIDATED');
});
test('dedupe ARMED and RETESTED, terminal rearm, immutable caller input',()=>{
  const data=input(),before=structuredClone(data),s=armSetup(data);
  assert.equal(transition(s,{trigger:input()}).event,'TRIGGER_WHILE_ARMED');
  const r=advance(s,bar(s.reference.bottom,s.reference.top));
  assert.equal(transition(r,{trigger:input()}).event,'TRIGGER_WHILE_ARMED');
  data.structures.swings[0].price=0;assert.equal(s.reference.price,100);
  assert.equal(transition({...s,state:'EXPIRED'},{trigger:before}).state,'ARMED');
  assert.deepEqual(advance(s,bar(100,103),300),s);
});
test('fixed significance hierarchy and ATR threshold boundaries',()=>{
  const classify=x=>significance(x,2,'5m');
  assert.equal(classify({source_type:'swing_high',influence_range:100}),'INTERNAL');
  assert.equal(classify({source_type:'swing_high',structure_event:'bos',influence_range:2.99}),'INTERNAL');
  assert.equal(classify({source_type:'swing_high',structure_event:'bos',influence_range:3}),'SIGNIFICANT');
  assert.equal(classify({source_type:'FVG',top:11,bottom:10}),'SIGNIFICANT');
  assert.equal(classify({source_type:'OB',top:10.99,bottom:10}),'INTERNAL');
  assert.equal(classify({source_type:'EQH'}),'SIGNIFICANT');
  assert.equal(classify({source_type:'premium'}),'SIGNIFICANT');
  assert.equal(classify({source_type:'prev_D_high'}),'EXTERNAL');
  assert.equal(classify({source_type:'swing_high',timeframe:'1h'}),'EXTERNAL');
});
test('nearest significant TP rejects RR_LOW; only labelled shadows relax/skip; obstacle caps display',()=>{
  const s={...armSetup(input()),sl:{price:98},targets:[{price:103.8,level:1},{price:108,level:2}],
    inventory:[{price:103,source_type:'swing_high',significance:'INTERNAL'},{price:103.8,significance:'SIGNIFICANT'},{price:108,significance:'SIGNIFICANT'}]};
  assert.equal(entryReceipt(s,101).reason,'RR_LOW');
  assert.equal(entryReceipt(s,101,'SHADOW-RR08').accepted,true);
  const far=entryReceipt(s,101,'SHADOW-FAR');assert.equal(far.accepted,true);assert.equal(far.targets[0].price,108);
  assert.equal(far.rr_net_of_internal,2/3);assert.equal(far.skipped_nearest.price,103.8);
  assert.deepEqual(far.tp_candidates.map(t=>t.price),[103.8,108]);assert.equal(far.nearby_obstacle.price,103);
  assert.equal(entryReceipt(s,103.7).reason,'NO_TARGET');
  assert.throws(()=>entryReceipt(s,101,'LIVE-RR08'));
});
test('no-lookahead anchors and HTF; structures frozen at ARM',()=>{
  const x=input();x.structures.eqhEql.push(anchor('future','EQH',103,{confirmed_at:301}));
  x.structures.swings.push(anchor('future-bos','swing_high',106,{structure_event:'bos',structure_confirmed_at:301,influence_range:20}));
  const state=armSetup(x);assert.ok(!state.inventory.some(t=>t.id==='future'));
  assert.equal(state.inventory.find(t=>t.id==='future-bos').significance,'INTERNAL');
  x.structures.eqhEql[0].price=999;
  const next=advance(state,bar(state.reference.top,state.reference.top+.1));
  assert.equal(next.targets[0].price,108);
  for(const t of next.targets) assert.ok(t.confirmed_at<=state.armed_at);
});
test('deterministic replay, production baseline diagnostics and causal engine prefixes',()=>{
  const replay=()=>{let s=transition(undefined,{trigger:input()});return [s,advance(s,bar(100,101))];};
  assert.deepEqual(replay(),replay());
  for(const direction of ['LONG','SHORT']) {
    const x=input(direction),a=resolveLevels(x),b=inspectLevels(x);
    assert.equal(a.accepted,b.accepted);assert.equal(a.reason,b.reason);
    if(a.accepted) {assert.deepEqual(a.targets,b.targets);assert.deepEqual(a.sl,b.sl);}
  }
  const candles=Array.from({length:100},(_,i)=>{const close=100+Math.sin(i/3)*4;return {time:i*300,open:close,close,high:close+1,low:close-1};});
  for(const variant of ['A','B','C']) {
    const args={symbol:'TEST',timeframe:'5m',variant,params:{tick:.01,warmupBars:0,emaTrend:10,emaSlow:5,emaFast:3}};
    const all=runEngine({...args,candles}).events;
    for(let i=25;i<candles.length;i++) assert.deepEqual(runEngine({...args,candles:candles.slice(0,i+1)}).events,all.filter(e=>e.time<=candles[i].time));
  }
});
test('incremental structural snapshots match production prefixes',()=>{
  const candles=Array.from({length:80},(_,i)=>{const close=100+Math.sin(i/3)*4;return {time:i*300,open:close,close,high:close+1,low:close-1};});
  const cursor=createStructureCursor({symbol:'TEST',timeframe:'5m'});
  for(let i=0;i<candles.length;i++) {
    cursor.update(candles[i]);const snap=cursor.snapshot((i+1)*300);
    for(const s of snap.swings) for(const k of ['structure_event','structure_confirmed_at','influence_range','structure_price'])delete s[k];
    assert.deepEqual(snap,buildStructures({symbol:'TEST',timeframe:'5m',signalTime:(i+1)*300,candles:candles.slice(0,i+1)}));
  }
  assert.throws(()=>cursor.snapshot(300),/future bar/);
});
test('optimized diagnostic scoring preserves production gates and receipts across varied structures',()=>{
  let seed=4004;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  for(let n=0;n<120;n++) {
    const x=input(n%2?'SHORT':'LONG');x.entry=100;x.atr14=.2+random()*5;
    x.structures.swings=Array.from({length:20},(_,i)=>anchor(`p${i}`,i%2?'swing_high':'swing_low',85+random()*30));
    x.structures.obs=Array.from({length:8},(_,i)=>{const bottom=90+random()*20;return {id:`ob${i}`,side:i%2?'BULLISH':'BEARISH',bottom,top:bottom+random()*4,confirmed_at:i%4?100:400};});
    x.structures.pdBoundary={id:'pd',confirmed_at:100,discountBottom:92,discountTop:95,premiumBottom:105,premiumTop:108};
    x.htfLevels={symbol:'TEST',timeframe:'1h',swings:[anchor('htflo','swing_low',95),anchor('htfhi','swing_high',107)]};
    const original=resolveLevels(x),audit=inspectLevels(x);
    assert.equal(audit.accepted,original.accepted);assert.equal(audit.reason,original.reason);
    if(original.accepted) {
      assert.deepEqual(audit.sl,original.sl);assert.deepEqual(audit.targets,original.targets);assert.deepEqual(audit.rr,original.rr);
      for(const key of ['source_id','score','confluences','top','bottom']) assert.deepEqual(audit.reference[key],original.reference[key]);
    }
  }
});
test('staged simulator, conservative ambiguity, costs and split censoring',()=>{
  const candles=[bar(99,100,101,0),bar(99,102,102,300),bar(98,102,105,600)];
  const receipt={entry:100,sl:{price:98},targets:[{price:102},{price:104},{price:106}]};
  const result=simulateExit(candles,0,'LONG',receipt,'5m');
  assert.equal(result.ambiguous,true);assert.equal(result.gross_r,0);assert.ok(result.net_r<0);
  assert.deepEqual(result.fills.map(f=>f.weight),[.5,.5]);
  const stopped=simulateExit(candles,0,'LONG',receipt,'5m',600);assert.equal(stopped.censored,true);
  assert.equal(stopped.exit_time,600);assert.equal(SPLIT,1788220800);
});
test('metrics use unique setup keys, actual timestamp span and undefined small samples',()=>{
  const receipt={symbol:'TEST',timeframe:'5m',variant:'A',side:'LONG',signal_time:1,entry_time:1,entry:100,sl:{price:98},atr:2,rr:{tp1:2},exit:{net_r:1,mfe_r:2,mae_r:.5,exit_time:2}};
  const m=metrics([], [receipt,{...receipt,variant:'B'}]);assert.equal(m.unique_setups,1);assert.equal(m.signals_per_week,null);assert.equal(m.expectancy_ci95,null);
  const more=metrics([], [receipt,{...receipt,signal_time:604801,entry_time:604801}]);assert.equal(more.signals_per_week,2);
});
test('comparison shares trial slots across variants and groups expiry with its arm cohort',()=>{
  const comparison=createComparison(), args=input();
  const candles=[bar(101,102,103,0),bar(100.1,100.4,103,300),bar(100,108,109,600)];
  const context={symbol:'TEST',timeframe:'5m',index:0,signalTime:300,args,candles,
    volatility:[2,2,2],strength:[{adx:10},{adx:25},{adx:25}],baseline:resolveLevels(args)};
  for(const variant of ['A','B','C']) comparison.onTrigger({...context,trigger:{variant,side:'LONG',time:0,setup:{entry_ref:102}}});
  comparison.onBar({...context,index:1,candle:candles[1],signalTime:600});
  const result=comparison.finish();
  for(const policy of ['TRIAL-004','SHADOW-RR08','SHADOW-FAR']) {
    assert.equal(result.trades.filter(t=>t.policy===policy).length,1);
    assert.equal(result.events.filter(e=>e.policy===policy&&e.status==='TRIGGER_WHILE_ARMED').length,2);
    assert.equal(result.trades.find(t=>t.policy===policy).entry,100.4);
  }
  const expired=createComparison();
  expired.onTrigger({...context,trigger:{variant:'A',side:'LONG',time:0,setup:{entry_ref:102}}});
  for(let i=1;i<=24;i++) expired.onBar({...context,index:1,candle:bar(102,103,104,i*300),signalTime:(i+1)*300});
  assert.ok(expired.finish().events.filter(e=>e.status==='EXPIRED').every(e=>e.regime==='range'));
});
