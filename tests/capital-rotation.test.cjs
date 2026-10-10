'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { openJournal } = require('../runtime/telemetry/journal.cjs');
const { createTradeStore } = require('../core/trades/store.cjs');
const { createDashboardAdapter } = require('../dashboard/adapter/index.cjs');
const at = '2026-09-24T10:00:00.000Z', now = () => new Date(at);
function fill(id, side, price) {
  return { id, type:'TradeResult', timestamp:at, producer:'PAPER_EXECUTION', source:'rotation-test', evidence:['test'], status:'COMPLETED', correlationId:id, network:'SOLANA', epoch:1, confidence:1, evidence_quality:1, missing_evidence:[], uncertainty:0,
    payload:{mode:'paper',intentId:'intent-'+id,token:'token',candidateId:'candidate',snapshotId:'snapshot',signalIds:['signal'],strategyVersion:'v1',decisionId:'decision',riskDecisionId:'risk',side,quantity:1,entryPrice:10,exitPrice:side==='BUY'?null:price,realizedPnl:side==='BUY'?0:price-10,fees:0,slippageBps:0,state:side==='BUY'?'OPEN':'CLOSED'} };
}
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'capital-rotation-')), filename=path.join(dir,'runtime.jsonl');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return {dir,filename};
}
function store(journal) {
  const events=journal.records.filter(r=>r.kind==='event').map(r=>r.event);
  const runtime={solAnchor:()=>journal.solAnchor(),solReference:(price,at)=>journal.solReference(price,at),capitalEvents:()=>journal.capitalEvents,capitalHistoryGroups:()=>journal.capitalHistoryGroups,snapshot:()=>({events,network:'SOLANA',epoch:1,revision:events.length}),status:()=>({network:'SOLANA'}),subscribe:()=>()=>{}};
  return { runtime, tradeStore:createTradeStore({runtime,capitalUsd:24,now}), events };
}
test('capital $24 + $7 survives real startup rotation, restart and subsequent sell exactly once', t=>{
  const {dir,filename}=fixture(t);
  let j=openJournal(filename,24);
  j.append({kind:'event',event:fill('b1','BUY',10)});j.append({kind:'event',event:fill('s1','SELL',17)});
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'capital-anchor.json'))).networks.SOLANA.paperCapitalUsd,31);
  // Large non-accounting record exercises the production 20 MiB rotation path.
  j.append({kind:'padding',text:'x'.repeat(21*1024*1024)});j.close();
  j=openJournal(filename,24);
  assert.equal(j.records.length,0);assert.equal(fs.readdirSync(dir).filter(n=>n.endsWith('.archive')).length,1);
  assert.equal(store(j).tradeStore.snapshot().performance.paperCapitalUsd,31);
  assert.throws(()=>openJournal(filename,24),/EEXIST/);
  j.append({kind:'event',event:fill('b2','BUY',10)});j.append({kind:'event',event:fill('s2','SELL',12)});j.close();
  j=openJournal(filename,24);assert.equal(store(j).tradeStore.snapshot().performance.paperCapitalUsd,33);
  assert.equal(store(j).tradeStore.snapshot().trades.length,4);j.close();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'capital-anchor.json'))).networks.SOLANA.realizedPnlUsd,9);
});
test('legacy archives hydrate dashboard history and capital; repeated boots do not duplicate fills', async t=>{
  const {dir,filename}=fixture(t);
  let j=openJournal(filename,24);j.append({kind:'event',event:fill('b','BUY',10)});j.append({kind:'event',event:fill('s','SELL',17)});j.close();
  fs.renameSync(filename,filename+'.old.archive');fs.unlinkSync(path.join(dir,'capital-anchor.json'));
  const archive = fs.readFileSync(filename+'.old.archive');
  for(let boot=0;boot<2;boot++) {
    j=openJournal(filename,24);
    const inputs=store(j), adapter=createDashboardAdapter({...inputs,journalPath:filename,now});
    try {
      let state;
      for(let i=0;i<100;i++){state=adapter.snapshot();if(state.overview.status==='ready')break;await new Promise(r=>setTimeout(r,5));}
      assert.equal(state.summary.paperCapitalUsd,31);assert.equal(state.trades.length,2);
      assert.ok(state.trades.some(row=>row.side==='SELL'&&row.pnlUsd===7));assert.equal(state.summary.totalTrades,2);
    } finally {adapter.close();j.close();}
    assert.deepEqual(fs.readFileSync(filename+'.old.archive'), archive, 'history hydration never modifies archives');
  }
});
test('rotation retains cost basis for a position sold in the next journal', t=>{
  const {filename}=fixture(t);let j=openJournal(filename,24);
  j.append({kind:'event',event:fill('buy','BUY',10)});j.append({kind:'padding',text:'x'.repeat(21*1024*1024)});j.close();
  j=openJournal(filename,24);j.append({kind:'event',event:fill('sell','SELL',17)});j.close();
  j=openJournal(filename,24);assert.equal(store(j).tradeStore.snapshot().performance.paperCapitalUsd,31);j.close();
});

test('SOL checkpoints buys and sells, survives rotation and restart, and preserves raw overdraft', t=>{
  const {dir,filename}=fixture(t);let j=openJournal(filename,24);
  j.solReference(100,Date.parse(at));
  j.append({kind:'event',event:fill('sol-b1','BUY',10)});
  assert.ok(Math.abs(j.solAnchor().solBalance-0.14)<1e-12);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'capital-anchor.json'))).sol.fillsSeen,['sol-b1']);
  j.append({kind:'event',event:fill('sol-s1','SELL',17)});
  assert.ok(Math.abs(j.solAnchor().solBalance-0.31)<1e-12);
  j.append({kind:'padding',text:'x'.repeat(21*1024*1024)});j.close();
  j=openJournal(filename,24);
  assert.ok(Math.abs(j.solAnchor().solBalance-0.31)<1e-12);
  j.append({kind:'event',event:fill('sol-b2','BUY',10)});
  assert.ok(Math.abs(j.solAnchor().solBalance-0.21)<1e-12);
  j.close();j=openJournal(filename,24);
  j.append({kind:'event',event:fill('sol-s2','SELL',12)});
  j.close();j=openJournal(filename,24);
  assert.ok(Math.abs(j.solAnchor().solBalance-store(j).tradeStore.snapshot().performance.equity/100)<1e-6);
  const overdraft=fill('sol-overdraft','BUY',10);overdraft.payload.quantity=10;
  const inputs=store(j), portfolio=inputs.tradeStore.snapshot();
  inputs.tradeStore={snapshot:()=>portfolio};inputs.events.push(overdraft);
  const adapter=createDashboardAdapter({...inputs,now});adapter.reference(100,Date.parse(at));
  const wallet=adapter.snapshot().paperWallet;
  assert.equal(wallet.solBalance,0);assert.ok(Math.abs(wallet.solShortfall-0.67)<1e-12);
  assert.ok(Math.abs(wallet.solBalanceRaw-(j.solAnchor().solBalance-1))<1e-12);
  adapter.close();j.close();
});

test('one-time SOL backfill restores archived fills and freezes fallback conversion', t=>{
  const {dir,filename}=fixture(t);let j=openJournal(filename,24);
  const buy=fill('old-buy','BUY',10),sell=fill('old-sell','SELL',17);
  j.append({kind:'event',event:buy});j.append({kind:'event',event:sell});j.close();
  fs.renameSync(filename,filename+'.old.archive');fs.unlinkSync(path.join(dir,'capital-anchor.json'));
  j=openJournal(filename,24);
  j.solReference(200,Date.parse(at));
  assert.ok(Math.abs(j.solAnchor().solBalance-(0.12-0.05+0.085))<1e-12);
  assert.equal(j.solAnchor().fillsSeen.length,2);
  j.solReference(400,Date.parse(at)+1);j.close();
  j=openJournal(filename,24);
  assert.ok(Math.abs(j.solAnchor().solBalance-0.155)<1e-12);
  assert.equal(j.solAnchor().fillsSeen.length,2);j.close();
});

test('SOL replay recovers a missed fill checkpoint once and retains fill-time conversion with fees', t=>{
  const {dir,filename}=fixture(t);let j=openJournal(filename,24);
  j.solReference(100,Date.parse(at));
  const buy=fill('fee-buy','BUY',10);buy.payload.fees=0.1;
  j.append({kind:'event',event:buy});
  assert.ok(Math.abs(j.solAnchor().solBalance-0.139)<1e-12);
  j.solReference(200,Date.parse(at)+1);
  const sell=fill('fee-sell','SELL',17);sell.payload.fees=0.2;
  j.append({kind:'event',event:sell});
  assert.ok(Math.abs(j.solAnchor().solBalance-0.223)<1e-12);
  const previous=fs.readFileSync(path.join(dir,'capital-anchor.json'));
  j.append({kind:'event',event:fill('missed-buy','BUY',10)});j.close();
  fs.writeFileSync(path.join(dir,'capital-anchor.json'),previous);
  for(let boot=0;boot<2;boot++) {
    j=openJournal(filename,24);
    assert.ok(Math.abs(j.solAnchor().solBalance-0.173)<1e-12);
    assert.equal(j.solAnchor().fillsSeen.length,3);j.close();
  }
});

test('SOL migration uses newest legacy session and consumes older abandoned debits in dashboard history', t=>{
  const {dir,filename}=fixture(t);let j=openJournal(filename,24);
  j.append({kind:'event',event:fill('abandoned','BUY',10)});j.close();
  fs.renameSync(filename,filename+'.01.archive');fs.unlinkSync(path.join(dir,'capital-anchor.json'));
  j=openJournal(filename,24);
  j.append({kind:'event',event:fill('new-buy','BUY',10)});
  j.append({kind:'event',event:fill('new-sell','SELL',17)});j.close();
  fs.renameSync(filename,filename+'.02.archive');fs.unlinkSync(path.join(dir,'capital-anchor.json'));
  j=openJournal(filename,24);j.solReference(100,Date.parse(at));
  const adapter=createDashboardAdapter({...store(j),now});adapter.reference(100,Date.parse(at));
  assert.ok(Math.abs(adapter.snapshot().paperWallet.solBalance-0.31)<1e-12);
  assert.equal(j.solAnchor().fillsSeen.length,3);
  adapter.close();j.close();
});
test('explicit paper seed stays identical in anchor and trade store despite wallet observations', t=>{
  const {dir,filename}=fixture(t);let j=openJournal(filename,24);
  j.append({kind:'event',event:{...fill('wallet','BUY',10),type:'WalletValuation',producer:'RUNTIME',payload:{valueUsd:100,accountHash:'account',balanceAt:at,priceAt:at}}});
  j.append({kind:'event',event:fill('buy','BUY',10)});j.append({kind:'event',event:fill('sell','SELL',17)});j.close();
  j=openJournal(filename,24);
  assert.equal(store(j).tradeStore.snapshot().performance.paperCapitalUsd,31);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'capital-anchor.json'))).networks.SOLANA.paperCapitalUsd,31);j.close();
});
test('wallet-backed anchor includes gains in sizing; missed checkpoint recovers from committed sell', t=>{
  const {dir,filename}=fixture(t);let j=openJournal(filename,0);
  const quote={...fill('wallet','BUY',10),type:'WalletValuation',producer:'RUNTIME',payload:{valueUsd:24,accountHash:'account',balanceAt:at,priceAt:at}};
  j.append({kind:'event',event:quote});j.append({kind:'event',event:fill('buy','BUY',10)});
  const previous=fs.readFileSync(path.join(dir,'capital-anchor.json'));
  j.append({kind:'event',event:fill('sell','SELL',17)});j.close();
  fs.writeFileSync(path.join(dir,'capital-anchor.json'),previous);
  j=openJournal(filename,0);const {runtime}=store(j);
  const p=createTradeStore({runtime,capitalUsd:0,walletFunded:true,now}).snapshot().performance;
  assert.equal(p.paperCapitalUsd,31);assert.equal(p.budgetUsd,31);assert.equal(p.equity,31);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'capital-anchor.json'))).networks.SOLANA.paperCapitalUsd,31);j.close();
});
