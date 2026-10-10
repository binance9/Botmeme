'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createRuntime } = require('../runtime/events/bus.cjs');
const { createTradeStore } = require('../core/trades/store.cjs');
const { createDashboardAdapter } = require('../dashboard/adapter/index.cjs');
const { createValuationReader } = require('../wallet/connection/valuation.cjs');
const at = '2026-09-24T10:00:00.000Z';
test('paper deposits adjust wallet-funded sizing and overview without changing wallet evidence', async t => {
  const now = () => new Date(at), runtime = createRuntime({ now }); t.after(() => runtime.close());
  const capitalLedger = require('../runtime/capital-ledger.cjs').createCapitalLedger(null, now);
  const store = createTradeStore({ runtime, now, capitalUsd: 0, walletFunded: true, capitalLedger });
  const adapter = createDashboardAdapter({ runtime, tradeStore: store, now }); t.after(() => adapter.close());
  runtime.publish(funding(20));
  capitalLedger.adjust({ type: 'deposit', amountUsd: 30, network: 'SOLANA', eventCount: 1, currentCapitalUsd: 20 });
  assert.equal(store.snapshot().performance.equity, 50); assert.equal(store.snapshot().performance.budgetUsd, 50);
  assert.equal(adapter.snapshot().summary.paperCapitalUsd, 50); assert.equal(adapter.snapshot().paperWallet.cashUsd, 50);
  capitalLedger.adjust({ type: 'withdraw', amountUsd: 10, network: 'SOLANA', eventCount: 1, currentCapitalUsd: 50 });
  assert.equal(store.snapshot().performance.cash, 40); assert.equal(adapter.snapshot().summary.paperCapitalUsd, 40);
  assert.equal(runtime.snapshot().events.find(e => e.type === 'WalletValuation').payload.valueUsd, 20);
});
function funding(value, id = 'funding-1') { return { id, type: 'WalletValuation', timestamp: at, producer: 'RUNTIME', source: 'test-protocol', evidence: ['balance-hash','price-hash'], status: 'OBSERVED', correlationId: id, network: 'SOLANA', epoch: 1, confidence: 1, evidence_quality: 1, missing_evidence: [], uncertainty: 0, payload: { amount: '0.010000000', symbol: 'SOL', balanceAt: at, priceAt: at, priceUsd: value * 100, valueUsd: value, accountHash: 'account-a' } }; }
test('paper SOL withdrawal HTTP: atomic debit, history, activity, counter, validation and restart', async t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-withdraw-'));
  const { createApplication } = require('../runtime/application.cjs');
  const options = { liveConfig: { root: dir, env: {} }, journalPath: path.join(dir, 'test.jsonl'), now: () => new Date(at), capitalUsd: 20, providers: {} };
  const application = createApplication(options);
  const session = { network: 'SOLANA', chainId: 'mainnet-beta', address: 'So11111111111111111111111111111111111111112', provider: 'test' };
  await application.connect(session); application.runtime.publish(funding(20));
  const service = require('../scripts/serve-meme-trader.cjs').createDashboardServer({ application, now: options.now, copyPath: null, copyWatch: false });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  let restored;
  t.after(async () => { await service.close(); await restored?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const url = 'http://127.0.0.1:' + service.server.address().port;
  const post = body => fetch(url + '/api/paper/withdraw', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const response = await post({ amountSol: .004 }); assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.mode, 'paper');
  assert.ok(Math.abs(result.solBalance - .006) < 1e-12); assert.equal(result.withdrawnSol, .004);
  assert.equal(result.entry.toWallet, session.address); assert.equal(result.entry.type, 'withdraw');
  const state = await (await fetch(url + '/api/state')).json();
  assert.equal(state.paperWallet.withdrawnSol, .004); assert.ok(Math.abs(state.paperWallet.solBalance - .006) < 1e-12);
  assert.equal(application.tradeStore.snapshot().performance.cash, 12);
  const activity = application.runtime.get(result.entry.id);
  assert.equal(activity.type, 'AIActivityEvent'); assert.match(activity.payload.message, /Đã rút 0.004 SOL về ví chính/);
  assert.ok(state.activities.some(e => JSON.stringify(e).includes('Đã rút 0.004 SOL về ví chính')));
  assert.deepEqual(application.runtime.get('funding-1'), funding(20), 'on-chain wallet evidence unchanged');
  for (const body of [null, {}, [], { amountSol: '0.001' }, { amountSol: null }, { amountSol: true }, { amountSol: 0 }, { amountSol: -1 }, { amountSol: .007 }, { amountSol: .001, extra: true }]) {
    const rejected = await post(body); assert.equal(rejected.status, 400, JSON.stringify(body)); assert.ok((await rejected.json()).error);
  }
  for (const amount of [NaN, Infinity, -Infinity, Number.MIN_VALUE]) await assert.rejects(application.withdrawPaperSol(amount), { status: 400 });
  assert.equal(application.paperWithdrawals().length, 1);
  const concurrent = await Promise.all([post({ amountSol: .004 }), post({ amountSol: .004 })]);
  assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 400]);
  const ledger = await (await fetch(url + '/api/paper/withdrawals')).json();
  assert.equal(ledger.length, 2); assert.equal(ledger[1].id, result.entry.id);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'capital-anchor.json'), 'utf8'));
  assert.equal(saved.withdrawals.length, 2); assert.ok(Math.abs(saved.sol.solBalance - .002) < 1e-12);
  assert.equal(application.runtime.snapshot().events.filter(e => e.type === 'TradeResult' || e.type === 'ExecutionIntent').length, 0);
  await service.close(); restored = createApplication(options);
  assert.deepEqual(restored.paperWithdrawals(), ledger);
  assert.ok(Math.abs(restored.runtime.solAnchor().solBalance - .002) < 1e-12);
  assert.equal(restored.runtime.snapshot().events.filter(e => e.source === 'paper.withdraw').length, 2);
  await restored.selectNetwork('BSC'); await assert.rejects(restored.withdrawPaperSol(.001), { status: 400 });
  await restored.selectNetwork('SOLANA'); await restored.disconnect(); await assert.rejects(restored.withdrawPaperSol(.001), { status: 400 });
  const html = fs.readFileSync(path.join(__dirname, '../public/meme-trader/index.html'), 'utf8');
  assert.match(html, /id="trading-amount"/); assert.match(html, /Xác nhận rút SOL/); assert.doesNotMatch(html, /paper|mô phỏng/i);
});
test('paper withdrawal write failure leaves balance and ledger intact; tolerance cannot repeatedly drain an empty wallet', t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-atomic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const anchor = require('../runtime/capital-ledger.cjs').createCapitalAnchor(path.join(dir, 'test.jsonl'), 20);
  anchor.add(funding(20)); anchor.checkpoint();
  const filename = path.join(dir, 'capital-anchor.json'), before = fs.readFileSync(filename, 'utf8');
  const input = { amountSol: .004, toWallet: 'main-wallet', at, epoch: 1 };
  const rename = fs.renameSync;
  try {
    fs.renameSync = () => { throw Error('TEST_WRITE_FAILURE'); };
    assert.throws(() => anchor.withdraw(input), /TEST_WRITE_FAILURE/);
  } finally { fs.renameSync = rename; }
  assert.equal(anchor.sol().solBalance, .01); assert.deepEqual(anchor.withdrawals(), []);
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
  anchor.withdraw({ ...input, amountSol: .01 + 0.5e-9 });
  assert.ok(anchor.sol().solBalance < 0 && anchor.sol().solBalance > -1e-9);
  assert.throws(() => anchor.withdraw({ ...input, amountSol: 0.5e-9 }), { status: 400 });
  assert.equal(anchor.withdrawals().length, 1);
});

test('wallet-funded portfolio and dashboard use $20, never the default $10000, and reject stale capital', async t => {
  let clock = new Date(at); const now = () => clock, runtime = createRuntime({ now }); t.after(() => runtime.close());
  const store = createTradeStore({ runtime, now, capitalUsd: 0, walletFunded: true });
  const adapter = createDashboardAdapter({ runtime, tradeStore: store, now }); t.after(() => adapter.close());
  assert.equal(store.snapshot().performance.equity, null); assert.equal(adapter.snapshot().summary.budgetUsd, null);
  runtime.publish(funding(20));
  assert.equal(store.snapshot().performance.equity, 20); assert.equal(store.snapshot().performance.cash, 20); assert.equal(adapter.snapshot().summary.budgetUsd, 20);
  runtime.publish(funding(10, 'funding-2'));
  assert.equal(store.snapshot().performance.equity, 10); assert.equal(store.snapshot().performance.cash, 10);
  assert.equal(store.snapshot().performance.realizedPnl, 0);
  clock = new Date(Date.parse(at) + 901000); // Existing funding freshness is 15 minutes.
  assert.equal(store.snapshot().performance.equity, null); assert.equal(adapter.snapshot().summary.budgetUsd, null);
});
test('wallet funding cannot leak across network epochs or rejected account sessions', async t => {
  const now = () => new Date(at), runtime = createRuntime({ now }); t.after(() => runtime.close());
  const store = createTradeStore({ runtime, now, walletFunded: true, fundingAllowed: () => false });
  runtime.publish(funding(20)); assert.equal(store.snapshot().performance.equity, null);
  runtime.selectNetwork('BSC'); assert.equal(store.snapshot().performance.budgetUsd, null);
});
test('valuation multiplies verified native quantity by fresh USD price and rejects stale or unavailable quotes', async () => {
  const balances = { async read() { return { status: 'OBSERVED', amount: '0.010000000000000000', symbol: 'ETH', observedAt: at }; } };
  const fetcher = async () => new Response(JSON.stringify([{price:'2000.00',time:'2026-09-24T10:00:00.000001Z',trade_id:1}]));
  const reader = createValuationReader({ balances, fetcher, now: () => new Date(at) });
  const v = await reader.read({network:'ROBINHOOD',address:'public-account'}); assert.equal(v.payload.valueUsd,20);
  assert.equal(v.payload.priceAt, at);
  await assert.rejects(createValuationReader({ balances, fetcher, now: () => new Date(Date.parse(at)+61000) }).read({network:'ROBINHOOD',address:'public-account'}), /STALE/);
});
test('production scanner starts despite unavailable valuation without inventing trading capital', async t => {
  // This test injects its market provider; live websocket acquisition is unrelated.
  const onchain = process.env.ONCHAIN_DISCOVERY_ENABLED;
  process.env.ONCHAIN_DISCOVERY_ENABLED = 'false';
  t.after(() => { if (onchain === undefined) delete process.env.ONCHAIN_DISCOVERY_ENABLED; else process.env.ONCHAIN_DISCOVERY_ENABLED = onchain; });
  const { createApplication } = require('../runtime/application.cjs');
  const { createHash } = require('node:crypto');
  const session = { network: 'SOLANA', chainId: 'mainnet-beta', address: 'So11111111111111111111111111111111111111112', provider: 'protocol-test' };
  let fail = false, count = 0;
  const app = createApplication({ liveConfig: { root: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'wallet-test-')), env: {} }, now: () => new Date(at), providers: { SOLANA: { network:'SOLANA', async discover(){return [];}, async snapshot(){throw Error('UNEXPECTED');} } }, valuationReader: { async read(s) {
    if (fail) throw Error('quote unavailable');
    const e = funding(20, 'funding-' + ++count);
    return { ...e, payload: { ...e.payload, accountHash: createHash('sha256').update(s.network + ':' + s.address).digest('hex') } };
  } } });
  t.after(() => app.close());
  await app.connect(session); assert.equal(app.tradeStore.snapshot().performance.budgetUsd, 20);
  await app.start(); assert.equal(app.control().running, true); await app.stop();
  fail = true; await app.start();
  assert.equal(app.control().running, true);
  // The bounded funding retry delays the verdict a few seconds before surfacing it.
  let saw = null;
  for (let i = 0; i < 100 && !saw; i++) { saw = app.control().fundingError; if (!saw) await new Promise(resolve => setTimeout(resolve, 250)); }
  assert.equal(saw, 'WALLET_CAPITAL_UNVERIFIED');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(app.control().lastScan.status, 'COMPLETED');
  assert.equal(app.tradeStore.snapshot().performance.equity, null);
  assert.equal(app.tradeStore.snapshot().performance.cash, 0);
  assert.equal(app.runtime.snapshot().events.filter(e => e.type === 'TradeResult').length, 0);
});
