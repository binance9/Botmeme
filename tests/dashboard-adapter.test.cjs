'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('../runtime/events/bus.cjs');
const { createHunter } = require('../services/jev/hunter.cjs');
const { createTradeStore } = require('../core/trades/store.cjs');
const { createDashboardAdapter } = require('../dashboard/adapter/index.cjs');
const at = '2026-09-24T10:00:00.000Z';

test('live overview ignores paper fills while history retains both modes and capital uses live cash', t => {
  let mode = 'live';
  const events = [
    { ...market('paper'), type: 'TradeResult', payload: { mode: 'paper', state: 'CLOSED', realizedPnl: 5.9 } },
    { ...market('live-win'), type: 'TradeResult', payload: { mode: 'live', state: 'CLOSED', realizedPnl: 2 } },
    { ...market('live-loss'), type: 'TradeResult', payload: { mode: 'live', state: 'CLOSED', realizedPnl: -1 } }
  ];
  const history = events.map(e => ({ ...e.payload, id: e.id, token: e.id, network: 'SOLANA', timestamp: at, side: 'SELL', quantity: 1, entryPrice: 1, exitPrice: 2, realizedReturn: 0, allocatedCostBasis: 1, positionState: 'CLOSED' }));
  const runtime = { snapshot: () => ({ events, network: 'SOLANA', epoch: 1, revision: 1 }), subscribe: () => () => {} };
  const tradeStore = { executionMode: () => mode, history: () => history, snapshot: () => ({ positions: [], trades: history.filter(t => t.mode === mode), performance: { cash: 19.63, equity: 19.63, capitalUsed: 0, paperCapitalUsd: 9999, budgetUsd: 19.63, unrealizedPnl: 0 } }) };
  const adapter = createDashboardAdapter({ runtime, tradeStore, now: () => new Date(at) }); t.after(() => adapter.close());
  const view = adapter.snapshot();
  assert.equal(view.summary.totalTrades, 2); assert.equal(view.summary.realizedPnlUsd, 1); assert.equal(view.summary.winRate, 50);
  assert.equal(view.summary.paperCapitalUsd, 19.63); assert.equal(view.summary.cashUsd, 19.63); assert.equal(view.summary.equityUsd, 19.63);
  assert.equal(view.trades.length, 3);
  mode = 'paper';
  assert.equal(adapter.snapshot().summary.realizedPnlUsd, 5.9);
  assert.equal(adapter.snapshot().summary.totalTrades, 1);
});

test('served UI has no obsolete labels or wallet connection entry points', () => {
  const fs = require('node:fs');
  for (const file of ['index.html', 'app.js', 'wallet.js']) {
    let source = fs.readFileSync(require.resolve('../public/meme-trader/' + file), 'utf8');
    // Internal protocol fields and the display sanitizer are not rendered labels.
    source = source.replace(/^.*const displayText =.*$/gm, '').replace(/paperExit|paperWallet|paperCapitalUsd|PAPER_EXECUTION|paper-ledger|buyPaper|sellPaper/g, '');
    assert.doesNotMatch(source, /paper|mô phỏng|USDC/i, file);
    assert.doesNotMatch(source, /wallet-connect|wallet-disconnect|wallet-okx-connect|wallet-sdk|Server đang dùng bản cũ/, file);
  }
});

test('real withdrawal UI validates base58, reserve, quick amounts, confirmation and duplicate submits', async () => {
  const vm = require('node:vm'), fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../public/meme-trader/wallet.js'), 'utf8');
  const nodes = new Map(), el = id => { if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '' }); return nodes.get(id); };
  let confirmed = false, calls = 0, release;
  const state = { network: 'SOLANA', live: { owner: '11111111111111111111111111111111', balanceSol: .1, caps: { reserve: .01 } } };
  const destination = 'So11111111111111111111111111111111111111112';
  const context = vm.createContext({ el, state, busy: false, withdrawing: false, destinationNetwork: 'SOLANA', window: { confirm: () => confirmed }, message: text => { el('message').textContent = text; }, render: () => {}, api: async (url, body) => {
    if (url.includes('withdrawal-destination')) return {};
    assert.equal(url, '/api/wallet/withdraw'); assert.equal(body.destinationAddress, destination); calls++;
    return new Promise(resolve => { release = resolve; });
  } });
  vm.runInContext(source.slice(source.indexOf('  const validAddress'), source.indexOf('  function open(panel)')), context);
  el('trading-destination').value = '0OIl'; el('trading-amount').value = '.04'; el('trading-amount').oninput();
  assert.equal(el('trading-submit').disabled, true);
  el('trading-destination').value = destination;
  for (const [id, expected] of [['all', '.089995000'], ['half', '.044997500'], ['quarter', '.022498750']]) {
    el('trading-' + id).onclick(); assert.equal(Number(el('trading-amount').value), Number(expected));
  }
  el('trading-amount').value = '.1'; el('trading-amount').oninput(); assert.match(el('trading-error').textContent, /Vượt/);
  const submit = () => el('trading-withdraw-form').onsubmit({ preventDefault() {} });
  el('trading-amount').value = '.04'; await submit(); assert.equal(calls, 0);
  confirmed = true; const pending = submit(); await Promise.resolve();
  assert.equal(el('trading-submit').disabled, true); await submit(); assert.equal(calls, 1);
  release({ signature: 'abcdefghijklmnopqrst', amountSol: .04, solBalance: .059995 }); await pending;
  assert.equal(state.live.balanceSol, .059995); assert.equal(el('trading-amount').value, '');
  assert.equal(el('message').textContent, 'Đã rút 0.04 SOL · tx abcdefghijkl');
});

test('dashboard renders one live SOL wallet and converts capital and PnL to SOL', () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../public/meme-trader/app.js'), 'utf8');
  const html = fs.readFileSync(require.resolve('../public/meme-trader/index.html'), 'utf8');
  assert.equal((html.match(/id="trading-sol"/g) || []).length, 1);
  assert.match(html, /Ví trading \(SOL\)/);
  assert.ok(!html.includes('USDC'));
  const nodes = new Map(), $ = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { textContent:'', style:{}, setAttribute(){}, removeAttribute(){} });
    return nodes.get(selector);
  };
  const snapshot = { network:'SOLANA', version:1, control:{live:{balanceSol:.2532}}, paperWallet:{solBalance:0.2532,solPriceUsd:100}, summary:{realizedPnlUsd:6.1,unrealizedPnlUsd:0,capitalUsedUsd:10,paperCapitalUsd:25} };
  const context = vm.createContext({ $, snapshot, selectedDiscovery:null, overviewMode:'today', document:{documentElement:{dataset:{}},querySelectorAll:()=>[]}, signed:n=>'+$'+n.toFixed(2) });
  vm.runInContext(source.slice(source.indexOf('  function renderOverview()'),source.indexOf('  function chooseChart('))+'\nrenderOverview();',context);
  assert.equal($('#pnl').textContent,'+0.0610 SOL');
  assert.equal($('#capital-value').textContent,'0.1000 SOL');
  assert.equal($('#capital-budget').textContent,'0.2500 SOL');
  for (const name of ['renderAgents','renderTrades','renderEvents','renderChart','renderProtection','renderDiscoveries','renderDetail']) context[name]=()=>{};
  vm.runInContext(source.slice(source.indexOf('  function render() {'),source.indexOf('  const stream ='))+'\nrender();',context);
  assert.equal($('#trading-sol').textContent,'0.2532 SOL');
  snapshot.control.live.balanceSol=0.31;
  vm.runInContext('render();',context);
  assert.equal($('#trading-sol').textContent,'0.3100 SOL');
});
test('paper SOL settlement uses funding and reference prices without changing USD capital', async t => {
  const runtime=createRuntime({now:()=>new Date(at)}), base=createTradeStore({runtime,now:()=>new Date(at)}).snapshot();
  let events=[], clock=Date.parse(at);
  const adapter=createDashboardAdapter({runtime:{snapshot:()=>({...runtime.snapshot(),events}),subscribe:()=>()=>{}},tradeStore:{snapshot:()=>base},now:()=>new Date(clock)});
  t.after(async()=>{adapter.close();await runtime.close();});
  const event=(id,type,payload,network='SOLANA')=>({...market(id),type,network,timestamp:new Date(clock).toISOString(),payload:{realizedPnl:0,...payload}});
  events.push(event('funding','WalletValuation',{symbol:'SOL',amount:'0.1963',priceUsd:999}));
  assert.equal(adapter.snapshot().paperWallet.solPriceUsd,null,'never substitute wallet valuation for the reference feed');
  adapter.reference(100,clock);
  const initial=adapter.snapshot();
  assert.equal(initial.paperWallet.solStart,0.1963);
  assert.equal(initial.paperWallet.solBalance,0.1963);
  events.push(event('buy','TradeResult',{mode:'paper',side:'BUY',token:'token',quantity:2,entryPrice:5.1,exitPrice:null,fees:0.1}));
  const buy=adapter.snapshot(), spent=(10+0.2+0.1)/100;
  assert.ok(Math.abs(buy.paperWallet.solBalance-(0.1963-spent))<1e-12);
  assert.match(buy.activities[0].message,/· −0\.103000 SOL$/);
  clock+=1000;adapter.reference(200,clock);
  assert.equal(adapter.snapshot().paperWallet.solBalance,buy.paperWallet.solBalance,'buy keeps its available fill-time price');
  events.push(event('sell','TradeResult',{mode:'paper',side:'SELL',token:'token',quantity:2,entryPrice:5.1,exitPrice:8,fees:0.2}));
  let delivered;adapter.subscribe(s=>{delivered=s;});adapter.refresh();
  const received=(16-0.2)/200;
  assert.ok(delivered.paperWallet.solBalance>buy.paperWallet.solBalance);
  assert.ok(Math.abs(delivered.paperWallet.solBalance-(0.1963-spent+received))<1e-12);
  assert.equal(delivered.paperWallet.solPriceUsd,200);
  assert.match(delivered.activities[0].message,/· \+0\.079000 SOL$/);
  for(const field of ['cashUsd','valueUsd','totalValueUsd'])assert.equal(delivered.paperWallet[field],initial.paperWallet[field]);
  for(const field of ['paperCapitalUsd','capitalUsedUsd','cashUsd','equityUsd'])assert.equal(delivered.summary[field],initial.summary[field],'settlement projection cannot affect USD accounting');
  events.push(event('overdraft','TradeResult',{mode:'paper',side:'BUY',token:'token',quantity:10,entryPrice:10,fees:0}));
  let wallet=adapter.snapshot().paperWallet;
  assert.equal(wallet.solBalance,0);
  assert.ok(Math.abs(wallet.solBalanceRaw-(0.1963-spent+received-0.5))<1e-12);
  assert.equal(wallet.solShortfall,-wallet.solBalanceRaw);
  events.push(event('deposit','WalletValuation',{symbol:'SOL',amount:'1',priceUsd:999}));
  wallet=adapter.snapshot().paperWallet;
  assert.ok(Math.abs(wallet.solBalance-(1-spent+received-0.5))<1e-12,'latest funding rebases all paper flows, never erases them');
  assert.equal(wallet.solShortfall,0);
  events.push(event('live','TradeResult',{mode:'live',side:'BUY',token:'token',quantity:100,entryPrice:10,fees:0}));
  events.push(event('other-network','TradeResult',{mode:'paper',side:'BUY',token:'token',quantity:100,entryPrice:10,fees:0},'BSC'));
  assert.equal(adapter.snapshot().paperWallet.solBalance,wallet.solBalance);
  // After replay, unavailable historical references explicitly fall back to latest.
  clock+=3*60*60*1000;adapter.reference(400,clock);
  wallet=adapter.snapshot().paperWallet;
  assert.ok(Math.abs(wallet.solBalance-(1-10.3/400+15.8/400-100/400))<1e-12);
});
function market(id, price = 10, changes = {}) { return { id, type: 'MarketSnapshot', producer: 'MARKET_DATA', timestamp: at, source: 'adapter-contract-case', evidence: ['provider-record'], status: 'OBSERVED', correlationId: id, network: 'SOLANA', epoch: 1, confidence: 0.9, evidence_quality: 0.9, missing_evidence: [], uncertainty: 0.1, payload: { token: 'token', price, liquidityUsd: 100000, volume24hUsd: 5000, observedAt: at }, ...changes }; }
function setup(t) {
  let clock = new Date(at); const now = () => clock;
  const runtime = createRuntime({ now }), tradeStore = createTradeStore({ runtime, now });
  const adapter = createDashboardAdapter({ runtime, tradeStore, now });
  t.after(async () => { adapter.close(); await runtime.close(); });
  return { runtime, adapter, advance: ms => { clock = new Date(clock.getTime() + ms); } };
}
test('empty runtime projects frozen UI shape without pretend scan progress or win rate', t => {
  const { adapter } = setup(t), state = adapter.snapshot();
  assert.equal(state.agents.length, 4); assert.equal(state.agents[3].role, 'Forensic Analyst');
  assert.ok(state.agents.every(a => a.progress === null && a.total === null && a.status === 'waiting'));
  assert.equal(state.scan, null); assert.equal(state.activeToken, null); assert.equal(state.summary.winRate, null);
  assert.equal(state.summary.totalTrades, 0); assert.equal(state.summary.capitalUsedUsd, 0);
  assert.throws(() => { state.summary.totalTrades = 1; }, TypeError);
});
test('real runtime Hunter activity and observed prices reach one subscribed dashboard projection', async t => {
  const { runtime, adapter } = setup(t), hunter = createHunter({ runtime, now: () => new Date(at) });
  t.after(() => hunter.stop()); hunter.start(); const states = []; const stop = adapter.subscribe(s => states.push(s));
  runtime.publish(market('a')); runtime.publish(market('b', 12)); await runtime.flush();
  const state = adapter.snapshot(), chart = state.markets[state.activeToken];
  assert.equal(chart.firstPriceUsd, 10); assert.equal(chart.priceUsd, 12);
  assert.deepEqual(chart.candles, [{ at: Date.parse(at), open: 10, high: 12, low: 10, close: 12, volumeUsd: null }]);
  assert.deepEqual(chart.points, [{ at: Date.parse(at), priceUsd: 12 }], 'same-timestamp observation replaces the point without creating artificial elapsed time');
  assert.equal(state.agents[0].progress, null); assert.ok(state.activities.some(a => a.agentId === 'jev'));
  assert.ok(state.activities.every(a => runtime.get(a.id))); assert.ok(states.length > 1);
  stop(); const count = states.length; runtime.publish(market('c', 13)); await runtime.flush(); assert.equal(states.length, count);
});
test('network switch clears old chart and agent state; snapshot and refresh use actual epoch', async t => {
  const { runtime, adapter } = setup(t); runtime.publish(market('a')); await runtime.flush();
  let last; adapter.subscribe(s => { last = s; }); runtime.selectNetwork('BSC'); adapter.refresh();
  assert.equal(last.network, 'BSC'); assert.equal(last.epoch, 2); assert.equal(last.activeToken, null); assert.deepEqual(last.activities, []);
  runtime.publish(market('b', 20, { network: 'BSC', epoch: 2 })); await runtime.flush();
  assert.equal(adapter.snapshot().markets[adapter.snapshot().activeToken].priceUsd, 20);
});
test('stale weak and future observed prices never masquerade as current chart data', async t => {
  const { runtime, adapter, advance } = setup(t); runtime.publish(market('weak', 9, { missing_evidence: ['unknown provenance'] })); await runtime.flush();
  assert.equal(adapter.snapshot().activeToken, null);
  runtime.publish(market('good')); await runtime.flush(); assert.notEqual(adapter.snapshot().activeToken, null);
  advance(60001); assert.equal(adapter.snapshot().activeToken, null);
});
test('failing SSE listener is isolated and adapter close detaches without closing runtime', async t => {
  const { runtime, adapter } = setup(t); let healthy = 0;
  adapter.subscribe(() => { throw Error('socket gone'); }); adapter.subscribe(() => healthy++);
  runtime.publish(market('a')); await runtime.flush(); assert.equal(healthy, 1); assert.deepEqual(runtime.snapshot().deliveryErrors, []);
  adapter.close(); runtime.publish(market('b')); await runtime.flush(); assert.equal(healthy, 1);
  assert.throws(() => adapter.subscribe(() => {}), /INVALID_DASHBOARD_SUBSCRIBER/);
});
test('JEV progress uses recorded discovery progress with original MARKET_DATA attribution', async t => {
  const { runtime, adapter } = setup(t);
  runtime.publish({ ...market('scan-progress'), type: 'AIActivityEvent', payload: { agent: 'MARKET_DATA', task: 'scan:one', state: 'RUNNING', progress: 0.25, message: 'Processed provider observations.' } });
  await runtime.flush();
  const state = adapter.snapshot();
  assert.equal(state.agents[0].progress, 25); assert.equal(state.agents[0].completed, null); assert.equal(state.agents[0].total, null);
  assert.equal(state.agents[0].progressProducer, 'MARKET_DATA'); assert.equal(state.agents[0].progressEventId, 'scan-progress');
  assert.equal(state.activities[0].producer, 'MARKET_DATA'); assert.equal(state.activities[0].source, 'adapter-contract-case');
  assert.equal(state.activities[0].agentId, 'jev'); assert.match(state.activities[0].message, /^Market data: /);
  runtime.selectNetwork('BSC'); assert.equal(adapter.snapshot().agents[0].progress, null);
});
test('scan metrics are plain counts with percentages only while running', async t => {
  const { runtime, adapter } = setup(t);
  for (const [index, state, completed, total, progress] of [[0, 'RUNNING', 2, 4, 50], [1, 'COMPLETED', 4, 4, null], [2, 'FAILED', 3, 4, null], [3, 'RUNNING', 0, 0, null]]) {
    const id = `scan-count-${index}`;
    runtime.publish({ ...market(id), type: 'ScanProgress', payload: { runId: id, state, completed, total, failed: 0, skipped: 0 } });
    await runtime.flush();
    const agent = adapter.snapshot().agents[0];
    assert.deepEqual(agent.metric, { done: completed, total: null, label: 'Token đã quét' });
    assert.equal(agent.progress, progress);
    assert.equal(agent.status, state.toLowerCase());
    assert.equal(agent.updatedAt, at);
    assert.equal(agent.progressEventId, id);
    assert.equal(agent.progressProducer, 'MARKET_DATA');
  }
});

test('price wave points preserve observed timestamps and prices rather than candle bucket times', async t => {
  const { runtime, adapter, advance } = setup(t);
  runtime.publish(market('point-a', 10)); await runtime.flush();
  advance(15000);
  const later = '2026-09-24T10:00:15.000Z';
  runtime.publish(market('point-b', 11, { timestamp: later, payload: { ...market('x').payload, price: 11, observedAt: later } })); await runtime.flush();
  const state = adapter.snapshot();
  assert.deepEqual(state.markets[state.activeToken].points, [{ at: Date.parse(at), priceUsd: 10 }, { at: Date.parse(later), priceUsd: 11 }]);
  assert.equal(state.markets[state.activeToken].candles.length, 1);
});
test('SOL reference feed keeps the chart alive and observations never steal focus', async t => {
  const { runtime, adapter, advance } = setup(t);
  runtime.publish(market('observed-meme', 10)); await runtime.flush();
  const stamp = Date.parse(at) + 1000;
  assert.equal(adapter.reference(150.25, stamp), true);
  assert.equal(adapter.reference(-1, stamp), false, 'invalid quotes are rejected');
  advance(2000);
  const state = adapter.snapshot(), sol = state.markets[state.activeToken];
  assert.equal(sol.symbol, 'SOL');
  assert.equal(sol.priceUsd, 150.25);
  assert.deepEqual(sol.points, [{ at: stamp, priceUsd: 150.25 }]);
  assert.deepEqual(sol.candles, [{ at: Date.parse(at), open: 150.25, high: 150.25, low: 150.25, close: 150.25, volumeUsd: null }]);
  assert.equal(state.markets[JSON.stringify(['SOLANA', 'token'])].priceUsd, 10, 'observed memes stay in the sidebar data but do not take the chart');
  advance(24 * 60 * 60 * 1000);
  assert.equal(adapter.snapshot().markets[JSON.stringify(['INDEX', 'SOL'])], undefined, 'reference samples older than a day are dropped');
});
test('structured scanner counts reach dashboard without parsing activity prose', async t => {
  const { runtime, adapter } = setup(t);
  runtime.publish({ ...market('counts'), type: 'ScanProgress', payload: { runId:'scan:live',state:'FAILED',total:5,completed:2,failed:1,skipped:0 } });
  await runtime.flush();
  assert.deepEqual(adapter.snapshot().scan, { runId:'scan:live',state:'FAILED',total:5,completed:2,failed:1,skipped:0,found:1,candidates:0 });
  runtime.selectNetwork('BSC'); assert.equal(adapter.snapshot().scan,null);
});

test('JEV card follows scan lifecycle instead of retaining an older Hunter result', async t => {
  const { runtime, adapter } = setup(t);
  const activity = (id, producer, state, message, progress = null) => runtime.publish({
    ...market(id), type: 'AIActivityEvent', producer,
    payload: { agent: producer, task: producer === 'MARKET_DATA' ? 'scan:current' : 'research', state, message, progress }
  });
  activity('old-hunter', 'JEV', 'WAITING', 'Previous observation was stale.');
  activity('new-scan', 'MARKET_DATA', 'RUNNING', 'Discovery started.');
  await runtime.flush();
  let jev = adapter.snapshot().agents[0];
  assert.equal(jev.status, 'running'); assert.equal(jev.task, 'Discovery started.'); assert.equal(jev.progress, null);
  activity('current-hunter', 'JEV', 'WAITING', 'Current token needs more evidence.');
  await runtime.flush();
  assert.equal(adapter.snapshot().agents[0].task, 'Current token needs more evidence.');
  activity('failed-scan', 'MARKET_DATA', 'FAILED', 'Provider rate limited; waiting for retry.', .5);
  await runtime.flush(); jev = adapter.snapshot().agents[0];
  assert.equal(jev.status, 'failed'); assert.equal(jev.progress, null);
  assert.equal(jev.task, 'Provider rate limited; waiting for retry.'); assert.equal(jev.progressEventId, 'failed-scan');
  activity('stopped-scan', 'MARKET_DATA', 'STOPPED', 'Scan stopped.', .5);
  await runtime.flush(); assert.equal(adapter.snapshot().agents[0].status, 'stopped'); assert.equal(adapter.snapshot().agents[0].progress, null);
  runtime.selectNetwork('BSC');
  assert.equal(adapter.snapshot().agents[0].status, 'waiting'); assert.equal(adapter.snapshot().agents[0].task, null);
});

test('AI completed-task counts deduplicate updates and exclude waiting or failed tasks', async t => {
  const { runtime, adapter } = setup(t);
  const publish = (id, task, state) => runtime.publish({ ...market(id), type: 'AIActivityEvent', producer: 'CODEX_2', payload: { agent: 'CODEX_2', task, state, message: state, progress: null } });
  publish('a-start', 'research-a', 'RUNNING');
  publish('a-end', 'research-a', 'COMPLETED');
  publish('a-repeat', 'research-a', 'COMPLETED');
  publish('b-wait', 'research-b', 'WAITING');
  publish('c-fail', 'research-c', 'FAILED');
  await runtime.flush();
  const quant = adapter.snapshot().agents[2];
  assert.equal(quant.completed, 1); assert.equal(quant.total, 3);
  assert.equal(quant.progress, null, 'task counts must not invent model progress');
  publish('a-reopen', 'research-a', 'RUNNING'); await runtime.flush();
  assert.equal(adapter.snapshot().agents[2].completed, 0);
  runtime.selectNetwork('BSC'); assert.equal(adapter.snapshot().agents[2].completed, null);
});
function candidateFor(snap) {
  return { id: 'cand-' + snap.id, type: 'TokenCandidate', producer: 'JEV', timestamp: snap.timestamp, source: 'adapter-case', evidence: [snap.id], status: 'OBSERVED', correlationId: snap.correlationId, network: snap.network, epoch: snap.epoch, confidence: 0.85, evidence_quality: 0.85, missing_evidence: [], uncertainty: 0.15,
    payload: { token: snap.payload.token, symbol: 'MEME', snapshotId: snap.id, liquidityUsd: snap.payload.liquidityUsd, volume24hUsd: snap.payload.volume24hUsd, rank: 1, anomalies: ['TOKEN_DISCOVERY'] } };
}
test('safety and Jev projections show the latest verdict per candidate only', async t => {
  const { runtime, adapter } = setup(t);
  const snap = market('s1', 10); snap.payload = { ...snap.payload, marketCapUsd: 45000, poolAgeMs: 600000, realVolumeUsd: 3000 };
  runtime.publish(snap);
  const cand = candidateFor(snap); runtime.publish(cand); await runtime.flush();
  const safetyAt = () => new Date(Date.parse(at) + 1).toISOString();
  runtime.publish({ id: 'safety-1', type: 'SafetyDecision', timestamp: safetyAt(), producer: 'SAFETY_GATE', source: 'gate', evidence: [cand.id, snap.id], status: 'APPROVED', correlationId: snap.correlationId, network: snap.network, epoch: snap.epoch, confidence: 0.85, evidence_quality: 0.85, missing_evidence: [], uncertainty: 0.15,
    payload: { candidateId: cand.id, approved: true, reason: 'ok', checks: [{ name: 'LIQ', passed: true, detail: '85000' }] } });
  runtime.publish({ id: 'jev-1', type: 'JevVerdict', timestamp: safetyAt(), producer: 'JEV', source: 'jev', evidence: [cand.id], status: 'COMPLETED', correlationId: snap.correlationId, network: snap.network, epoch: snap.epoch, confidence: 0.7, evidence_quality: 0.9, missing_evidence: [], uncertainty: 0.3,
    payload: { candidateId: cand.id, action: 'WATCH', confidence: 0.7, tradableProbability: 0.44, momentum: 2, model: 'jev-1.13.0', latencyMs: 900, violations: [] } });
  await runtime.flush();
  let s = adapter.snapshot();
  assert.equal(s.safety.screened, 1); assert.equal(s.safety.approved, 1); assert.equal(s.safety.rejected, 0);
  assert.equal(s.jev.verdicts, 1); assert.equal(s.jev.actions.WATCH, 1);
  assert.equal(s.activities.some(a => a.producer === 'SAFETY_GATE'), true);
  // A later rejection supersedes the approval; the dashboard counts the latest only.
  runtime.publish({ id: 'safety-2', type: 'SafetyDecision', timestamp: new Date(Date.parse(at) + 2).toISOString(), producer: 'SAFETY_GATE', source: 'gate', evidence: [cand.id, snap.id], status: 'REJECTED', correlationId: snap.correlationId, network: snap.network, epoch: snap.epoch, confidence: 0, evidence_quality: 0, missing_evidence: ['VETO: test'], uncertainty: 1,
    payload: { candidateId: cand.id, approved: false, reason: 'VETO: test', checks: [] } });
  await runtime.flush();
  s = adapter.snapshot();
  assert.equal(s.safety.screened, 1); assert.equal(s.safety.approved, 0); assert.equal(s.safety.rejected, 1);
});
test('protection projection exposes real stop, take-profit and high-water for an open position', async t => {
  const { createRiskEngine } = require('../core/risk/engine.cjs');
  const { createStrategyEngine } = require('../core/strategy/engine.cjs');
  const { createExitManager } = require('../core/risk/exit-manager.cjs');
  const { createPaperExecution } = require('../core/execution/paper.cjs');
  const { createSafetyGate } = require('../core/safety/gate.cjs');
  const runtime = createRuntime({ now: () => new Date() });
  const tradeStore = createTradeStore({ runtime, now: () => new Date() });
  const adapter = createDashboardAdapter({ runtime, tradeStore, now: () => new Date() });
  const goodReader = { network: 'SOLANA', async read() { return { mintAuthorityRevoked: true, freezeAuthorityRevoked: true, maxLpLockedPct: 85, top10HolderPct: 25, insiderHolderPct: 5, scoreNormalised: 10 }; } };
  const inputs = { runtime, tradeStore, now: () => new Date() };
  const modules = [createRiskEngine(inputs), createStrategyEngine(inputs), createSafetyGate({ ...inputs, readers: { SOLANA: goodReader } }), createExitManager(inputs), createPaperExecution({ ...inputs, policy: { requireSafetyVerdict: true } })];
  modules.forEach(m => m.start());
  t.after(async () => { adapter.close(); for (const m of modules.slice().reverse()) m.stop(); await runtime.close(); });
  let seq = 0;
  const live = price => { const stamp = new Date().toISOString(); return { id: 'live-' + (++seq), type: 'MarketSnapshot', producer: 'MARKET_DATA', timestamp: stamp, source: 'case', evidence: ['ev-' + seq], status: 'OBSERVED', correlationId: 'corr-live', network: 'SOLANA', epoch: 1, confidence: 0.9, evidence_quality: 0.9, missing_evidence: [], uncertainty: 0.1, payload: { token: 'token', price, liquidityUsd: 85000, volume24hUsd: 400000, observedAt: stamp, marketCapUsd: 10000, poolAgeMs: 3 * 60000, realVolumeUsd: 1000 } }; };
  const token = 'token';
  for (let i = 0; i < 5; i++) runtime.publish(live(0.001));
  const last = runtime.snapshot().events.filter(e => e.type === 'MarketSnapshot').at(-1);
  runtime.publish({ ...candidateFor(last), id: 'cand-live' }); await runtime.flush();
  runtime.publish({ id: 'sig-live', type: 'SignalObservation', timestamp: new Date().toISOString(), producer: 'STRATEGY_ENGINE', source: 'case', evidence: [last.id, 'cand-live'], status: 'OBSERVED', correlationId: last.correlationId, network: last.network, epoch: last.epoch, confidence: 0.9, evidence_quality: 0.9, missing_evidence: [], uncertainty: 0.1, payload: { candidateId: 'cand-live', snapshotId: last.id, signals: [{ name: 'price', value: 0.001 }] } });
  runtime.publish({ id: 'regime-live', type: 'MarketRegimeState', timestamp: new Date().toISOString(), producer: 'MARKET_DATA', source: 'case', evidence: [last.id], status: 'OBSERVED', correlationId: last.correlationId, network: last.network, epoch: last.epoch, confidence: 0.9, evidence_quality: 0.9, missing_evidence: [], uncertainty: 0.1, payload: { regime: 'MOMENTUM_EXPANSION', snapshotIds: runtime.snapshot().events.filter(e => e.type === 'MarketSnapshot').map(e => e.id), reason: 'case' } });
  runtime.publish({ id: 'dec-live', type: 'StrategyDecision', timestamp: new Date().toISOString(), producer: 'CODEX_1', source: 'case', evidence: ['cand-live', 'sig-live', last.id], status: 'APPROVED', correlationId: last.correlationId, network: last.network, epoch: last.epoch, confidence: 0.9, evidence_quality: 0.9, missing_evidence: [], uncertainty: 0.1, payload: { candidateId: 'cand-live', snapshotId: last.id, signalIds: ['sig-live'], strategyVersion: 'meme-flow-v1', quantEvidenceIds: [], criticReportIds: [], regimeId: 'regime-live', action: 'BUY', disposition: 'TRADE', reason: 'case entry' } });
  await runtime.flush();
  let s = adapter.snapshot();
  assert.equal(s.protection.length, 1, 'open position is protected');
  const p = s.protection[0];
  assert.equal(p.tokenId, token);
  assert.ok(p.entryPriceUsd > 0.001, 'entry includes slippage+fee: ' + p.entryPriceUsd);
  assert.ok(Math.abs(p.stopUsd - p.entryPriceUsd * 0.70) < 1e-12); // Owner stop: -30%.
  assert.ok(Math.abs(p.takeProfitUsd - p.entryPriceUsd * 1.15) < 1e-12);
  assert.equal(p.trailingArmed, false);
  runtime.publish(live(0.0011)); await runtime.flush();
  s = adapter.snapshot();
  assert.equal(s.protection[0].trailingArmed, true, 'high-water mark from observed prices arms the trail');
  assert.ok(s.protection[0].highWaterUsd >= 0.0011);
  runtime.publish(live(p.entryPriceUsd * 0.71)); await runtime.flush();
  // Owner directive: the trailing stop no longer exits — a drawdown print
  // (still above the -30% stop at entry*0.70) keeps the position open and
  // protected until the take-profit multiple.
  const still = runtime.snapshot().events.filter(e => e.type === 'TradeResult').at(-1);
  assert.equal(still.payload.state, 'OPEN', 'no trailing exit before the multiple');
  s = adapter.snapshot();
  assert.equal(s.protection.length, 1, 'open position stays in the protection table');
  assert.ok(s.protection[0].highWaterUsd >= 0.0011, 'high-water mark is tracked');
  const view = require('../public/meme-trader/app.js');
  const initial = tradeStore.snapshot().positions[0];
  const delivered = [];
  adapter.subscribe(state=>delivered.push(state));
  runtime.publish(live(initial.averageCost * 2.1)); await runtime.flush();
  s = adapter.snapshot();
  const partial = view.openPositions(s.trades)[0];
  assert.ok(partial && partial.remainingQuantity < initial.quantity);
  assert.ok(partial.bankedPnlUsd > 0 && partial.bankedPnlPct > 0);
  assert.match(partial.sellBadge, /^ĐÃ BÁN 1 PHẦN \(50.0%\)$/);
  assert.equal(s.protection[0].sellBadge,partial.sellBadge);
  assert.match(view.detailCells(partial), /Đã chốt.*Còn/);
  assert.equal(s.paperWallet.currency, 'SOL');
  assert.ok(!JSON.stringify(s).includes('USDC'));
  assert.equal(s.paperWallet.holdings[0].symbol, 'MEME');
  assert.equal(s.paperWallet.holdings[0].quantity, partial.remainingQuantity);
  assert.equal(s.paperWallet.holdings[0].valueUsd, initial.averageCost * 2.1 * partial.remainingQuantity);
  assert.equal(s.summary.realizedPnlUsd, partial.bankedPnlUsd);
  assert.equal(s.summary.paperCapitalUsd, 10000 + partial.bankedPnlUsd);
  assert.equal(s.paperWallet.cashUsd, s.summary.paperCapitalUsd - s.summary.capitalUsedUsd);
  const partialFill = s.trades.find(t=>t.side!=='BUY');
  const partialTick = delivered.find(s=>s.trades.some(t=>t.id===partialFill.id));
  assert.equal(partialTick.summary.realizedPnlUsd, partial.bankedPnlUsd);
  assert.match(partialTick.activities.find(e=>e.id===partialFill.id).message, /^Đã bán MEME · .* token/);
  assert.match(partialTick.activities.find(e=>e.id===partialFill.id).detail, /^\+\$/);
  assert.match(partialTick.activities.find(e=>e.id===partialFill.id).detail, /\$\d+\.\d{2} \(/);
  delivered.length=0;
  runtime.publish(live(initial.averageCost * 0.6)); await runtime.flush();
  s = adapter.snapshot();
  const close = s.trades.find(t=>t.side!=='BUY' && t.id!==partialFill.id);
  const closeTick = delivered.find(s=>s.trades.some(t=>t.id===close.id));
  assert.equal(view.openPositions(closeTick.trades).length, 0, 'full SELL leaves open rows on first fill snapshot');
  const history = view.historyRows(closeTick.trades).find(t=>t.id===close.id);
  assert.equal(history.symbol,'MEME');
  for (const field of ['enteredAt','exitedAt','entryPriceUsd','exitPriceUsd','pnlUsd','pnlPct']) assert.notEqual(history[field], null, field);
  assert.equal(closeTick.summary.capitalUsedUsd,0);
  assert.equal(closeTick.summary.realizedPnlUsd,tradeStore.snapshot().performance.realizedPnl);
  assert.deepEqual(closeTick.paperWallet.holdings,[]);
  assert.equal(closeTick.paperWallet.currency, 'SOL');
  assert.ok(!JSON.stringify(closeTick).includes('USDC'));
  assert.equal(closeTick.paperWallet.totalValueUsd,10000+closeTick.summary.realizedPnlUsd);
  assert.match(closeTick.activities.find(e=>e.id===close.id).detail, /−\$/);
  assert.match(closeTick.activities.find(e=>e.id===close.id).detail, /\$\d+\.\d{2} \(/);
});

test('chart and trades stay on selected network; same-network BUY takes focus',async t=>{
 const runtime=createRuntime({now:()=>new Date(at)}),ledger=createTradeStore({runtime,now:()=>new Date(at)});
 const base=ledger.snapshot();let trades=[],positions=[];
 const adapter=createDashboardAdapter({runtime,now:()=>new Date(at),tradeStore:{snapshot:()=>({...base,trades,positions})}});
 t.after(async()=>{adapter.close();await runtime.close();});
 adapter.reference(150,Date.parse(at));
 const token='bought-token',network='ROBINHOOD';
 trades=[{id:'unit-fill',side:'BUY',network,token,timestamp:at,entryPrice:2,quantity:5,allocatedCostBasis:10,realizedReturn:null,positionState:'OPEN'}];positions=[{network,token,quantity:5}];
 let state=adapter.snapshot();assert.equal(state.activeToken,JSON.stringify(['INDEX','SOL']));assert.equal(state.trades.length,0);
 runtime.selectNetwork('ROBINHOOD');state=adapter.snapshot();assert.equal(Object.values(state.markets).some(m=>m.priceSource==='REFERENCE_FEED'),false);assert.equal(state.trades.length,1);assert.equal(state.activeToken,JSON.stringify([network,token]));assert.equal(state.markets[state.activeToken].priceUsd,null,'no invented price without market evidence');
 adapter.reference(151,Date.parse(at));state=adapter.snapshot();assert.equal(state.markets[state.activeToken].focusTradeId,'unit-fill');
 positions=[];state=adapter.snapshot();assert.equal(state.activeToken,null);runtime.selectNetwork('SOLANA');state=adapter.snapshot();assert.equal(state.activeToken,JSON.stringify(['INDEX','SOL']));
});
