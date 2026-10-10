'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createHash } = require('node:crypto');
const nacl = require('tweetnacl'), bs58 = require('bs58');
const { VersionedTransaction, TransactionMessage, TransactionInstruction, PublicKey, SystemProgram } = require('@solana/web3.js');
const { createRuntime } = require('../runtime/events/bus.cjs');
const { createTradeStore } = require('../core/trades/store.cjs');
const { createLiveExecution } = require('../core/execution/live.cjs');
const { createPaperExecution } = require('../core/execution/paper.cjs');
const { validateEvent } = require('../runtime/contracts/index.cjs');
const stamp = '2026-10-05T10:00:00.000Z', now = () => new Date(stamp);
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', TOKEN2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const realCommander = require('../services/commander/service.cjs').createCommander;
let manualFixture = false;
for (const route of ['jupiter', 'pumpfun', 'jupiter-partial']) test('manual live BUY and stale low-liquidity Token-2022 SELL through HTTP: ' + route, async t => {
  // Isolate operator requests from autonomous decisions; retain real risk/safety/execution.
  t.mock.method(require('../services/commander/service.cjs'), 'createCommander', inputs => manualFixture ? { start() {}, stop() {} } : realCommander(inputs));
  t.mock.method(require('../core/risk/exit-manager.cjs'), 'createExitManager', () => ({ start() {}, stop() {} }));
  let x;
  manualFixture = true;
  try { x = await setup(t, { application: true, balanceLamports: 1963000000, swapTokenProgram: TOKEN2022, env: { TRADING_MAX_POSITION_USD: '1' },
    dynamicHolding: route === 'jupiter-partial', tokenProgram: TOKEN2022, tokenBalances: { [TOKEN2022]: ['1000000'] }, ...(route === 'pumpfun' ? { noRoute: true, pump: true } : {}) }); }
  finally { manualFixture = false; }
  const app = x.application;
  await assert.rejects(app.buyLive({ token: x.token, execute: true }), /LIVE_NOT_ARMED/);
  await app.live('LIVE_REAL_MONEY');
  while (!app.control().lastScan) await new Promise(resolve => setTimeout(resolve, 5));
  const publish = (id, type, producer, payload) => x.runtime.publish({ id, type, producer, payload, timestamp: stamp, source: 'manual.test', evidence: ['test'], status: 'OBSERVED', correlationId: id, network: 'SOLANA', epoch: x.runtime.status().epoch, confidence: .9, evidence_quality: .9, uncertainty: .1, missing_evidence: [] });
  publish('manual-quote', 'MarketSnapshot', 'MARKET_DATA', { token: x.token, price: 1, liquidityUsd: 100000, volume24hUsd: 1000, poolAgeMs: 120000, marketCapUsd: 10000, observedAt: stamp });
  publish('manual-regime', 'MarketRegimeState', 'MARKET_DATA', { regime: 'TRENDING', snapshotIds: ['manual-quote'], reason: 'test' });
  await x.runtime.flush();
  publish('manual-candidate', 'TokenCandidate', 'JEV', { token: x.token, symbol: 'TEST', snapshotId: 'manual-quote', liquidityUsd: 100000, volume24hUsd: 1000, rank: 1, anomalies: ['TOKEN_DISCOVERY', 'REAL_VOLUME'] });
  await x.runtime.flush();
  const service = require('../scripts/serve-meme-trader.cjs').createDashboardServer({ application: { ...app, close: async () => {} }, now, copyPath: null, copyWatch: false });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(() => service.close());
  const post = async body => {
    const response = await fetch('http://127.0.0.1:' + service.server.address().port + '/api/orders/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const buy = await post({ side: 'BUY', token: x.token, execute: true });
  assert.equal(buy.status, 200, buy.body.reason ?? buy.body.error);
  assert.equal(buy.body.status, 'FILLED');
  assert.equal(x.runtime.get(buy.body.fillId).payload.mode, 'live');
  assert.equal(x.runtime.get(buy.body.intentId).payload.quantity, 1);
  const trade = app.tradeStore.snapshot().trades.find(row => row.id === buy.body.fillId);
  assert.ok(trade);
  await assert.rejects(app.sellLive({ tradeId: trade.id, percent: 0, execute: true }), /INVALID_LIVE_EXIT_REQUEST/);
  await assert.rejects(app.sellLive({ tradeId: 'missing', percent: 100, execute: true }), /OPEN_POSITION_NOT_FOUND/);
  publish('manual-thin-quote', 'MarketSnapshot', 'MARKET_DATA', { token: x.token, price: 1, liquidityUsd: 1, volume24hUsd: 1000, poolAgeMs: 120000, marketCapUsd: 10000, observedAt: stamp });
  await x.runtime.flush();
  x.advance(4 * 60 * 60 * 1000);
  await app.tradingBalance();
  const currentStamp = x.runtime.snapshot().events.findLast(e => e.type === 'WalletValuation').timestamp;
  const buyDecision = x.runtime.get(buy.body.decisionId);
  x.runtime.publish({ ...buyDecision, id: 'autonomous-stale-exit', correlationId: 'autonomous-stale-exit', timestamp: currentStamp, source: 'commander.autonomous',
    payload: { ...buyDecision.payload, snapshotId: 'manual-thin-quote', action: 'SELL', disposition: 'EXIT' } });
  await x.runtime.flush();
  const staleRisk = x.runtime.snapshot().events.find(e => e.type === 'RiskDecision' && e.payload.decisionId === 'autonomous-stale-exit');
  assert.equal(staleRisk.status, 'REJECTED');
  assert.equal(staleRisk.payload.reason, 'VETO: price evidence missing, stale or unreliable.');
  assert.equal(x.sent(), 1);
  const exitSafety = x.runtime.snapshot().events.findLast(e => e.type === 'SafetyDecision' && e.payload.candidateId === 'manual-candidate');
  x.runtime.publish({ ...exitSafety, id: 'manual-exit-veto', timestamp: currentStamp, status: 'REJECTED', payload: { ...exitSafety.payload, approved: false, reason: 'Test safety veto' } });
  const blockedExit = await post({ side: 'SELL', tradeId: trade.id, percent: 100, execute: true });
  assert.equal(blockedExit.body.status, 'REJECTED');
  assert.equal(blockedExit.body.reason, 'LIVE_SAFETY_REJECTED');
  assert.equal(x.sent(), 1);
  x.runtime.publish({ ...exitSafety, id: 'manual-exit-safe', timestamp: currentStamp });
  // Let the rejected intent's reservation expire without changing the journal quote.
  x.advance(61000);
  await app.tradingBalance();
  if (route === 'jupiter-partial') {
    const partial = await post({ side: 'SELL', tradeId: trade.id, percent: 50, execute: true });
    assert.equal(partial.body.status, 'FILLED', partial.body.reason);
    assert.equal(partial.body.quantity, .5);
    assert.equal(app.tradeStore.snapshot().positions[0].quantity, .5);
    assert.equal(app.tradeStore.snapshot().trades.find(t => t.id === trade.id).quantity, 1);
    const secondPartial = await post({ side: 'SELL', tradeId: trade.id, percent: 50, execute: true });
    assert.equal(secondPartial.body.status, 'FILLED', secondPartial.body.reason);
    assert.equal(secondPartial.body.quantity, .25);
    assert.equal(app.tradeStore.snapshot().positions[0].quantity, .25);
  }
  const sell = await post({ side: 'SELL', tradeId: trade.id, percent: 100, execute: true });
  assert.equal(sell.status, 200, sell.body.reason ?? sell.body.error);
  assert.equal(sell.body.status, 'FILLED');
  assert.equal(sell.body.quantity, route === 'jupiter-partial' ? .25 : buy.body.quantity);
  assert.equal(x.runtime.get(sell.body.intentId).payload.quantity, sell.body.quantity);
  assert.equal(x.runtime.get(sell.body.fillId).payload.mode, 'live');
  assert.equal(x.runtime.get(sell.body.fillId).payload.exitPrice, route === 'jupiter-partial' ? 2.4 : .6);
  const sellIntent = x.runtime.get(sell.body.intentId);
  assert.equal(x.runtime.get(sellIntent.payload.riskDecisionId).status, 'APPROVED');
  assert.equal(sellIntent.payload.snapshotId, 'manual-thin-quote');
  assert.equal(app.tradeStore.snapshot().positions.length, 0);
  assert.equal(x.sent(), route === 'jupiter-partial' ? 4 : 2);
  const freshQuote = x.runtime.get('manual-quote');
  x.runtime.publish({ ...freshQuote, id: 'manual-fresh-quote', timestamp: currentStamp, payload: { ...freshQuote.payload, observedAt: currentStamp } });
  const safety = x.runtime.snapshot().events.findLast(e => e.type === 'SafetyDecision' && e.payload.candidateId === 'manual-candidate');
  x.runtime.publish({ ...safety, id: 'manual-veto', status: 'REJECTED', payload: { ...safety.payload, approved: false, reason: 'Test safety veto' } });
  const veto = await app.buyLive({ token: x.token, execute: true });
  assert.equal(veto.status, 'REJECTED'); assert.equal(veto.reason, 'LIVE_SAFETY_REJECTED');
  assert.equal(x.sent(), route === 'jupiter-partial' ? 4 : 2);
  await app.disarm();
  await assert.rejects(app.sellLive({ tradeId: trade.id, percent: 100, execute: true }), /LIVE_NOT_ARMED/);
  await assert.rejects(app.buyLive({ token: x.token, execute: true }), /LIVE_NOT_ARMED/);
  const locked = await post({ side: 'BUY', token: x.token, execute: true });
  assert.equal(locked.status, 409); assert.equal(locked.body.error, 'LIVE_NOT_ARMED');
});
test('CAP fields identifies overflow of finite positive intent inputs', async t => {
  const x = await setup(t, { referencePrice: 1e308, maxExposureUsd: 2 });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent('overflow', 1e308); await x.runtime.flush();
  const message = x.messages().find(m => m.startsWith('LIVE_POSITION_CAP_FIELDS:'));
  assert.ok(message, x.messages().join(','));
  assert.equal(JSON.parse(message.slice(message.indexOf(':') + 1)).requestedBudget, 'Infinity');
  assert.equal(x.sent(), 0);
});
test('CAP size identifies division underflow before decimals are read', async t => {
  const x = await setup(t, { maxExposureUsd: 1e-300, quotePrice: 1e100 });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent('underflow'); await x.runtime.flush();
  const message = x.messages().find(m => m.startsWith('LIVE_POSITION_CAP_SIZE:'));
  assert.ok(message, x.messages().join(','));
  assert.equal(JSON.parse(message.slice(message.indexOf(':') + 1)).stage, 'division');
  assert.equal(x.calls.includes('getTokenSupply'), false); assert.equal(x.sent(), 0);
});
test('CAP decimals floor identifies SIZE with sanitized numeric evidence', async t => {
  const x = await setup(t, { tokenDecimals: 0, quotePrice: 3, maxExposureUsd: 2, riskQuantity: 2 });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent('floor', 2); await x.runtime.flush();
  const message = x.messages().find(m => m.startsWith('LIVE_POSITION_CAP_SIZE:'));
  assert.ok(message, x.messages().join(','));
  const detail = JSON.parse(message.slice(message.indexOf(':') + 1));
  assert.equal(detail.stage, 'decimals-floor'); assert.equal(detail.quantityBeforeFloor, 2 / 3);
  assert.equal(detail.orderQuantity, 0); assert.equal(detail.decimals, 0); assert.equal(x.sent(), 0);
  validateEvent(x.runtime.snapshot().events.find(e => e.payload.message === message), { now });
});
test('CAP balance identifies simulated spend overrun despite matching risk budget', async t => {
  const x = await setup(t, { excessSpend: true, maxExposureUsd: 2, riskQuantity: 2 });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent('balance', 2); await x.runtime.flush();
  const message = x.messages().find(m => m.startsWith('LIVE_POSITION_CAP_BALANCE:'));
  assert.ok(message, x.messages().join(','));
  const detail = JSON.parse(message.slice(message.indexOf(':') + 1));
  assert.equal(detail.requestedBudget, 2); assert.equal(detail.maxExposureUsd, 2);
  assert.ok(Math.abs(detail.spendUsd - 4.0005) < 1e-12); assert.ok(detail.spendUsd > detail.allowedSpendUsd); assert.equal(x.sent(), 0);
});
for (const route of ['jupiter', 'pumpfun']) for (const tokenDecimals of [2, 6]) test(`${route} thin pool reduces 20% overrun once after decimals=${tokenDecimals} and fills`, async t => {
  const budget = route === 'pumpfun' ? 2 : .63, allowed = budget * 1.05;
  const x = await setup(t, { maxExposureUsd: budget, riskQuantity: budget, tokenDecimals, impact: { allowed, factor: 1.2 }, ...(route === 'pumpfun' ? { noRoute: true, pump: true, receivedTokenAmount: '2000000' } : { sizedReceipt: true }) });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent('impact', budget); await x.runtime.flush();
  assert.equal(x.sent(), 1, x.messages().join(',')); assert.equal(x.fills().length, 1);
  assert.equal(x.calls.filter(c => c === 'simulateTransaction').length, 2);
  assert.equal(x.calls.filter(c => c === 'getTokenSupply').length, 1);
  const message = x.messages().find(m => m.startsWith('giảm size theo impact:'));
  assert.ok(message, x.messages().join(','));
  const detail = JSON.parse(message.slice(message.indexOf('; ') + 2));
  assert.ok(detail.reducedTo < detail.reducedFrom);
  assert.ok(Math.abs(detail.reducedTo - detail.reducedFrom * (detail.allowedSpendUsd - detail.fixedOverheadUsd) / (detail.preReductionSpendUsd - detail.fixedOverheadUsd)) < 1e-6);
  assert.ok(detail.preReductionSpendUsd > detail.allowedSpendUsd);
  assert.ok(detail.spendUsd <= allowed);
  const fill = x.fills()[0].payload;
  assert.ok(fill.quantity * fill.entryPrice + fill.fees <= allowed);
  if (route === 'jupiter') {
    assert.equal(x.calls.filter(c => c.endsWith('/swap')).length, 2);
    assert.ok(Math.abs(Number(x.quote().inAmount) / 1e9 * 100 - detail.reducedTo) < 1e-12);
  }
  validateEvent(x.runtime.snapshot().events.find(e => e.payload.message === message), { now });
});
for (const [factor, stuck, simulations] of [[1.6, false, 1], [1.2, true, 2]]) test(`impact ${factor}x allowed, stuck=${stuck}: rejects with bounded simulations`, async t => {
  const x = await setup(t, { maxExposureUsd: .63, impact: { allowed: .63 * 1.05, factor, stuck } });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent('impact-reject', .63); await x.runtime.flush();
  assert.equal(x.sent(), 0); assert.equal(x.fills().length, 0);
  assert.equal(x.calls.filter(c => c === 'simulateTransaction').length, simulations);
  const message = x.messages().find(m => m.startsWith('LIVE_POSITION_CAP_BALANCE:'));
  assert.ok(message, x.messages().join(','));
  const detail = JSON.parse(message.slice(message.indexOf(':') + 1));
  assert.equal(detail.stage, 'simulation-balance'); assert.ok(detail.spendUsd > detail.allowedSpendUsd);
  if (stuck) { assert.ok(detail.reducedFrom > detail.reducedTo); assert.ok(detail.reducedTo > 0); }
  else assert.equal(detail.reducedFrom, undefined);
  assert.equal(x.messages().some(m => m.startsWith('giảm size theo impact:')), false);
});
for (const [pump, cause] of [['missing', 'BondingCurve.account-missing'], ['wrong-owner', 'BondingCurve.owner-mismatch'], ['complete', 'BondingCurve.complete']]) test('pump cause reaches activity: ' + cause, async t => {
  const x = await setup(t, { noRoute: true, pump });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  assert.ok(x.messages().some(m => m.includes('LIVE_PUMPFUN_UNAVAILABLE: ' + cause)), x.messages().join(','));
  assert.equal(x.sent(), 0);
});
async function setup(t, options = {}) {
  let stamp = '2026-10-05T10:00:00.000Z';
  const now = () => new Date(stamp);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botmeme-live-'));
  const pair = nacl.sign.keyPair(), owner = bs58.encode(pair.publicKey), token = bs58.encode(nacl.sign.keyPair().publicKey);
  const keyFile = path.join(root, 'wallet-key.env');
  if (!options.missing) fs.writeFileSync(keyFile, 'TRADING_PRIVATE_KEY=' + bs58.encode(pair.secretKey));
  let runtime, tradeStore, application;
  const calls = [], rpcCalls = [], transactions = [], pumpReads = []; let balance = options.balanceLamports ?? 196300000, withdrawn = null, statusPolls = 0;
  let quote, signature, side = 'BUY', engine, sent = 0, pumpSpend, initialImpactAmount, impactSpend, holding = 0n;
  const envelope = (id, type, producer, payload, status = 'OBSERVED') => ({ id, type, producer, payload, timestamp: stamp, source: 'live.test', evidence: ['test'], status, correlationId: 'case', network: 'SOLANA', epoch: runtime.status().epoch, confidence: .9, evidence_quality: .9, uncertainty: .1, missing_evidence: [] });
  const response = result => new Response(JSON.stringify(result), { status: 200 });
  const fetcher = async (url, init) => {
    const u = new URL(url); calls.push(u.pathname);
    if (u.pathname.endsWith('/quote') || u.pathname.endsWith('/swap')) {
      assert.equal(u.origin, options.env?.JUPITER_API_KEY ? 'https://api.jup.ag' : 'https://lite-api.jup.ag');
      assert.equal(init.headers['x-api-key'], options.env?.JUPITER_API_KEY);
    }
    if (u.pathname.endsWith('/quote')) {
      await options.quoteWait?.();
      if (options.quoteTimeout) await new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
      if (options.quoteFailure) return new Response('rate limited', { status: 429 });
      if (options.quoteResponse) return options.quoteResponse();
      side = u.searchParams.get('inputMint') === token ? 'SELL' : 'BUY';
      quote = { inputMint: u.searchParams.get('inputMint'), outputMint: u.searchParams.get('outputMint'), inAmount: u.searchParams.get('amount'), outAmount: side === 'BUY' ? '1000000' : '6000000', slippageBps: 100, swapMode: 'ExactIn' };
      if (options.sizedReceipt && side === 'BUY') quote.outAmount = String(Math.floor(Number(quote.inAmount) / 1e9 * 100 / (options.quotePrice ?? 1) * 10 ** (options.tokenDecimals ?? 6)));
      assert.equal(u.searchParams.get('slippageBps'), '100');
      if (options.noRoute) return options.noRoute === 'empty' ? response({ ...quote, routePlan: [] }) : options.noRoute === 'code' ? response({ errorCode: 'TOKEN_NOT_TRADABLE' }) : new Response('{"error":"TOKEN_NOT_TRADABLE"}', { status: 400 });
      return response(quote);
    }
    if (u.pathname.endsWith('/swap')) {
      assert.deepEqual(JSON.parse(init.body).quoteResponse, quote);
      assert.deepEqual(JSON.parse(init.body).prioritizationFeeLamports, { priorityLevelWithMaxLamports: { priorityLevel: 'veryHigh', maxLamports: 200000 } });
      if (options.killDuringSwap) fs.writeFileSync(path.join(root, 'LIVE_KILL'), '');
      if (options.stopDuringSwap) engine.stop();
      if (options.remoteSecret) throw Error(fs.readFileSync(keyFile, 'utf8'));
      if (options.swapResponse) return options.swapResponse();
      const instructions = [SystemProgram.transfer({ fromPubkey: new PublicKey(owner), toPubkey: new PublicKey(token), lamports: 1 })];
      if (options.swapTokenProgram) instructions.push(new TransactionInstruction({ programId: new PublicKey(options.swapTokenProgram), keys: [{ pubkey: new PublicKey(token), isWritable: false, isSigner: false }], data: Buffer.from([21]) }));
      const message = new TransactionMessage({ payerKey: new PublicKey(owner), recentBlockhash: PublicKey.default.toBase58(), instructions }).compileToV0Message();
      return response({ swapTransaction: Buffer.from(new VersionedTransaction(message).serialize()).toString('base64') });
    }
    const { method, params } = JSON.parse(init.body); calls.push(method);
    rpcCalls.push({ url: String(url), method, params });
    const override = await options.rpcResponse?.(String(url), method, params, init);
    if (override !== undefined) return override;
    let result;
    if (method === 'getGenesisHash') result = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
    else if (method === 'getBalance') result = { value: options.zeroBalance ? 0 : options.lowBalance ? 10001000 : balance };
    else if (method === 'getFeeForMessage') result = { value: 5000 };
    else if (method === 'getLatestBlockhash') result = { value: { blockhash: PublicKey.default.toBase58() } };
    else if (method === 'getTokenSupply') result = { value: { decimals: options.tokenDecimals ?? 6 } };
    else if (method === 'getAccountInfo') {
      const program = require('../core/execution/pumpfun.cjs').PROGRAM;
      const pda = name => PublicKey.findProgramAddressSync([Buffer.from(name)], program)[0].toBase58();
      const curve = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(token).toBuffer()], program)[0].toBase58();
      pumpReads.push(params[0]);
      if (!options.pump || options.pump === 'missing') result = { value: null };
      else {
        let bytes, accountOwner = program.toBase58();
        const account = (name, size) => { const b = Buffer.alloc(size); createHash('sha256').update('account:' + name).digest().copy(b, 0, 0, 8); return b; };
        if (params[0] === curve) {
          bytes = account('BondingCurve', 151); bytes.writeBigUInt64LE(5000000n, 8); bytes.writeBigUInt64LE(30000000n, 16); bytes.writeBigUInt64LE(4000000n, 24); bytes.writeBigUInt64LE(20000000n, 32); bytes.writeBigUInt64LE(10000000n, 40);
          new PublicKey(owner).toBuffer().copy(bytes, 49);
          if (options.pump === 'complete') bytes[48] = 1;
          if (options.pump === 'wrong-owner') accountOwner = SystemProgram.programId.toBase58();
        } else if (params[0] === pda('global')) {
          bytes = account('Global', 162); new PublicKey(options.feeRecipient ?? owner).toBuffer().copy(bytes, 41); bytes.writeBigUInt64LE(100n, 105); bytes.writeBigUInt64LE(50n, 154);
        } else if (params[0] === token) {
          bytes = Buffer.alloc(82); bytes[44] = options.tokenDecimals ?? 6; bytes[45] = 1; accountOwner = options.tokenProgram ?? TOKEN;
        } else {
          bytes = account('FeeConfig', 109); bytes.writeUInt32LE(1, 65); bytes.writeBigUInt64LE(100n, 93); bytes.writeBigUInt64LE(50n, 101); accountOwner = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
        }
        result = { value: { owner: accountOwner, data: [bytes.toString('base64'), 'base64'] } };
      }
    }
    else if (method === 'getTokenAccountsByOwner') {
      const programId = params[1].programId;
      assert.ok([TOKEN, TOKEN2022].includes(programId));
      const balances = options.dynamicHolding ? { [options.tokenProgram ?? TOKEN]: [String(holding)] } : options.tokenBalances ?? { [options.tokenProgram ?? TOKEN]: ['1000000'] };
      const account = (mint, amount) => ({ account: { owner: programId, data: { parsed: { info: { mint, tokenAmount: { amount, decimals: 6, uiAmount: Number(amount) / 1e6, uiAmountString: String(Number(amount) / 1e6) }, ...(programId === TOKEN2022 ? { extensions: [{ extension: 'transferFeeAmount', state: { withheldAmount: '12345' } }] } : {}) } } } } });
      result = { value: (balances[programId] ?? []).map(amount => account(token, amount)) };
      if (options.unrelatedTokenBalance) result.value.push(account(PublicKey.default.toBase58(), '99000000'));
    }
    else if (method === 'simulateTransaction') {
      if (options.pump && pumpReads.length) {
        const tx = VersionedTransaction.deserialize(Buffer.from(params[0], 'base64'));
        const ix = tx.message.compiledInstructions.at(-1);
        side = Buffer.from(ix.data).subarray(0, 8).equals(createHash('sha256').update('global:sell').digest().subarray(0, 8)) ? 'SELL' : 'BUY';
        pumpSpend = Number(Buffer.from(ix.data).readBigUInt64LE(8)) + (options.pumpRent ?? 0);
      }
      result = { value: { err: null, accounts: [{ lamports: side === 'BUY' ? options.excessSpend ? balance - 40000000 : balance - (pumpSpend ?? Number(quote.inAmount)) - 5000 : balance + 6000000 - 5000 }] } };
      if (options.impact && side === 'BUY') {
        const amount = pumpSpend ?? Number(quote.inAmount);
        initialImpactAmount ??= amount;
        // Price impact decreases with size; stuck models a fixed cost that cannot fit.
        const ratio = options.impact.stuck ? 1 : (amount / initialImpactAmount) ** 2;
        impactSpend = Math.round(options.impact.allowed * options.impact.factor * ratio / 100 * 1e9);
        result.value.accounts[0].lamports = balance - impactSpend + 5000;
      }
    }
    else if (method === 'sendTransaction') {
      const tx = VersionedTransaction.deserialize(Buffer.from(params[0], 'base64'));
      transactions.push(tx);
      assert.equal(nacl.sign.detached.verify(tx.message.serialize(), tx.signatures[0], pair.publicKey), true);
      assert.equal(params[1].skipPreflight, false); assert.equal(params[1].maxRetries, 10); sent++;
      signature = bs58.encode(tx.signatures[0]); result = signature;
      await options.sendWait?.();
      if (options.withdraw) {
        const ix = tx.message.compiledInstructions[0];
        assert.equal(tx.message.staticAccountKeys[ix.programIdIndex].toBase58(), SystemProgram.programId.toBase58());
        assert.equal(Buffer.from(ix.data).readUInt32LE(), 2);
        withdrawn = Number(Buffer.from(ix.data).readBigUInt64LE(4));
      }
      if (options.sendUnknown) throw Error('transport lost');
    } else if (method === 'getSignatureStatuses') {
      assert.deepEqual(params[1], { searchTransactionHistory: true });
      statusPolls++;
      if (options.statusSequence) {
        const status = options.statusSequence[Math.min(statusPolls - 1, options.statusSequence.length - 1)];
        if (status instanceof Error) throw status;
        return response({ result: { value: [status] } });
      }
      if (options.statusError) return response({ error: { message: 'unavailable' } });
      result = options.statusMalformed ? {} : { value: [Object.hasOwn(options, 'signatureStatus') ? options.signatureStatus : { confirmationStatus: 'confirmed', err: null }] };
    }
    else if (method === 'getTransaction') {
      if (options.withdraw) {
        const before = balance; balance -= withdrawn + 5000;
        return response({ result: { meta: { err: null, fee: 5000, preBalances: [before], postBalances: [balance] } } });
      }
      const tokens = [{ owner, mint: token, uiTokenAmount: { amount: options.shortFill ? '1' : options.sizedReceipt ? quote.outAmount : options.receivedTokenAmount ?? '1000000', decimals: options.tokenDecimals ?? 6 } }];
      result = { meta: { err: null, fee: 5000, preBalances: [balance], postBalances: [side === 'BUY' ? balance - (pumpSpend ?? Number(quote.inAmount)) - 5000 : balance + (options.shortSell ? 1 : 6000000) - 5000], preTokenBalances: side === 'BUY' ? [] : tokens, postTokenBalances: side === 'BUY' ? tokens : [] } };
      if (options.dynamicHolding) {
        const tokenRows = amount => [{ owner, mint: token, uiTokenAmount: { amount: String(amount), decimals: 6 } }];
        result.meta.preTokenBalances = tokenRows(holding);
        holding += side === 'BUY' ? BigInt(quote.outAmount) : -BigInt(quote.inAmount);
        result.meta.postTokenBalances = tokenRows(holding);
      }
      if (impactSpend !== undefined && side === 'BUY') result.meta.postBalances[0] = balance - impactSpend + 5000;
    } else throw Error('Unexpected mock method: ' + method);
    return response({ jsonrpc: '2.0', id: 1, result });
  };
  const config = { root, owner, fetcher, rpcUrl: 'https://rpc.test', env: options.env ?? {}, pollMs: 0 };
  if (options.wrapFetcher) config.fetcher = options.wrapFetcher(fetcher, { owner, response });
  if (options.application) {
    application = require('../runtime/application.cjs').createApplication({ now, liveConfig: config, discoveryConfig: { env: { ONCHAIN_DISCOVERY_ENABLED: 'false' } }, safetyReaders: { SOLANA: { read: async () => (await options.safetyWait?.(), { mintAuthorityRevoked: true, freezeAuthorityRevoked: true, maxLpLockedPct: 85, top10HolderPct: 25, insiderHolderPct: 5, scoreNormalised: 10 }) } }, providers: { SOLANA: { network: 'SOLANA', discover: async () => options.sweep ? [token] : [], profile: () => ({ born: +now() - 29 * 60000 }), snapshot: async () => ({ token, price: 1, liquidityUsd: options.liquidity ?? 10, volume24hUsd: 1000, poolAgeMs: 29 * 60000, marketCapUsd: 10000, observedAt: stamp, source: 'mock-gecko#pool-price', evidence: ['mock-pool-receipt'], confidence: .9, evidence_quality: .9, uncertainty: .1, missing_evidence: [] }) } }, valuationReader: { read: async session => ({ id: 'app-valuation', timestamp: stamp, source: 'test', evidence: ['test'], payload: { amount: '0.1963', symbol: 'SOL', balanceAt: stamp, priceAt: stamp, priceUsd: 100, valueUsd: 19.63, accountHash: createHash('sha256').update('SOLANA:' + session.address).digest('hex') } }) } });
    runtime = application.runtime; tradeStore = application.tradeStore;
  } else { runtime = createRuntime({ now }); tradeStore = createTradeStore({ runtime, now, capitalUsd: 100 }); }
  const engines = [];
  const create = () => { const instance = createLiveExecution({ runtime, tradeStore, now, config }); engines.push(instance); return instance; }; engine = create();
  const flush = runtime.flush;
  runtime.flush = async () => { await flush(); await engine.drain(); await flush(); };
  t.after(async () => { for (const instance of engines) { instance.stop(); await instance.drain(); } if (application) await application.close(); else await runtime.close(); pair.secretKey.fill(0); fs.rmSync(root, { recursive: true, force: true }); });
  runtime.publish(envelope('valuation', 'WalletValuation', 'RUNTIME', { amount: '0.1963', symbol: 'SOL', balanceAt: stamp, priceAt: stamp, priceUsd: 100, valueUsd: 19.63, accountHash: createHash('sha256').update('SOLANA:' + owner).digest('hex') }));
  function intent(name = 'buy', quantity = 1, action = 'BUY', mode = 'live', mint = token) {
    const token = mint;
    side = action;
    const ids = key => name + '/' + key;
    runtime.publish(envelope(ids('quote'), 'MarketSnapshot', 'MARKET_DATA', { token, price: options.quotePrice ?? 1, liquidityUsd: options.liquidity ?? 100000, volume24hUsd: 1000, poolAgeMs: options.poolAgeMs ?? 120000, marketCapUsd: 10000, observedAt: stamp }));
    runtime.publish(envelope(ids('candidate'), 'TokenCandidate', 'JEV', { token, symbol: 'TEST', snapshotId: ids('quote'), liquidityUsd: options.liquidity ?? 100000, volume24hUsd: 1000, rank: 1, anomalies: [] }));
    runtime.publish(envelope(ids('regime'), 'MarketRegimeState', 'MARKET_DATA', { regime: 'TRENDING', snapshotIds: [ids('quote')], reason: 'test' }));
    runtime.publish(envelope(ids('decision'), 'StrategyDecision', 'CODEX_1', { candidateId: ids('candidate'), snapshotId: ids('quote'), signalIds: [], strategyVersion: 'meme-flow-v1', quantEvidenceIds: [], criticReportIds: [], regimeId: ids('regime'), action, disposition: action === 'BUY' ? 'TRADE' : 'EXIT', reason: 'test' }));
    runtime.publish(envelope(ids('risk'), 'RiskDecision', 'RISK_ENGINE', { decisionId: ids('decision'), approved: true, quantity: options.riskQuantity ?? quantity, maxExposureUsd: options.maxExposureUsd ?? 10, reason: 'test' }, 'APPROVED'));
    runtime.publish(envelope(ids('safety'), 'SafetyDecision', 'SAFETY_GATE', { candidateId: ids('candidate'), approved: options.veto !== true, reason: 'test', checks: [] }, options.veto ? 'REJECTED' : 'APPROVED'));
    const e = envelope(ids('intent'), 'ExecutionIntent', 'STRATEGY_ENGINE', { mode, token, candidateId: ids('candidate'), snapshotId: ids('quote'), signalIds: [], strategyVersion: 'meme-flow-v1', decisionId: ids('decision'), riskDecisionId: ids('risk'), action, quantity, referencePrice: options.referencePrice ?? 1 }, 'APPROVED');
    runtime.publish(e); return e;
  }
  const fills = () => runtime.snapshot().events.filter(e => e.type === 'TradeResult');
  const messages = () => runtime.snapshot().events.filter(e => e.producer === 'LIVE_EXECUTION' && e.type === 'AIActivityEvent').map(e => e.payload.message);
  function advance(ms) {
    stamp = new Date(+now() + ms).toISOString();
    const valuation = runtime.get('valuation');
    runtime.publish({ ...valuation, id: 'valuation/' + stamp, timestamp: stamp, payload: { ...valuation.payload, balanceAt: stamp, priceAt: stamp } });
  }
  return { root, runtime, tradeStore, application, engine, config, create, intent, fills, messages, calls, rpcCalls, transactions, pumpReads, advance, token, flushIntake: flush, quote: () => quote, sent: () => sent, signature: () => signature, keyFile };
}

async function throughputSetup(t, options = {}) {
  const sends = [], waiting = new Map(), quotes = new Map(), signed = new Map(), active = new Set();
  let peak = 0, released = false;
  const x = await setup(t, { ...options, wrapFetcher: (base, { owner, response }) => async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/quote')) {
      const inputMint = u.searchParams.get('inputMint'), outputMint = u.searchParams.get('outputMint');
      const buy = inputMint === 'So11111111111111111111111111111111111111112', token = buy ? outputMint : inputMint;
      assert.equal(active.has(token), false, 'same token cannot enter two swaps');
      active.add(token); peak = Math.max(peak, active.size);
      const q = { inputMint, outputMint, inAmount: u.searchParams.get('amount'), outAmount: buy ? '1000000' : '6000000', slippageBps: 100, swapMode: 'ExactIn' };
      quotes.set(token, { q, buy }); return response(q);
    }
    if (u.pathname.endsWith('/swap')) {
      const body = JSON.parse(init.body), q = body.quoteResponse;
      assert.deepEqual(body.prioritizationFeeLamports, { priorityLevelWithMaxLamports: { priorityLevel: 'veryHigh', maxLamports: 200000 } });
      const buy = q.inputMint === 'So11111111111111111111111111111111111111112';
      const tx = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(owner), recentBlockhash: PublicKey.default.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: new PublicKey(owner), toPubkey: new PublicKey(buy ? q.outputMint : q.inputMint), lamports: buy ? 1 : 2 })] }).compileToV0Message());
      return response({ swapTransaction: Buffer.from(tx.serialize()).toString('base64') });
    }
    const { method, params } = JSON.parse(init.body);
    const transactionToken = encoded => {
      const tx = VersionedTransaction.deserialize(Buffer.from(encoded, 'base64'));
      return { tx, token: tx.message.staticAccountKeys[tx.message.compiledInstructions[0].accountKeyIndexes[1]].toBase58() };
    };
    if (method === 'simulateTransaction') {
      const { token } = transactionToken(params[0]), { q, buy } = quotes.get(token);
      const balance = options.balanceLamports ?? 196300000;
      return response({ result: { value: { err: null, accounts: [{ lamports: balance + (buy ? -Number(q.inAmount) : 6000000) - 5000 }] } } });
    }
    if (method === 'sendTransaction') {
      const { tx, token } = transactionToken(params[0]);
      assert.ok(nacl.sign.detached.verify(tx.message.serialize(), tx.signatures[0], new PublicKey(owner).toBytes()));
      const signature = bs58.encode(tx.signatures[0]);
      assert.equal(signed.has(signature), false, 'never broadcast a signed intent twice');
      signed.set(signature, { token, ...quotes.get(token) }); sends.push({ token, signature });
      if (!options.autoRelease && !released) await new Promise(resolve => waiting.set(signature, resolve));
      return response({ result: signature });
    }
    if (method === 'getSignatureStatuses') {
      const unknown = typeof options.unknown === 'function' ? options.unknown(signed.get(params[0][0])) : options.unknown;
      return response({ result: { value: [{ err: null, confirmationStatus: unknown ? 'processed' : 'confirmed' }] } });
    }
    if (method === 'getTransaction') {
      const { token, q, buy } = signed.get(params[0]); active.delete(token);
      const tokens = [{ owner, mint: token, uiTokenAmount: { amount: '1000000', decimals: 6 } }];
      const balance = options.balanceLamports ?? 196300000;
      return response({ result: { meta: { err: null, fee: 5000, preBalances: [balance], postBalances: [balance + (buy ? -Number(q.inAmount) : 6000000) - 5000], preTokenBalances: buy ? [] : tokens, postTokenBalances: buy ? tokens : [] } } });
    }
    return base(url, init);
  } });
  const release = (all = false) => { released ||= all; for (const resolve of waiting.values()) resolve(); waiting.clear(); };
  t.after(release);
  return { ...x, sends, peak: () => peak, release };
}
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) assert.fail('mock execution did not reach the expected barrier'); await new Promise(resolve => setImmediate(resolve)); }
}

for (const regimeName of ['UNKNOWN', 'RANGE']) test('commander journals fresh REAL_VOLUME BUY with five snapshots and an unpriced live holding: ' + regimeName, async t => {
  const x = await setup(t);
  await x.engine.arm('LIVE_REAL_MONEY');
  x.intent('held-buy'); await x.runtime.flush();
  assert.equal(x.fills().length, 1);
  x.advance(31 * 60000);
  await x.engine.refreshBalance();
  const portfolio = x.engine.portfolio();
  assert.equal(portfolio.positions[0].marketValue, null);
  assert.equal(portfolio.performance.unrealizedPnl, null, 'never invent a current mark or PnL');
  assert.equal(portfolio.performance.equity, portfolio.performance.cash, 'unpriced holding contributes zero risk capital');
  const ledger = JSON.parse(fs.readFileSync(path.join(x.root, 'live-state.json')));
  assert.equal(portfolio.performance.maxDrawdown, Math.max(0, (portfolio.performance.capitalUsed - portfolio.performance.realizedPnl) / ledger.initialUsd));

  const { createHunter } = require('../services/jev/hunter.cjs');
  const { createCommander } = require('../services/commander/service.cjs');
  const { buildWorld } = require('../services/commander/world.cjs');
  const { plan } = require('../services/commander/decision.cjs');
  const at = x.engine.status().balanceAt, now = () => new Date(at);
  const store = { snapshot: () => x.engine.portfolio() };
  const hunter = createHunter({ runtime: x.runtime, now });
  const commander = createCommander({ runtime: x.runtime, tradeStore: store, now });
  t.after(() => { hunter.stop(); commander.stop(); });
  hunter.start(); commander.start();
  const token = bs58.encode(nacl.sign.keyPair().publicKey), snapshots = [];
  for (let i = 0; i < 5; i++) {
    const timestamp = new Date(Date.parse(at) - (4 - i) * 10000).toISOString();
    const snapshot = { id: 'fresh-quote-' + i, type: 'MarketSnapshot', producer: 'MARKET_DATA', source: 'commander-live-regression#pool-price',
      timestamp, correlationId: 'fresh', network: 'SOLANA', epoch: 1, evidence: ['quote-receipt-' + i], status: 'OBSERVED',
      confidence: .8, evidence_quality: .8, uncertainty: .2, missing_evidence: [],
      payload: { token, price: .001, liquidityUsd: 3000, volume24hUsd: 1500, poolAgeMs: 120000 + i * 10000, marketCapUsd: 15000, observedAt: timestamp } };
    snapshots.push(snapshot); x.runtime.publish(snapshot); await x.runtime.flush();
  }
  const events = x.runtime.snapshot().events;
  const candidate = events.find(e => e.type === 'TokenCandidate' && e.payload.token === token);
  assert.ok(candidate.payload.anomalies.includes('REAL_VOLUME'));
  assert.ok(candidate.payload.anomalies.includes('TOKEN_DISCOVERY'));
  assert.equal(candidate.payload.snapshotId, snapshots[0].id);
  const signals = events.filter(e => e.type === 'SignalObservation' && e.payload.candidateId === candidate.id);
  assert.equal(signals.length, 5);
  const signal = signals.at(-1), world = buildWorld(x.runtime, store, signal.id);
  assert.equal(world.local.filter(e => e.type === 'MarketSnapshot' && e.payload.token === token).length, 5);
  assert.equal(signal.payload.snapshotId, snapshots[4].id);
  assert.equal(plan(world, candidate, signal, now()).action, 'BUY');
  const decisions = () => x.runtime.snapshot().events.filter(e => e.type === 'StrategyDecision' && e.payload.candidateId === candidate.id);
  assert.equal(decisions().length, 0, 'wait for persisted regime evidence');
  assert.ok(events.some(e => e.type === 'AIActivityEvent' && e.producer === 'CODEX_1' && e.payload.message.includes('journaled 0 decisions; 1 awaiting evidence')));
  const regime = { ...snapshots[4], id: 'fresh-regime', type: 'MarketRegimeState', evidence: snapshots.map(e => e.id),
    confidence: regimeName === 'UNKNOWN' ? 0 : .8, uncertainty: regimeName === 'UNKNOWN' ? 1 : .2,
    status: regimeName === 'UNKNOWN' ? 'CHUA_XAC_MINH' : 'OBSERVED', missing_evidence: regimeName === 'UNKNOWN' ? ['Classification pending.'] : [],
    payload: { regime: regimeName, snapshotIds: snapshots.map(e => e.id), reason: 'Regression classification.' } };
  x.runtime.publish(regime); await x.runtime.flush();
  assert.equal(decisions().length, 1);
  const decision = decisions()[0];
  assert.equal(decision.payload.action, 'BUY'); assert.equal(decision.payload.disposition, 'TRADE');
  assert.equal(decision.payload.strategyVersion, 'meme-flow-v1');
  assert.equal(decision.payload.snapshotId, snapshots[4].id);
  assert.equal(decision.payload.regimeId, regime.id);
  assert.deepEqual(decision.payload.quantEvidenceIds, []);
  assert.deepEqual(decision.payload.criticReportIds, []);
  assert.deepEqual(x.runtime.snapshot().deliveryErrors, []);
  commander.stop(); commander.start(); await x.runtime.flush();
  assert.equal(decisions().length, 1, 'durable replay does not duplicate BUY');

  // Wallet funding evidence stays risk-valid for TRADING_FUNDING_MAX_AGE_MS
  // (default 10 minutes); beyond that capital is still blocked.
  x.advance(600001);
  assert.equal(x.engine.portfolio().performance.equity, null, 'stale wallet funding still blocks capital');
});

test('10-token burst fills in four concurrent waves, including intents older than 60 seconds', async t => {
  const x = await throughputSetup(t); await x.engine.arm('LIVE_REAL_MONEY');
  const tokens = Array.from({ length: 10 }, () => bs58.encode(nacl.sign.keyPair().publicKey));
  for (const [i, token] of tokens.entries()) x.intent('burst-' + i, 1, 'BUY', 'live', token);
  try {
    for (const count of [3, 6, 9, 10]) {
      await until(() => x.sends.length === count);
      const ledger = JSON.parse(fs.readFileSync(path.join(x.root, 'live-state.json')));
      assert.equal([ledger.pending, ...(ledger.pendingOthers ?? [])].filter(Boolean).length, count === 10 ? 1 : 3);
      x.advance(30000); x.release();
    }
    await x.runtime.flush();
    assert.equal(x.peak(), 3); assert.equal(x.fills().length, 10);
    assert.deepEqual(x.sends.map(row => row.token), tokens);
    assert.equal(x.messages().includes('LIVE_INTENT_EXPIRED'), false);
    assert.equal(x.engine.status().pendingSignature, null);
  } finally { x.release(); }
});

test('same-token BUY then SELL serialize while another token progresses', async t => {
  const x = await throughputSetup(t); await x.engine.arm('LIVE_REAL_MONEY');
  const other = bs58.encode(nacl.sign.keyPair().publicKey);
  x.intent('buy'); x.intent('sell', 1, 'SELL'); x.intent('other', 1, 'BUY', 'live', other);
  try {
    await until(() => x.sends.length === 2);
    assert.deepEqual(x.sends.map(row => row.token), [x.token, other]);
    assert.equal(x.fills().length, 0); x.release();
    await until(() => x.sends.length === 3); x.release(); await x.runtime.flush();
    assert.equal(x.peak(), 2);
    assert.deepEqual(x.fills().filter(e => e.payload.token === x.token).map(e => e.payload.side), ['BUY', 'SELL']);
  } finally { x.release(); }
});

test('three unresolved concurrent signatures persist and all reconcile after restart without resending', async t => {
  const options = { unknown: true, autoRelease: true };
  const x = await throughputSetup(t, options); await x.engine.arm('LIVE_REAL_MONEY');
  for (let i = 0; i < 3; i++) x.intent('unknown-' + i, 1, 'BUY', 'live', bs58.encode(nacl.sign.keyPair().publicKey));
  await x.runtime.flush(); x.engine.stop();
  let ledger = JSON.parse(fs.readFileSync(path.join(x.root, 'live-state.json')));
  assert.equal(x.sends.length, 3); assert.equal(ledger.pendingOthers.length, 2);
  const signatures = [ledger.pending, ...ledger.pendingOthers].map(p => p.signature);
  options.unknown = false;
  const next = x.create(); await next.arm('LIVE_REAL_MONEY');
  ledger = JSON.parse(fs.readFileSync(path.join(x.root, 'live-state.json')));
  assert.equal(ledger.pending, null); assert.deepEqual(ledger.pendingOthers, []);
  assert.deepEqual(ledger.reconciliations.map(r => r.pending.signature), signatures);
  assert.equal(x.sends.length, 3);
});

test('successful concurrent fills cannot clear another transaction awaiting reconciliation', async t => {
  const token = bs58.encode(nacl.sign.keyPair().publicKey);
  const x = await throughputSetup(t, { autoRelease: true, unknown: row => row.token === token });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent('unknown', 1, 'BUY', 'live', token);
  for (let i = 0; i < 2; i++) x.intent('ok-' + i, 1, 'BUY', 'live', bs58.encode(nacl.sign.keyPair().publicKey));
  await x.runtime.flush();
  assert.equal(x.fills().length, 2); assert.equal(x.sends.length, 3);
  const ledger = JSON.parse(fs.readFileSync(path.join(x.root, 'live-state.json')));
  assert.equal(ledger.pending.signature, x.sends.find(s => s.token === token).signature);
  assert.deepEqual(ledger.pendingOthers, []);
  x.intent('blocked'); await x.runtime.flush();
  assert.equal(x.sends.length, 3); assert.equal(x.messages().at(-1), 'LIVE LOCKED: transaction reconciliation required');
});

test('STOP drains queued lanes without sending the burst tail', async t => {
  const x = await throughputSetup(t); await x.engine.arm('LIVE_REAL_MONEY');
  for (let i = 0; i < 10; i++) x.intent('stop-' + i, 1, 'BUY', 'live', bs58.encode(nacl.sign.keyPair().publicKey));
  try {
    await until(() => x.sends.length === 3); await x.flushIntake(); x.engine.stop(); x.release(true); await x.runtime.flush();
    assert.equal(x.sends.length, 3); assert.equal(x.fills().length, 3);
    assert.equal(x.engine.status().pendingSignature, null);
    assert.equal(x.messages().filter(m => m === 'LIVE_STOPPED').length, 7);
  } finally { x.release(); }
});

test('parallel BUY reservations preserve the shared SOL reserve', async t => {
  const x = await throughputSetup(t, { balanceLamports: 22000000 }); await x.engine.arm('LIVE_REAL_MONEY');
  for (let i = 0; i < 3; i++) x.intent('reserve-' + i, 1, 'BUY', 'live', bs58.encode(nacl.sign.keyPair().publicKey));
  try {
    await until(() => x.sends.length + x.messages().filter(m => ['LIVE_RESERVE_OR_FEE_BUFFER', 'LIVE_SOL_RESERVE'].includes(m)).length === 3);
    x.release(true); await x.runtime.flush();
    assert.ok(x.sends.length > 0);
    const spent = x.fills().reduce((sum, fill) => sum + fill.payload.quantity * fill.payload.entryPrice + fill.payload.fees, 0);
    assert.ok(spent / 100 * 1e9 <= 12000000, 'combined spend must leave the 0.01 SOL reserve intact');
    assert.ok(x.fills().some(fill => fill.payload.quantity * fill.payload.entryPrice < .7), 'later orders size against remaining unreserved funds');
  } finally { x.release(); }
});

for (const age of [60001, 179999, 180000, 180001]) test('live intent age boundary: ' + age + 'ms', async t => {
  assert.equal(require('../core/execution/live.cjs').INTENT_MAX_AGE_MS, 180000);
  const x = await setup(t); await x.engine.arm('LIVE_REAL_MONEY');
  x.intent(); x.advance(age); await x.runtime.flush();
  assert.equal(x.fills().length, age <= 180000 ? 1 : 0, x.messages().join(', '));
  assert.equal(x.messages().includes('LIVE_INTENT_EXPIRED'), age > 180000);
});

test('fresh BUY simulation failure cools both routes for ten minutes and survives restart', async t => {
  const options = { rpcResponse: (url, method) => method === 'simulateTransaction' ? new Response(JSON.stringify({ result: { value: { err: { InstructionError: [0, 'thin pool'] } } } })) : undefined };
  const x = await setup(t, options); await x.engine.arm('LIVE_REAL_MONEY');
  x.intent(); x.intent('queued-retry'); await x.runtime.flush();
  assert.equal(x.messages().filter(m => m === 'LIVE_SIMULATION_FAILED').length, 1);
  assert.equal(x.messages().filter(m => m === 'LIVE_REMOTE_FAIL_COOLDOWN').length, 1);
  assert.equal(x.calls.filter(p => p.endsWith('/quote')).length, 1); assert.equal(x.sent(), 0);
  const saved = JSON.parse(fs.readFileSync(path.join(x.root, 'live-state.json')));
  assert.equal(saved.jupiterNoRouteCooldowns[x.token], Date.parse(stamp) + 600000);
  x.engine.stop(); const next = x.create(); await next.arm('LIVE_REAL_MONEY');
  x.advance(599999); x.intent('cooling'); await x.flushIntake(); await next.drain();
  assert.equal(x.calls.filter(p => p.endsWith('/quote')).length, 1); assert.equal(x.pumpReads.length, 0);
  delete options.rpcResponse; x.advance(1); x.intent('expired-cooldown'); await x.flushIntake(); await next.drain();
  assert.equal(x.fills().length, 1, x.messages().join(', '));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(x.root, 'live-state.json'))).jupiterNoRouteCooldowns, {});
});

for (const poolAgeMs of [59999, 1800001, 31 * 86400000]) test('simulation failure outside fresh window has no cooldown: ' + poolAgeMs, async t => {
  const x = await setup(t, { poolAgeMs, rpcResponse: (url, method) => method === 'simulateTransaction' ? new Response(JSON.stringify({ result: { value: { err: 'failed' } } })) : undefined });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  x.intent('retry'); await x.runtime.flush();
  assert.equal(x.messages().filter(m => m === 'LIVE_SIMULATION_FAILED').length, 2);
  assert.equal(x.calls.filter(p => p.endsWith('/quote')).length, 2);
});

test('SELL simulation failure does not cool down the token', async t => {
  const options = {}, x = await setup(t, options); await x.engine.arm('LIVE_REAL_MONEY');
  x.intent(); await x.runtime.flush();
  options.rpcResponse = (url, method) => method === 'simulateTransaction' ? new Response(JSON.stringify({ result: { value: { err: 'failed' } } })) : undefined;
  x.intent('sell', 1, 'SELL'); await x.runtime.flush();
  assert.equal(x.messages().at(-1), 'LIVE_SIMULATION_FAILED');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(x.root, 'live-state.json'))).jupiterNoRouteCooldowns, {});
});

test('RPC 429 and configured endpoint failure fall through to public RPC and arm', async t => {
  const primary = 'https://helius.test', publicRpc = 'https://api.mainnet-beta.solana.com';
  const x = await setup(t, { env: { RPC_HTTP_ENDPOINT: primary }, rpcResponse: url => {
    if (url === primary) return new Response('limited', { status: 429 });
    if (url === 'https://rpc.test') throw Error('network unavailable');
  } });
  await x.engine.arm('LIVE_REAL_MONEY');
  assert.equal(x.engine.isArmed(), true); assert.equal(x.engine.status().balanceSol, .1963);
  for (const method of ['getGenesisHash', 'getBalance']) assert.deepEqual(x.rpcCalls.filter(c => c.method === method).map(c => c.url), [primary, 'https://rpc.test', publicRpc]);
});

for (const failure of ['rpc error', 'missing result', 'null result', 'HTTP 500', 'timeout', 'network']) test('send fallback once with identical bytes and stop on success: ' + failure, async t => {
  const sends = [], primary = 'https://helius.test';
  const x = await setup(t, { env: { RPC_HTTP_ENDPOINT: primary }, rpcResponse: (url, method, params) => {
    if (method !== 'sendTransaction') return;
    sends.push({ url, params });
    if (url !== primary) return;
    if (failure === 'timeout') throw new DOMException('timed out', 'TimeoutError');
    if (failure === 'network') throw Error('connection reset');
    if (failure === 'HTTP 500') return new Response('unavailable', { status: 500 });
    return new Response(JSON.stringify(failure === 'rpc error' ? { error: { code: -32005 } } : failure === 'null result' ? { result: null } : {}));
  } });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  assert.equal(x.fills().length, 1, x.messages().join(', ')); assert.equal(x.sent(), 1);
  assert.deepEqual(sends.map(s => s.url), [primary, 'https://rpc.test']);
  assert.deepEqual(sends[0].params, sends[1].params);
  await x.runtime.flush(); assert.equal(sends.length, 2);
});

test('all RPC endpoints fail with LIVE_RPC_FAILED, including balance refresh', async t => {
  const x = await setup(t, { env: { RPC_HTTP_ENDPOINT: 'https://helius.test' }, rpcResponse: () => new Response('down', { status: 503 }) });
  await assert.rejects(x.engine.arm('LIVE_REAL_MONEY'), /LIVE_RPC_FAILED/);
  await assert.rejects(x.engine.refreshBalance(), /LIVE_RPC_FAILED/);
  assert.equal(x.engine.isArmed(), false);
  for (const method of ['getGenesisHash', 'getBalance']) assert.deepEqual(x.rpcCalls.filter(c => c.method === method).map(c => c.url), ['https://helius.test', 'https://rpc.test', 'https://api.mainnet-beta.solana.com']);
});

test('duplicate endpoints are only attempted once', async t => {
  const x = await setup(t, { env: { RPC_HTTP_ENDPOINT: 'https://rpc.test' }, rpcResponse: () => new Response('{}') });
  await assert.rejects(x.engine.arm('LIVE_REAL_MONEY'), /LIVE_RPC_FAILED/);
  assert.deepEqual(x.rpcCalls.map(c => c.url), ['https://rpc.test', 'https://api.mainnet-beta.solana.com']);
});

test('read RPCs fall back across BUY, SELL, simulation, fees and withdrawal', async t => {
  const primary = 'https://helius.test';
  const x = await setup(t, { env: { RPC_HTTP_ENDPOINT: primary }, rpcResponse: (url, method) => {
    if (url === primary && method !== 'sendTransaction') return new Response('limited', { status: 429 });
  } });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  x.intent('sell', 1, 'SELL'); await x.runtime.flush();
  assert.equal(x.fills().length, 2, x.messages().join(', '));
  for (const method of ['getGenesisHash', 'getBalance', 'getTokenSupply', 'getTokenAccountsByOwner', 'getSignatureStatuses', 'getTransaction', 'simulateTransaction']) {
    // The two token-program reads run concurrently; each has its own fallback.
    for (const programId of method === 'getTokenAccountsByOwner' ? [TOKEN, TOKEN2022] : [null]) {
      const calls = x.rpcCalls.filter(c => c.method === method && (!programId || c.params[1].programId === programId));
      assert.ok(calls.length >= 2, method);
      for (let i = 0; i < calls.length; i += 2) assert.deepEqual(calls.slice(i, i + 2).map(c => c.url), [primary, 'https://rpc.test'], method);
    }
  }
  const y = await setup(t, { withdraw: true, env: { RPC_HTTP_ENDPOINT: primary }, rpcResponse: url => url === primary ? new Response('down', { status: 503 }) : undefined });
  await y.engine.withdrawTo(x.token, .01);
  for (const method of ['getFeeForMessage', 'getLatestBlockhash']) assert.deepEqual(y.rpcCalls.filter(c => c.method === method).map(c => c.url), [primary, 'https://rpc.test']);
});

for (const tokenProgramId of [TOKEN, TOKEN2022]) for (const noRoute of [true, 'empty', 'code']) test(`pump bonding curve buy and sell after Jupiter no-route: ${noRoute}, ${tokenProgramId}`, async t => {
  const options = { noRoute, pump: true, pumpRent: 4600000, tokenProgram: tokenProgramId }, x = await setup(t, options);
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent('pump-buy'); await x.runtime.flush();
  assert.equal(x.fills().length, 1, x.messages().join(', '));
  assert.equal(x.fills()[0].source, 'live.pumpfun'); assert.equal(x.fills()[0].payload.mode, 'live'); assert.equal(x.fills()[0].payload.slippageBps, 1000);
  assert.ok(x.messages().includes('route: pumpfun bonding curve')); assert.equal(x.calls.some(p => p.endsWith('/swap')), false);
  const program = require('../core/execution/pumpfun.cjs').PROGRAM, mint = new PublicKey(x.token), owner = new PublicKey(x.config.owner);
  const pda = (seed, keys = [], programId = program) => PublicKey.findProgramAddressSync([Buffer.from(seed), ...keys.map(k => k.toBuffer())], programId)[0];
  const tokenProgram = new PublicKey(tokenProgramId), ataProgram = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  const ata = who => PublicKey.findProgramAddressSync([who.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ataProgram)[0];
  const curve = pda('bonding-curve', [mint]);
  const decode = tx => {
    const ix = tx.message.compiledInstructions.find(ix => tx.message.staticAccountKeys[ix.programIdIndex].equals(program));
    return { bytes: Buffer.from(ix.data), keys: Array.from(ix.accountKeyIndexes, index => tx.message.staticAccountKeys[index].toBase58()) };
  };
  const buy = decode(x.transactions[0]), amount = BigInt(x.quote().inAmount) - 2500000n;
  let net = amount * 10000n / 10150n;
  const cost = net + (net * 100n + 9999n) / 10000n + (net * 50n + 9999n) / 10000n;
  if (cost > amount) net -= cost - amount;
  const expected = (net - 1n) * 5000000n / (30000000n + net - 1n);
  assert.equal(buy.bytes.subarray(0, 8).toString('hex'), '38fc74089edfcd5f'); assert.equal(buy.bytes.readBigUInt64LE(8), amount); assert.equal(buy.bytes.readBigUInt64LE(16), expected * 9n / 10n);
  assert.deepEqual(buy.keys.slice(0, 9), [pda('global'), owner, mint, curve, ata(curve), ata(owner), owner, SystemProgram.programId, tokenProgram].map(k => k.toBase58()));
  assert.equal(buy.keys[9], pda('creator-vault', [owner]).toBase58()); assert.equal(buy.keys[10], pda('__event_authority').toBase58());
  assert.equal(buy.keys[12], pda('global_volume_accumulator').toBase58()); assert.equal(buy.keys[13], pda('user_volume_accumulator', [owner]).toBase58());
  options.feeRecipient = bs58.encode(nacl.sign.keyPair().publicKey);
  x.intent('pump-sell', 1, 'SELL'); await x.runtime.flush();
  assert.equal(x.fills().length, 2, x.messages().join(', ')); assert.equal(x.fills()[1].payload.side, 'SELL');
  const sell = decode(x.transactions[1]);
  assert.equal(sell.bytes.subarray(0, 8).toString('hex'), '33e685a4017f83ad'); assert.equal(sell.bytes.readBigUInt64LE(8), 1000000n);
  assert.equal(sell.bytes.readBigUInt64LE(16), 4925000n * 9n / 10n); assert.equal(sell.keys[1], options.feeRecipient);
  assert.equal(sell.keys[4], ata(curve).toBase58()); assert.equal(sell.keys[5], ata(owner).toBase58()); assert.equal(sell.keys[8], buy.keys[9]); assert.equal(sell.keys[9], tokenProgram.toBase58());
  assert.equal(x.pumpReads.filter(k => k === pda('global').toBase58()).length, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(x.root, 'live-state.json'))).jupiterNoRouteCooldowns[x.token], Date.parse(stamp) + 600000);
  assert.equal(x.calls.filter(p => p.endsWith('/quote')).length, 1);
});

for (const [name, options, attempts, diagnostic] of [
  ['429', { quoteFailure: true }, 2, /HTTP 429 rate limited/],
  ['3s timeout', { quoteTimeout: true }, 2, /timeout after 3000ms/],
  ['400 other error', { quoteResponse: () => new Response('{"error":"bad request"}', { status: 400 }) }, 1, /HTTP 400.*bad request/],
  ['422 minimum amount', { quoteResponse: () => new Response('{"error":"amount below minimum inAmount"}', { status: 422 }) }, 1, /HTTP 422.*minimum inAmount/],
  ['swap 422 priority schema', { swapResponse: () => new Response('{"error":"Failed to deserialize: untagged enum PrioritizationFeeLamports"}', { status: 422 }) }, 1, /HTTP 422.*PrioritizationFeeLamports/],
  ['swap 422 no-route', { swapResponse: () => new Response('{"error":"TOKEN_NOT_TRADABLE"}', { status: 422 }) }, 1, /HTTP 422.*TOKEN_NOT_TRADABLE/],
  ['503', { quoteResponse: () => new Response('upstream down', { status: 503 }) }, 1, /HTTP 503 upstream down/],
  ['invalid JSON', { quoteResponse: () => new Response('invalid'.repeat(30), { status: 200 }) }, 1, /HTTP 200/],
  ['swap 429', { swapResponse: () => new Response('rate limited', { status: 429 }) }, 1, /HTTP 429 rate limited/],
  ['swap 400 no-route', { swapResponse: () => new Response('{"error":"TOKEN_NOT_TRADABLE"}', { status: 400 }) }, 1, /HTTP 400.*TOKEN_NOT_TRADABLE/],
  ['swap invalid JSON', { swapResponse: () => new Response('bad swap json', { status: 200 }) }, 1, /HTTP 200 bad swap json/]
]) test(`Jupiter ${name} falls back to pump fill`, async t => {
  const x = await setup(t, { ...options, pump: true });
  await x.engine.arm('LIVE_REAL_MONEY'); const started = Date.now(); x.intent(); await x.runtime.flush();
  assert.equal(x.fills().length, 1, x.messages().join(', ')); assert.equal(x.sent(), 1);
  assert.equal(x.fills()[0].source, 'live.pumpfun');
  assert.equal(x.calls.filter(p => p.endsWith('/quote')).length, attempts);
  assert.ok(x.messages().some(message => diagnostic.test(message)));
  if (attempts === 2) { assert.ok(Date.now() - started >= (options.quoteTimeout ? 7500 : 1500)); assert.equal(x.messages().filter(m => m.includes('retry in 1500ms')).length, 1); }
  const cooldown = JSON.parse(fs.readFileSync(path.join(x.root, 'live-state.json'))).jupiterNoRouteCooldowns[x.token];
  assert.equal(cooldown, name.includes('no-route') ? Date.parse(stamp) + 600000 : undefined);
  if (name === 'invalid JSON') assert.ok(x.messages().includes('LIVE_REMOTE_UNAVAILABLE: HTTP 200 ' + 'invalid'.repeat(30).slice(0, 120) + '; trying pumpfun'));
});

test('429 retry recovers on Jupiter without pump or cooldown', async t => {
  const options = { quoteResponse: () => { delete options.quoteResponse; return new Response('rate limited', { status: 429 }); } };
  const x = await setup(t, options); await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  assert.equal(x.fills().length, 1, x.messages().join(', ')); assert.equal(x.fills()[0].source, 'live.jupiter');
  assert.equal(x.calls.filter(p => p.endsWith('/quote')).length, 2); assert.equal(x.pumpReads.length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(x.root, 'live-state.json'))).jupiterNoRouteCooldowns, {});
});

test('legacy transient cooldown does not block Jupiter after restart', async t => {
  const x = await setup(t);
  fs.writeFileSync(path.join(x.root, 'live-state.json'), JSON.stringify({ version: 1, owner: x.config.owner, pending: null, claimed: [], fills: [], remoteFailCooldowns: { [x.token]: Date.parse(stamp) + 600000 } }));
  const next = x.create(); await next.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush(); await next.drain();
  assert.equal(x.fills().length, 1, x.messages().join(', ')); assert.equal(x.pumpReads.length, 0);
});

test('Jupiter route wins even for a pump token', async t => {
  const x = await setup(t, { pump: true }); await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  assert.equal(x.fills().length, 1); assert.ok(x.messages().includes('route: jupiter')); assert.equal(x.pumpReads.length, 0);
});
for (const pump of ['missing', 'complete', 'wrong-owner']) test(`both routes fail safely and cool down: ${pump}`, async t => {
  const x = await setup(t, { noRoute: true, pump }); await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  assert.equal(x.sent(), 0); assert.equal(x.fills().length, 0); const reads = x.pumpReads.length;
  assert.match(x.messages().at(-1), /Jupiter: .*HTTP 400.*TOKEN_NOT_TRADABLE.*pumpfun: LIVE_PUMPFUN_UNAVAILABLE/);
  x.intent('retry'); await x.runtime.flush(); assert.ok(x.pumpReads.length > reads);
  assert.equal(x.calls.filter(p => p.endsWith('/quote')).length, 1);
  assert.match(x.messages().at(-1), /Jupiter: LIVE_JUPITER_NO_ROUTE_COOLDOWN; pumpfun: LIVE_PUMPFUN_UNAVAILABLE/);
});
test('SELL with no Jupiter route and missing Pump curve surfaces both errors without broadcasting', async t => {
  const options = {}, x = await setup(t, options);
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  options.noRoute = true; options.pump = 'missing';
  x.intent('sell-unroutable', 1, 'SELL'); await x.runtime.flush();
  assert.equal(x.sent(), 1); assert.equal(x.fills().length, 1);
  assert.ok(x.pumpReads.length > 0);
  assert.match(x.messages().at(-1), /Jupiter: .*HTTP 400.*TOKEN_NOT_TRADABLE.*pumpfun: LIVE_PUMPFUN_UNAVAILABLE: BondingCurve.account-missing/);
});

test('pump receipt below minimum remains pending for reconciliation', async t => {
  const x = await setup(t, { noRoute: true, pump: true, shortFill: true }); await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  assert.equal(x.sent(), 1); assert.equal(x.fills().length, 0); assert.ok(x.engine.status().pendingSignature); assert.equal(x.messages().at(-1), 'LIVE_RECEIPT_INVALID_RECONCILE');
});

test('pump sell receipt below minimum remains pending for reconciliation', async t => {
  const options = { noRoute: true, pump: true }, x = await setup(t, options); await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  options.shortSell = true; x.intent('sell', 1, 'SELL'); await x.runtime.flush();
  assert.equal(x.sent(), 2); assert.equal(x.fills().length, 1); assert.ok(x.engine.status().pendingSignature); assert.equal(x.messages().at(-1), 'LIVE_RECEIPT_INVALID_RECONCILE');
});

test('confirmed no-route cooldown skips only Jupiter and survives restart', async t => {
  const x = await setup(t, { noRoute: true });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent('failed'); await x.runtime.flush();
  assert.match(x.messages().at(-1), /HTTP 400.*TOKEN_NOT_TRADABLE/);
  const readLedger = () => JSON.parse(fs.readFileSync(path.join(x.root, 'live-state.json'), 'utf8'));
  const retryAfterMs = Date.parse(stamp) + 10 * 60000;
  assert.equal(readLedger().jupiterNoRouteCooldowns[x.token], retryAfterMs);
  const calls = x.calls.length;
  x.intent('immediate'); await x.runtime.flush();
  assert.match(x.messages().at(-1), /LIVE_JUPITER_NO_ROUTE_COOLDOWN/);
  assert.ok(x.calls.length > calls);
  assert.equal(readLedger().jupiterNoRouteCooldowns[x.token], retryAfterMs);
  x.engine.stop(); const next = x.create(); await next.arm('LIVE_REAL_MONEY');
  const restartedCalls = x.calls.length;
  x.intent('restarted'); await x.runtime.flush(); await next.drain();
  assert.match(x.messages().at(-1), /LIVE_JUPITER_NO_ROUTE_COOLDOWN/);
  assert.ok(x.calls.length > restartedCalls);
  assert.equal(x.calls.filter(p => p.endsWith('/quote')).length, 1);
  assert.equal(x.sent(), 0);
});

test('cooldown expires at ten minutes and a successful quote plus fill clears persisted cooldown', async t => {
  const options = { noRoute: true }, x = await setup(t, options);
  const readLedger = () => JSON.parse(fs.readFileSync(path.join(x.root, 'live-state.json'), 'utf8'));
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent('failed'); await x.runtime.flush();
  x.advance(10 * 60000 - 1);
  x.intent('too-early'); await x.runtime.flush();
  assert.match(x.messages().at(-1), /LIVE_JUPITER_NO_ROUTE_COOLDOWN/);
  assert.equal(x.calls.filter(p => p.endsWith('/quote')).length, 1);
  x.advance(1); options.noRoute = false; options.remoteSecret = true;
  x.intent('swap-fails'); await x.runtime.flush();
  assert.equal(x.calls.filter(p => p.endsWith('/quote')).length, 2);
  assert.equal(x.fills().length, 0);
  assert.equal(readLedger().jupiterNoRouteCooldowns[x.token], Date.parse(stamp) + 10 * 60000);
  options.remoteSecret = false;
  x.intent('filled'); await x.runtime.flush();
  assert.equal(x.calls.filter(p => p.endsWith('/quote')).length, 3);
  assert.equal(x.sent(), 1); assert.equal(x.fills().length, 1, x.messages().join(','));
  assert.equal(Object.hasOwn(readLedger().jupiterNoRouteCooldowns, x.token), false);
  x.intent('sell', 1, 'SELL'); await x.runtime.flush();
  assert.equal(x.sent(), 2); assert.equal(x.fills().length, 2);
});

for (const confirmationStatus of ['confirmed', 'finalized']) test('confirmation succeeds on third poll: ' + confirmationStatus, async t => {
  const x = await setup(t, { statusSequence: [null, { confirmationStatus: 'processed', err: null }, { confirmationStatus, err: null }] });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  assert.equal(x.calls.filter(c => c === 'getSignatureStatuses').length, 3);
  assert.equal(x.fills().length, 1); assert.equal(x.sent(), 1);
  assert.equal(x.engine.status().pendingSignature, null); assert.equal(x.engine.isArmed(), true);
});

for (const options of [{ signatureStatus: null }, { signatureStatus: { confirmationStatus: 'processed', err: null } }, { statusError: true }, { statusSequence: [Error('transport lost')] }]) test('confirmation exhaustion stays armed and pending: ' + JSON.stringify(options), async t => {
  const x = await setup(t, options);
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  assert.equal(x.calls.filter(c => c === 'getSignatureStatuses').length, options.statusError || options.statusSequence ? 12 : 6);
  assert.equal(x.fills().length, 0); assert.equal(x.sent(), 1);
  assert.equal(x.engine.status().pendingSignature, x.signature()); assert.equal(x.engine.isArmed(), true);
  assert.ok(x.messages().includes('LIVE_CONFIRMATION_UNKNOWN_RECONCILE'));
  x.intent('next'); await x.runtime.flush();
  assert.equal(x.sent(), 1); assert.equal(x.engine.isArmed(), true);
});

test('transient confirmation transport error recovers without disarming', async t => {
  const x = await setup(t, { statusSequence: [Error('transport lost'), null, { confirmationStatus: 'confirmed', err: null }] });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  assert.equal(x.fills().length, 1); assert.equal(x.engine.isArmed(), true); assert.equal(x.sent(), 1);
});

for (const action of ['reconcile', 'arm']) test('pending confirmation can reconcile while still armed: ' + action, async t => {
  const options = { signatureStatus: null };
  const x = await setup(t, options);
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  assert.equal(x.engine.status().pendingSignature, x.signature());
  options.signatureStatus = { confirmationStatus: 'confirmed', err: null };
  await x.engine[action]('LIVE_REAL_MONEY');
  assert.equal(x.engine.status().pendingSignature, null); assert.equal(x.engine.isArmed(), true); assert.equal(x.sent(), 1);
});

test('application remains live and running after confirmation RPC exhaustion', async t => {
  const x = await setup(t, { application: true, statusError: true });
  await x.application.live('LIVE_REAL_MONEY');
  // Let the initial empty scanner sweep finish before submitting the test intent.
  await new Promise(resolve => setTimeout(resolve, 20));
  x.intent(); await x.runtime.flush(); await x.application.drainLive();
  assert.equal(x.calls.filter(c => c === 'getSignatureStatuses').length, 12);
  const control = x.application.control();
  assert.equal(control.live.state, 'ARMED'); assert.equal(control.mode, 'live'); assert.equal(control.running, true);
  assert.equal(control.live.pendingSignature, x.signature()); assert.equal(x.fills().length, 0);
  await x.application.stop(); assert.equal(x.application.control().live.state, 'LOCKED');
});

test('live RPC falls back to configured endpoint when environment endpoint is absent', async t => {
  const x = await setup(t);
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  assert.equal(x.fills().length, 1); assert.ok(x.rpcCalls.every(call => call.url === 'https://rpc.test'));
});

test('on-chain transaction error records failure and clears pending without a position', async t => {
  const x = await setup(t, { signatureStatus: { err: { InstructionError: [0, 'failed'] } } });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  assert.ok(x.messages().includes('LIVE_TRANSACTION_FAILED')); assert.equal(x.fills().length, 0);
  assert.equal(x.engine.status().pendingSignature, null); assert.equal(x.engine.isArmed(), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(x.root, 'live-state.json'), 'utf8')).pending, null);
});

for (const application of [false, true]) test('all live RPCs use environment endpoint unchanged: application=' + application, async t => {
  const endpoint = 'https://mainnet.helius-rpc.com/?api-key=test-key';
  const x = await setup(t, { application, env: { RPC_HTTP_ENDPOINT: endpoint } });
  if (application) await x.application.live('LIVE_REAL_MONEY'); else await x.engine.arm('LIVE_REAL_MONEY');
  x.intent(); await x.runtime.flush(); if (application) await x.application.drainLive();
  assert.equal(x.fills().length, 1);
  assert.ok(x.rpcCalls.every(call => call.url === endpoint));
  for (const method of ['getGenesisHash', 'getBalance', 'sendTransaction', 'getSignatureStatuses', 'getTransaction']) assert.ok(x.rpcCalls.some(call => call.method === method), method);
});

test('zero chain balance cannot arm', async t => {
  const x = await setup(t, { zeroBalance: true });
  await assert.rejects(x.engine.arm('LIVE_REAL_MONEY'), /LIVE_DEPOSIT_REQUIRED/);
  assert.equal(x.engine.isArmed(), false);
});

for (const liquidity of [0, 10, 1000]) test('armed application sweep reaches a live fill with fresh liquidity ' + liquidity, async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw Error('No external network in sweep test'); });
  const x = await setup(t, { application: true, sweep: true, liquidity, balanceLamports: 1963000000 });
  assert.equal(x.application.control().scanIntervalMs, 120000);
  assert.equal(x.application.tradeStore.walletFunded, true);
  await x.application.live('LIVE_REAL_MONEY');
  for (const deadline = Date.now() + 2000; Date.now() < deadline && !x.fills().length;) {
    await new Promise(resolve => setTimeout(resolve, 5));
    await x.runtime.flush(); await x.application.drainLive();
  }
  const events = x.runtime.snapshot().events;
  const diagnostic = JSON.stringify(events.filter(e => ['StrategyDecision', 'RiskDecision', 'SafetyDecision', 'ExecutionIntent', 'AIActivityEvent'].includes(e.type)).map(e => [e.type, e.payload]));
  assert.equal(x.sent(), 1, diagnostic);
  for (const type of ['MarketSnapshot', 'TokenCandidate', 'SignalObservation', 'MarketRegimeState', 'StrategyDecision', 'SafetyDecision', 'RiskDecision', 'ExecutionIntent', 'TradeResult']) assert.ok(events.some(e => e.type === type), type);
  const risk = events.find(e => e.type === 'RiskDecision'), intent = events.find(e => e.type === 'ExecutionIntent');
  assert.equal(risk.payload.approved, true);
  assert.ok(risk.evidence.includes('app-valuation'));
  assert.equal(risk.payload.maxExposureUsd, 2, 'live $2 cap sizes the intent before execution');
  assert.equal(intent.payload.mode, 'live');
  assert.equal(x.fills().length, 1); assert.equal(x.fills()[0].payload.mode, 'live');
  assert.ok(x.calls.includes('/swap/v1/quote') && x.calls.includes('/swap/v1/swap') && x.calls.includes('simulateTransaction') && x.calls.includes('getTransaction'));
  assert.deepEqual(x.runtime.snapshot().deliveryErrors, []);
});

test('live application safety outage rejects the candidate without broadcasting', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw Error('No external network'); });
  const x = await setup(t, { application: true, sweep: true, safetyWait: async () => { throw Error('RUGCHECK_HTTP_503'); } });
  await x.application.live('LIVE_REAL_MONEY');
  for (const deadline = Date.now() + 2000; Date.now() < deadline && !x.runtime.snapshot().events.some(e => e.type === 'SafetyDecision');) {
    await new Promise(resolve => setTimeout(resolve, 5)); await x.runtime.flush();
  }
  await x.application.drainLive();
  const verdict = x.runtime.snapshot().events.find(e => e.type === 'SafetyDecision');
  assert.equal(verdict?.payload.approved, false);
  assert.match(verdict.payload.reason, /RUGCHECK_HTTP_503/);
  assert.equal(x.sent(), 0); assert.equal(x.fills().length, 0);
});

test('live sweep waits for asynchronous safety before broadcasting', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw Error('No external network'); });
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const x = await setup(t, { application: true, sweep: true, safetyWait: () => waiting });
  await x.application.live('LIVE_REAL_MONEY');
  for (const deadline = Date.now() + 2000; Date.now() < deadline && !x.runtime.snapshot().events.some(e => e.type === 'ExecutionIntent');) { await new Promise(resolve => setTimeout(resolve, 5)); await x.runtime.flush(); }
  assert.ok(x.runtime.snapshot().events.some(e => e.type === 'ExecutionIntent'));
  assert.equal(x.sent(), 0);
  release();
  for (let i = 0; i < 100 && !x.fills().length; i++) { await new Promise(resolve => setImmediate(resolve)); await x.runtime.flush(); await x.application.drainLive(); }
  assert.equal(x.sent(), 1, x.messages().join(','));
  assert.equal(x.fills()[0].payload.mode, 'live');
});

for (const outcome of ['reject', 'stop']) test('pending live safety cannot trade after ' + outcome, async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw Error('No external network'); });
  let release;
  const waiting = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const x = await setup(t, { application: true, sweep: true, safetyWait: async () => { await waiting; if (outcome === 'reject') throw Error('OPAQUE_SAFETY_FAILURE'); } });
  await x.application.live('LIVE_REAL_MONEY');
  for (const deadline = Date.now() + 2000; Date.now() < deadline && !x.runtime.snapshot().events.some(e => e.type === 'ExecutionIntent');) { await new Promise(resolve => setTimeout(resolve, 5)); await x.runtime.flush(); }
  assert.ok(x.runtime.snapshot().events.some(e => e.type === 'ExecutionIntent'));
  if (outcome === 'stop') await x.application.stop();
  release();
  for (let i = 0; i < 10; i++) { await new Promise(resolve => setImmediate(resolve)); await x.runtime.flush(); await x.application.drainLive(); }
  assert.equal(x.sent(), 0); assert.equal(x.fills().length, 0);
  if (outcome === 'reject') assert.ok(x.messages().includes('LIVE_SAFETY_REJECTED'));
});

test('real SOL withdrawal signs a SystemProgram transfer, deducts chain balance, persists signature and projects history', async t => {
  const x = await setup(t, { withdraw: true });
  await x.engine.arm('LIVE_REAL_MONEY');
  const destination = bs58.encode(nacl.sign.keyPair().publicKey);
  const result = await x.engine.withdrawTo(destination, .04);
  assert.equal(x.sent(), 1); assert.equal(result.signature, x.signature());
  assert.equal(result.solBalance, .156295); assert.equal(x.engine.status().balanceSol, .156295);
  assert.equal(x.fills().length, 0, 'withdrawal must not manufacture a trading fill or PnL');
  assert.ok(x.messages().includes(`Đã rút 0.04 SOL · tx ${result.signature.slice(0, 12)}`));
  const saved = JSON.parse(fs.readFileSync(path.join(x.root, 'live-state.json'), 'utf8'));
  assert.equal(saved.withdrawals[0].signature, result.signature); assert.equal(saved.pending, null);
  const adapter = require('../dashboard/adapter/index.cjs').createDashboardAdapter({ runtime: x.runtime, tradeStore: x.tradeStore, now });
  t.after(() => adapter.close());
  assert.equal(adapter.snapshot().withdrawals[0].signature, result.signature);
  x.engine.stop(); const restored = x.create(); t.after(() => restored.stop());
  assert.equal(x.runtime.snapshot().events.filter(e => e.payload.task === 'withdraw').length, 1);
});

test('withdraw rejects invalid destination, precision, overdraw and reserve without broadcast', async t => {
  const x = await setup(t, { withdraw: true }), destination = bs58.encode(nacl.sign.keyPair().publicKey);
  for (const address of ['', '0OIl', x.config.owner]) await assert.rejects(x.engine.withdrawTo(address, .01), /DESTINATION/);
  for (const amount of [0, -1, NaN, Infinity, '0.01', .0000000001]) await assert.rejects(x.engine.withdrawTo(destination, amount), /AMOUNT/);
  await assert.rejects(x.engine.withdrawTo(destination, .2), /INSUFFICIENT_SOL/);
  await assert.rejects(x.engine.withdrawTo(destination, .1863), /SOL_RESERVE/);
  assert.equal(x.sent(), 0);
  await x.engine.withdrawTo(destination, .186295);
  assert.equal(x.engine.status().balanceSol, .01);
});

test('concurrent withdrawals serialize; ambiguous send locks and never resends', async t => {
  const x = await setup(t, { withdraw: true }), destination = bs58.encode(nacl.sign.keyPair().publicKey);
  const results = await Promise.allSettled([x.engine.withdrawTo(destination, .1), x.engine.withdrawTo(destination, .1)]);
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected']); assert.equal(x.sent(), 1);
  const y = await setup(t, { withdraw: true, sendUnknown: true });
  await assert.rejects(y.engine.withdrawTo(destination, .01), /LIVE_RPC_FAILED/);
  assert.equal(y.engine.status().pendingSignature, y.signature());
  await assert.rejects(y.engine.withdrawTo(destination, .01), /reconciliation/); assert.equal(y.sent(), 2);
  const restarted = y.create(); t.after(() => restarted.stop());
  await assert.rejects(restarted.withdrawTo(destination, .01), /reconciliation/); assert.equal(y.sent(), 2);
});

test('withdrawal obeys kill switch and queued STOP without broadcasting', async t => {
  const x = await setup(t, { withdraw: true }), destination = bs58.encode(nacl.sign.keyPair().publicKey);
  fs.writeFileSync(path.join(x.root, 'LIVE_KILL'), '');
  await assert.rejects(x.engine.withdrawTo(destination, .01), /LIVE_KILL/);
  fs.unlinkSync(path.join(x.root, 'LIVE_KILL'));
  const pending = x.engine.withdrawTo(destination, .01); x.engine.stop();
  await assert.rejects(pending, /LIVE_STOPPED/); assert.equal(x.sent(), 0);
});

test('live fills reach dashboard positions, trade history and activity without source filtering', async t => {
  const x = await setup(t, { application: true });
  const adapter = require('../dashboard/adapter/index.cjs').createDashboardAdapter({ runtime: x.runtime, tradeStore: x.application.tradeStore, now });
  t.after(() => adapter.close());
  await x.application.live('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush(); await x.application.drainLive();
  assert.equal(adapter.snapshot().trades.length, 1);
  x.intent('sell', 1, 'SELL'); await x.runtime.flush(); await x.application.drainLive();
  const view = adapter.snapshot(); assert.equal(view.trades.length, 2);
  for (const fill of x.fills()) { assert.ok(view.trades.some(row => row.id === fill.id)); assert.ok(view.activities.some(row => row.id === fill.id && row.producer === 'LIVE_EXECUTION')); }
});

test('application keeps legacy paper history without funding live overview or live positions', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw Error('No external network'); });
  const x = await setup(t, { application: true });
  const paperStore = createTradeStore({ runtime: x.runtime, now, capitalUsd: 100 });
  const paper = await require('./helpers/manual-paper-fixture.cjs').seedPosition({ runtime: x.runtime, tradeStore: paperStore, now });
  assert.ok(paper);
  const adapter = require('../dashboard/adapter/index.cjs').createDashboardAdapter({ runtime: x.runtime, tradeStore: x.application.tradeStore, now }); t.after(() => adapter.close());
  await x.application.live('LIVE_REAL_MONEY');
  let view = adapter.snapshot();
  assert.equal(view.summary.totalTrades, 0); assert.equal(view.summary.realizedPnlUsd, 0); assert.equal(view.summary.capitalUsedUsd, 0);
  assert.equal(view.summary.paperCapitalUsd, 19.63);
  assert.equal(view.trades.find(row => row.id === paper.id).status, 'archived');
  x.intent(); await x.runtime.flush(); await x.application.drainLive();
  view = adapter.snapshot();
  assert.equal(view.summary.totalTrades, 1); assert.equal(view.summary.openPositions, 1);
  assert.equal(view.trades.filter(row => row.mode === 'paper').length, 1);
  assert.equal(view.trades.filter(row => row.mode === 'live').length, 1);
  assert.equal(new Set(view.trades.map(row => row.cycleId)).size, 2);
  assert.equal(view.summary.cashUsd, x.application.tradeStore.snapshot().performance.cash);
});

test('withdrawal HTTP validates requests and destination store persists independently per network', async t => {
  const x = await setup(t, { withdraw: true, application: true });
  const service = require('../scripts/serve-meme-trader.cjs').createDashboardServer({ application: { ...x.application, close: async () => {} }, now, copyPath: null, copyWatch: false });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve)); t.after(() => service.close());
  const url = 'http://127.0.0.1:' + service.server.address().port;
  const post = (route, body) => fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const destinationAddress = bs58.encode(nacl.sign.keyPair().publicKey);
  assert.equal((await (await fetch(url + '/api/trading/withdrawal-destination')).json()).destinationAddress, '');
  assert.equal((await post('/api/trading/withdrawal-destination', { network: 'SOLANA', destinationAddress })).status, 200);
  assert.equal((await (await fetch(url + '/api/trading/withdrawal-destination')).json()).destinationAddress, destinationAddress);
  assert.equal((await post('/api/wallet/withdraw', { destinationAddress, amountSol: .04, extra: true })).status, 400);
  assert.equal((await post('/api/wallet/withdraw', { destinationAddress, amountSol: .2 })).status, 409);
  const result = await post('/api/wallet/withdraw', { destinationAddress, amountSol: .04 });
  assert.equal(result.status, 200); assert.equal((await result.json()).solBalance, .156295); assert.equal(x.sent(), 1);
  const filename = path.join(x.root, 'settings.json'), { createTradingSettings } = require('../runtime/trading-settings.cjs');
  let settings = createTradingSettings(filename); settings.set('SOLANA', 3); settings.setDestination('SOLANA', destinationAddress);
  settings = createTradingSettings(filename);
  assert.equal(settings.getDestination('SOLANA'), destinationAddress); assert.equal(settings.getDestination('BSC'), ''); assert.equal(settings.get('SOLANA'), 3);
  assert.throws(() => settings.setDestination('SOLANA', 'invalid'), /INVALID/);
  settings.setDestination('SOLANA', ''); assert.equal(createTradingSettings(filename).getDestination('SOLANA'), '');
});

for (const quantity of [.5, 1, 2]) test('live accepts order at or below $2 cap: $' + quantity, async t => {
  const x = await setup(t);
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent('small-buy', quantity); await x.runtime.flush();
  assert.equal(x.sent(), 1); assert.equal(x.fills().length, 1);
  assert.equal(x.engine.status().caps.position, 2);
  assert.ok(!x.messages().some(message => message.includes('LIVE_POSITION_CAP')));
});

test('keyed Jupiter uses authenticated API for quote and swap', async t => {
  const x = await setup(t, { env: { JUPITER_API_KEY: 'mock-api-key' } });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  assert.equal(x.fills().length, 1); assert.ok(x.fills()[0].evidence.includes(x.signature()));
});

test('$2.4 request clamps to $2 with quantity derived at snapshot price', async t => {
  const x = await setup(t, { quotePrice: 2 });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent('clamped', 2.4); await x.runtime.flush();
  assert.equal(x.sent(), 1); assert.equal(x.fills()[0].payload.mode, 'live');
  assert.equal(Number(x.quote().inAmount), Math.floor((2 / 100 * 1e9 - 2500000) / 1.01));
  assert.ok(!x.messages().includes('LIVE_POSITION_CAP'));
  assert.equal(x.runtime.get('clamped/intent').payload.quantity, 2.4);
});

for (const [name, quantity, options, expectedBudget] of [
  ['5% reference-price drift clamps to risk exposure', 1, { referencePrice: 1.05, maxExposureUsd: 1 }, 1],
  ['risk exposure below owner cap remains authoritative', .945, { maxExposureUsd: .9 }, .9],
  ['falling quote price reduces sizing to risk quantity', 1, { quotePrice: .8, maxExposureUsd: 1, riskQuantity: 1 }, .8],
  ['live quote quantity rounds down to token decimals', 1, { quotePrice: 3, maxExposureUsd: 1, tokenDecimals: 2 }, .99],
  ['exactly 10% reference-price drift remains allowed', 1, { referencePrice: 1.1, maxExposureUsd: 1 }, 1]
]) test(name, async t => {
  const x = await setup(t, { ...options, sizedReceipt: true });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent('clamped', quantity); await x.runtime.flush();
  assert.equal(x.sent(), 1, x.messages().join(',')); assert.equal(x.fills().length, 1);
  const fill = x.fills()[0]; validateEvent(fill, { now });
  const expectedLamports = Math.floor((expectedBudget / 100 * 1e9 - 2500000) / 1.01);
  assert.equal(Number(x.quote().inAmount), expectedLamports);
  assert.ok(Math.abs(fill.payload.quantity * fill.payload.entryPrice - expectedLamports / 1e9 * 100) < 1e-12);
  assert.ok(fill.payload.quantity * fill.payload.entryPrice + fill.payload.fees <= expectedBudget);
  assert.ok(fill.payload.quantity <= (options.riskQuantity ?? quantity));
  assert.equal(x.runtime.get('clamped/intent').status, 'APPROVED');
  assert.ok(!x.messages().includes('LIVE_POSITION_CAP'));
});

for (const [quantity, maxExposureUsd] of [[1.15, 1], [1.4, .9]]) test('$' + quantity + ' drifted budget clamps to risk exposure and owner cap (risk $' + maxExposureUsd + ')', async t => {
  const x = await setup(t, { maxExposureUsd });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent('excess-drift', quantity); await x.runtime.flush();
  const fills = x.fills();
  assert.equal(fills.length, 1);
  const fill = fills[0];
  assert.ok(fill.payload.quantity * fill.payload.entryPrice <= maxExposureUsd + 1e-9, 'fill notional clamped to risk exposure');
  assert.ok(fill.payload.quantity <= quantity);
  assert.equal(x.messages().filter(m => m === 'LIVE_POSITION_CAP').length, 0);
});

test('same-token refresh storm waits for the first intent and rejects an already-open position', async t => {
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const x = await setup(t, { quoteWait: () => { entered(); return blocked; } });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent('first');
  await started;
  try {
    for (let i = 0; i < 25; i++) x.intent('refresh-' + i);
    await x.flushIntake();
    assert.equal(x.messages().filter(m => m === 'LIVE_POSITION_ALREADY_OPEN').length, 0);
    assert.equal(x.calls.filter(p => p.endsWith('/quote')).length, 1);
    assert.equal(x.calls.filter(p => p.endsWith('/swap')).length, 0);
  } finally { release(); }
  await x.runtime.flush();
  assert.equal(x.sent(), 1); assert.equal(x.fills().length, 1);
  assert.equal(x.calls.filter(p => p.endsWith('/quote')).length, 1);
  assert.equal(x.calls.filter(p => p.endsWith('/swap')).length, 1);
  x.intent('already-open'); await x.runtime.flush();
  assert.equal(x.messages().filter(m => m === 'LIVE_POSITION_ALREADY_OPEN').length, 26);
  assert.equal(x.calls.filter(p => p.endsWith('/quote')).length, 1);
});

test('explicit position cap override is honored by mocked Jupiter', async t => {
  const x = await setup(t, { env: { TRADING_MAX_POSITION_USD: '3' } });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent('buy', 3); await x.runtime.flush();
  assert.equal(x.sent(), 1); assert.equal(x.engine.status().caps.position, 3);
});

test('application LIVE routes BUY into live portfolio and DISARM stays safe', async t => {
  const x = await setup(t, { application: true });
  assert.equal(x.application.mode(), 'safe');
  await x.application.live('LIVE_REAL_MONEY'); assert.equal(x.application.mode(), 'live');
  x.intent(); await x.runtime.flush(); await x.application.drainLive();
  assert.equal(x.sent(), 1, x.messages().join(','));
  assert.equal(x.fills()[0].payload.mode, 'live'); assert.ok(x.fills()[0].evidence.includes(x.signature()));
  assert.equal(x.application.tradeStore.snapshot().positions.length, 1);
  assert.equal(x.application.tradeStore.snapshot().performance.fundingId, 'app-valuation');
  await x.application.disarm(); assert.equal(x.application.mode(), 'safe');
  x.intent('after-stop'); await x.runtime.flush(); assert.equal(x.sent(), 1);
});

test('wallet HTTP creates encrypted key, exposes only address, survives restart and enforces confirmation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botmeme-onboarding-'));
  const { createApplication } = require('../runtime/application.cjs');
  const options = { now, capitalUsd: 100, providers: {}, liveConfig: { root, env: {}, fetcher: async () => ({ ok: true, json: async () => ({ result: { value: 0 } }) }) } };
  const app = createApplication(options);
  const service = require('../scripts/serve-meme-trader.cjs').createDashboardServer({ application: app, now, copyPath: null, copyWatch: false });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  let restored;
  t.after(async () => { await service.close(); await restored?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const url = 'http://127.0.0.1:' + service.server.address().port;
  const post = (route, body) => fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.notEqual((await post('/api/control', { action: 'LIVE', confirm: 'LIVE_REAL_MONEY' })).status, 200);
  const response = await post('/api/wallet/trading', { confirm: '' }); assert.equal(response.status, 200);
  const body = await response.json(); assert.deepEqual(Object.keys(body), ['address']); new PublicKey(body.address);
  assert.match(fs.readFileSync(path.join(root, 'wallet-key.env'), 'utf8'), /^TRADING_PRIVATE_KEY=dpapi:/);
  const secret = require('../core/execution/wallet-key.cjs').readKey(path.join(root, 'wallet-key.env'));
  try { assert.equal(bs58.encode(nacl.sign.keyPair.fromSecretKey(secret).publicKey), body.address); assert.equal(JSON.stringify(app.control()).includes(bs58.encode(secret)), false); } finally { secret.fill(0); }
  assert.equal((await post('/api/wallet/trading', { confirm: '' })).status, 409);
  restored = createApplication(options); assert.equal(restored.control().live.owner, body.address); assert.equal(restored.mode(), 'safe');
  assert.equal(restored.control().live.caps.position, 2);
  const balance = await (await fetch(url + '/api/wallet/trading')).json(); assert.equal(balance.balanceSol, 0);
  const disarmed = await (await post('/api/control', { action: 'DISARM' })).json(); assert.equal(disarmed.mode, 'safe');
  await restored.close(); restored = null;
  const replacement = await (await post('/api/wallet/trading', { confirm: 'REGENERATE' })).json();
  assert.notEqual(replacement.address, body.address); new PublicKey(replacement.address);
  restored = createApplication(options); assert.equal(restored.control().live.owner, replacement.address);
});

test('key removal and paper intents never reach a live swap', async t => {
  const x = await setup(t); await x.engine.arm('LIVE_REAL_MONEY');
  x.intent('paper-only', 1, 'BUY', 'paper'); await x.runtime.flush(); await x.engine.drain();
  assert.equal(x.sent(), 0); assert.ok(x.messages().includes('LIVE_PAPER_ONLY_INTENT'));
  fs.unlinkSync(x.keyFile); x.intent('key-removed'); await x.runtime.flush(); await x.engine.drain();
  assert.equal(x.sent(), 0); assert.ok(x.messages().includes('LIVE LOCKED: wallet-key.env missing'));
});
test('LOCKED without key; valid key alone never arms or sends', async t => {
  const x = await setup(t, { missing: true }); x.engine.start();
  assert.ok(x.messages().includes('LIVE LOCKED: wallet-key.env missing'));
  await assert.rejects(x.engine.arm('LIVE_REAL_MONEY'), /wallet-key.env missing/);
  x.intent(); await x.runtime.flush(); assert.equal(x.sent(), 0); assert.equal(x.calls.length, 0);
});
test('invalid key is redacted and exact confirmation is required', async t => {
  const x = await setup(t); await assert.rejects(x.engine.arm('LIVE'), /CONFIRMATION/);
  fs.writeFileSync(x.keyFile, 'TRADING_PRIVATE_KEY=not-a-key');
  await assert.rejects(x.engine.arm('LIVE_REAL_MONEY'), /invalid or wallet mismatch/);
  assert.ok(!JSON.stringify(x.runtime.snapshot()).includes('not-a-key')); assert.equal(x.calls.length, 0);
});
for (const [name, tokenBalances] of [
  ['Token-2022 only with transfer-fee extension', { [TOKEN2022]: ['1000000'] }],
  ['split classic and Token-2022 accounts', { [TOKEN]: ['200000', '300000'], [TOKEN2022]: ['100000', '400000'] }]
]) test(`Jupiter SELL sums matching mint balances: ${name}`, async t => {
  const x = await setup(t, { tokenBalances, unrelatedTokenBalance: true, swapTokenProgram: TOKEN2022 });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  assert.equal(x.fills().length, 1, x.messages().join(','));
  x.intent('sell', 1, 'SELL'); await x.runtime.flush();
  assert.equal(x.sent(), 2, x.messages().join(','));
  assert.equal(x.quote().inAmount, '1000000');
  assert.equal(x.fills().length, 2); assert.equal(x.fills()[1].payload.side, 'SELL');
  assert.equal(x.fills()[1].payload.quantity, 1); validateEvent(x.fills()[1], { now });
  assert.equal(x.engine.portfolio().positions.length, 0);
  assert.deepEqual(x.rpcCalls.filter(c => c.method === 'getTokenAccountsByOwner').map(c => c.params),
    [TOKEN, TOKEN2022].map(programId => [x.config.owner, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }]));
  assert.ok(x.transactions[1].message.compiledInstructions.some(ix => x.transactions[1].message.staticAccountKeys[ix.programIdIndex].toBase58() === TOKEN2022));
});

for (const tokenBalances of [{}, { [TOKEN]: ['0'], [TOKEN2022]: ['0'] }]) test(`SELL zero in both programs retains full-position rejection: ${JSON.stringify(tokenBalances)}`, async t => {
  const x = await setup(t, { tokenBalances, unrelatedTokenBalance: true });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  x.intent('sell', 1, 'SELL'); await x.runtime.flush();
  assert.equal(x.messages().at(-1), 'LIVE_FULL_POSITION_SELL_REQUIRED');
  assert.equal(x.sent(), 1); assert.equal(x.fills().length, 1);
  assert.equal(x.engine.portfolio().positions.length, 1);
});

test('SELL cannot use a partial balance when Token-2022 RPC fails', async t => {
  const x = await setup(t, { rpcResponse: (url, method, params) => method === 'getTokenAccountsByOwner' && params[1].programId === TOKEN2022 ? new Response('down', { status: 503 }) : undefined });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  x.intent('sell', 1, 'SELL'); await x.runtime.flush();
  assert.equal(x.messages().at(-1), 'LIVE_RPC_FAILED'); assert.equal(x.sent(), 1);
  assert.equal(x.engine.portfolio().positions.length, 1);
});

test('mock Jupiter BUY signs once and publishes actual contract-valid live receipt; SELL closes full position', async t => {
  const x = await setup(t); await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  assert.equal(x.sent(), 1); assert.equal(x.fills().length, 1, x.messages().join(','));
  const fill = x.fills()[0]; validateEvent(fill, { now });
  assert.equal(fill.payload.mode, 'live'); assert.equal(fill.payload.quantity, 1); assert.equal(fill.payload.fees, .0005);
  assert.ok(fill.evidence.includes(x.signature())); assert.equal(x.tradeStore.snapshot().positions.length, 0);
  assert.equal(x.engine.portfolio().positions.length, 1);
  x.intent('sell', 1, 'SELL'); await x.runtime.flush(); assert.equal(x.sent(), 2); assert.equal(x.fills().length, 2, x.messages().join(','));
  assert.equal(x.engine.portfolio().positions.length, 0); assert.equal(x.fills()[1].payload.exitPrice, .6);
  assert.deepEqual(x.runtime.snapshot().deliveryErrors, []);
});
for (const [name, options, quantity, reason] of [
  ['gas reserve', { lowBalance: true }, 1, 'LIVE_RESERVE_OR_FEE_BUFFER'],
  ['simulation spend cap', { excessSpend: true }, 1, 'LIVE_POSITION_CAP'], ['safety veto', { veto: true }, 1, 'LIVE_SAFETY_REJECTED'],
  ['kill before signing', { killDuringSwap: true }, 1, 'LIVE_KILL: trading halted'], ['STOP during quote', { stopDuringSwap: true }, 1, 'LIVE_STOPPED'],
  ['remote errors cannot leak keys', { remoteSecret: true }, 1, 'LIVE_REMOTE_UNAVAILABLE']
]) test(name + ' rejects without broadcasting', async t => {
  const x = await setup(t, options); await x.engine.arm('LIVE_REAL_MONEY'); x.intent('buy', quantity); await x.runtime.flush();
  assert.equal(x.sent(), 0); assert.equal(x.fills().length, 0); assert.ok(x.messages().some(message => message.includes(reason)), x.messages().join(','));
  assert.ok(!JSON.stringify(x.runtime.snapshot()).includes(fs.readFileSync(x.keyFile, 'utf8').split('=')[1]));
});
test('kill file blocks arming', async t => {
  const x = await setup(t); fs.writeFileSync(path.join(x.root, 'LIVE_KILL'), '');
  await assert.rejects(x.engine.arm('LIVE_REAL_MONEY'), /LIVE_KILL/); assert.equal(x.calls.length, 0);
});
test('daily loss cap persists across engine restart and blocks new trades', async t => {
  const x = await setup(t, { env: { TRADING_MAX_DAILY_LOSS_USD: '.001' } });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush(); x.intent('sell', 1, 'SELL'); await x.runtime.flush();
  x.intent('next'); await x.runtime.flush(); assert.equal(x.sent(), 2); assert.ok(x.messages().includes('LIVE_DAILY_LOSS_CAP'));
  x.engine.stop(); const next = x.create(); await assert.rejects(next.arm('LIVE_REAL_MONEY'), /DAILY_LOSS_CAP/);
});
test('ambiguous broadcast exhausts endpoints, persists signature, and never resends on restart', async t => {
  const x = await setup(t, { sendUnknown: true }); await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  assert.equal(x.sent(), 2); assert.equal(x.engine.isArmed(), true); assert.equal(x.engine.status().pendingSignature, x.signature());
  assert.equal(bs58.encode(x.transactions[0].signatures[0]), bs58.encode(x.transactions[1].signatures[0]));
  x.engine.stop(); // Simulate shutting down the still-armed instance before restart.
  const next = x.create();
  await next.arm('LIVE_REAL_MONEY'); assert.equal(next.status().state, 'ARMED'); assert.equal(x.sent(), 2);
  const ledger = JSON.parse(fs.readFileSync(path.join(x.root, 'live-state.json'), 'utf8'));
  assert.equal(ledger.pending, null); assert.ok(ledger.claimed.includes('buy/intent'));
  assert.equal(ledger.reconciliations[0].outcome, 'confirmed');
  assert.ok(x.messages().includes('Giao dịch treo đã xác nhận trên chain'));
});

for (const boot of [false, true]) for (const signatureStatus of [null, { err: { InstructionError: [0, 'failed'] } }, { confirmationStatus: 'confirmed', err: null }, { confirmationStatus: 'finalized', err: null }]) test(`pending reconciliation ${boot ? 'boot' : 'arm'}: ${JSON.stringify(signatureStatus)}`, async t => {
  const x = await setup(t, { signatureStatus });
  const pending = { intentId: 'old/intent', signature: bs58.encode(Buffer.alloc(64, 7)), at: stamp };
  fs.writeFileSync(path.join(x.root, 'live-state.json'), JSON.stringify({ version: 1, owner: x.config.owner, pending, claimed: [], fills: [] }));
  const next = x.create();
  if (boot) { await next.start(); assert.equal(next.status().state, 'LOCKED'); }
  await next.arm('LIVE_REAL_MONEY');
  assert.equal(next.status().state, 'ARMED'); assert.equal(next.status().pendingSignature, null);
  const ledger = JSON.parse(fs.readFileSync(path.join(x.root, 'live-state.json'), 'utf8'));
  assert.equal(ledger.pending, null); assert.equal(ledger.reconciliations.length, 1);
  const confirmed = !!signatureStatus?.confirmationStatus;
  assert.equal(ledger.claimed.includes(pending.intentId), confirmed);
  assert.equal(ledger.reconciliations[0].event.payload.message, confirmed ? 'Giao dịch treo đã xác nhận trên chain' : 'Đã đối soát: giao dịch treo không lên chain — mở khóa');
  assert.deepEqual(ledger.reconciliations[0].event.evidence, [pending.signature]);
  validateEvent(ledger.reconciliations[0].event, { now });
  assert.ok(x.messages().includes(ledger.reconciliations[0].event.payload.message));
  assert.equal(x.calls.filter(c => c === 'getSignatureStatuses').length, 1); assert.equal(x.sent(), 0);
});

for (const options of [{ statusError: true }, { statusMalformed: true }, { signatureStatus: { confirmationStatus: 'processed', err: null } }]) test(`unresolved pending stays locked: ${JSON.stringify(options)}`, async t => {
  const x = await setup(t, { ...options, sendUnknown: true });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  const next = x.create();
  await next.start(); await assert.rejects(next.arm('LIVE_REAL_MONEY'), /LIVE_RPC_FAILED|reconciliation required/);
  assert.equal(next.status().pendingSignature, x.signature()); assert.equal(x.sent(), 2);
});

test('boot and arm cannot reconcile a same-process swap actively awaiting broadcast', async t => {
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const x = await setup(t, { sendWait: () => { entered(); return blocked; } });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await started;
  try {
    x.engine.stop(); await x.engine.start();
    await assert.rejects(x.engine.arm('LIVE_REAL_MONEY'), /reconciliation required/);
    assert.equal(x.engine.status().pendingSignature, x.signature());
    assert.equal(x.calls.filter(c => c === 'getSignatureStatuses').length, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(x.root, 'live-state.json'), 'utf8')).pending.signature, x.signature());
  } finally { release(); }
  await x.runtime.flush(); assert.equal(x.fills().length, 1);
});
test('pre-arm backlog is ignored; paper cannot consume live intents even after STOP', async t => {
  const x = await setup(t); x.intent('old'); await x.engine.arm('LIVE_REAL_MONEY'); await x.runtime.flush(); assert.equal(x.sent(), 0);
  const paper = createPaperExecution({ runtime: x.runtime, tradeStore: x.tradeStore, now }); paper.start();
  x.intent('fresh'); await x.runtime.flush(); x.engine.stop(); await x.runtime.flush(); paper.stop();
  assert.equal(x.sent(), 1); assert.equal(x.fills().length, 1); assert.equal(x.fills()[0].payload.mode, 'live');
});
test('application HTTP LIVE requires exact confirmation; STOP and restart remain safe', async t => {
  const x = await setup(t), { createApplication } = require('../runtime/application.cjs');
  const previous = process.env.ONCHAIN_DISCOVERY_ENABLED; process.env.ONCHAIN_DISCOVERY_ENABLED = 'false';
  t.after(() => { if (previous === undefined) delete process.env.ONCHAIN_DISCOVERY_ENABLED; else process.env.ONCHAIN_DISCOVERY_ENABLED = previous; });
  // All external fetch calls fail locally; only node:http talks to the test server.
  t.mock.method(globalThis, 'fetch', async () => { throw Error('External network forbidden in live tests'); });
  const options = { now, capitalUsd: 100, liveConfig: x.config, valuationReader: { read: async () => ({ ...x.runtime.get('valuation'), id: 'http-value' }) }, providers: { SOLANA: { network: 'SOLANA', discover: async () => [], snapshot: async () => { throw Error('No fixture'); } } } };
  const app = createApplication(options);
  assert.equal(app.control().running, false); assert.equal(app.mode(), 'safe');
  await app.connect({ network: 'SOLANA', address: x.config.owner, chainId: 'mainnet-beta', provider: 'okx' });
  const service = require('../scripts/serve-meme-trader.cjs').createDashboardServer({ application: app, now, copyWatch: false, copyPath: path.join(x.root, 'copy.json') });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(() => service.close());
  const post = body => new Promise((resolve, reject) => {
    const request = require('node:http').request({ hostname: '127.0.0.1', port: service.server.address().port, path: '/api/control', method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
      let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    }); request.on('error', reject); request.end(JSON.stringify(body));
  });
  assert.equal((await post({ action: 'LIVE' })).status, 400);
  assert.equal((await post({ action: 'LIVE', confirm: 'LIVE' })).body.error, 'LIVE_CONFIRMATION_REQUIRED');
  assert.equal(app.mode(), 'safe');
  const armed = await post({ action: 'LIVE', confirm: 'LIVE_REAL_MONEY' });
  assert.equal(armed.status, 200); assert.equal(armed.body.mode, 'live'); assert.equal(armed.body.live.balanceSol, .1963); assert.equal(armed.body.paperExit, false);
  await assert.rejects(app.buyPaper({}), /PAPER_CONTROLS_DISABLED/);
  assert.equal((await post({ action: 'STOP' })).body.mode, 'safe'); assert.equal(app.control().running, false); assert.equal(x.sent(), 0);
  const fresh = createApplication(options); assert.equal(fresh.mode(), 'safe'); assert.equal(fresh.control().running, false); await fresh.close();
});
test('dashboard requires typed LIVE and renders chain balance only while live/safe', () => {
  const source = fs.readFileSync(require.resolve('../public/meme-trader/wallet.js'), 'utf8');
  assert.match(source, /dialog\.returnValue === 'arm' && dialog\.querySelector\('input'\)\.value === 'LIVE'/);
  assert.match(source, /confirm: 'LIVE_REAL_MONEY'/);
  const script = fs.readFileSync(require.resolve('../public/meme-trader/app.js'), 'utf8');
  const nodes = new Map(), $ = key => { if (!nodes.has(key)) nodes.set(key, {}); return nodes.get(key); };
  const context = { $, selectedDiscovery: null, snapshot: { version: 1, control: { mode: 'live', live: { balanceSol: .1963 } }, paperWallet: { solBalance: 999 } }, document: { documentElement: { dataset: {} } } };
  for (const name of ['renderWithdrawal', 'renderAgents', 'renderTrades', 'renderOverview', 'renderEvents', 'renderChart', 'renderProtection', 'renderDiscoveries', 'renderDetail']) context[name] = () => {};
  require('node:vm').runInNewContext(script.slice(script.indexOf('  function render() {'), script.indexOf('  const stream =')) + '\nrender();', context);
  assert.equal($('#trading-sol').textContent, '0.1963 SOL');
});

test('same-token refresh storm waits for the first intent and rejects an already-open position', async t => {
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const x = await setup(t, { quoteWait: () => { entered(); return blocked; } });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent('first');
  await started;
  try {
    for (let i = 0; i < 25; i++) x.intent('refresh-' + i);
    await x.flushIntake();
    assert.equal(x.messages().filter(m => m === 'LIVE_POSITION_ALREADY_OPEN').length, 0);
    assert.equal(x.calls.filter(p => p.endsWith('/quote')).length, 1);
    assert.equal(x.calls.filter(p => p.endsWith('/swap')).length, 0);
  } finally { release(); }
  await x.runtime.flush();
  assert.equal(x.sent(), 1); assert.equal(x.fills().length, 1);
  assert.equal(x.calls.filter(p => p.endsWith('/quote')).length, 1);
  assert.equal(x.calls.filter(p => p.endsWith('/swap')).length, 1);
  x.intent('already-open'); await x.runtime.flush();
  assert.equal(x.messages().filter(m => m === 'LIVE_POSITION_ALREADY_OPEN').length, 26);
  assert.equal(x.calls.filter(p => p.endsWith('/quote')).length, 1);
});

test('explicit position cap override is honored by mocked Jupiter', async t => {
  const x = await setup(t, { env: { TRADING_MAX_POSITION_USD: '3' } });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent('buy', 3); await x.runtime.flush();
  assert.equal(x.sent(), 1); assert.equal(x.engine.status().caps.position, 3);
});

test('application LIVE routes BUY into live portfolio and DISARM stays safe', async t => {
  const x = await setup(t, { application: true });
  assert.equal(x.application.mode(), 'safe');
  await x.application.live('LIVE_REAL_MONEY'); assert.equal(x.application.mode(), 'live');
  x.intent(); await x.runtime.flush(); await x.application.drainLive();
  assert.equal(x.sent(), 1, x.messages().join(','));
  assert.equal(x.fills()[0].payload.mode, 'live'); assert.ok(x.fills()[0].evidence.includes(x.signature()));
  assert.equal(x.application.tradeStore.snapshot().positions.length, 1);
  assert.equal(x.application.tradeStore.snapshot().performance.fundingId, 'app-valuation');
  await x.application.disarm(); assert.equal(x.application.mode(), 'safe');
  x.intent('after-stop'); await x.runtime.flush(); assert.equal(x.sent(), 1);
});

test('wallet HTTP creates encrypted key, exposes only address, survives restart and enforces confirmation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botmeme-onboarding-'));
  const { createApplication } = require('../runtime/application.cjs');
  const options = { now, capitalUsd: 100, providers: {}, liveConfig: { root, env: {}, fetcher: async () => ({ ok: true, json: async () => ({ result: { value: 0 } }) }) } };
  const app = createApplication(options);
  const service = require('../scripts/serve-meme-trader.cjs').createDashboardServer({ application: app, now, copyPath: null, copyWatch: false });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  let restored;
  t.after(async () => { await service.close(); await restored?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const url = 'http://127.0.0.1:' + service.server.address().port;
  const post = (route, body) => fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.notEqual((await post('/api/control', { action: 'LIVE', confirm: 'LIVE_REAL_MONEY' })).status, 200);
  const response = await post('/api/wallet/trading', { confirm: '' }); assert.equal(response.status, 200);
  const body = await response.json(); assert.deepEqual(Object.keys(body), ['address']); new PublicKey(body.address);
  assert.match(fs.readFileSync(path.join(root, 'wallet-key.env'), 'utf8'), /^TRADING_PRIVATE_KEY=dpapi:/);
  const secret = require('../core/execution/wallet-key.cjs').readKey(path.join(root, 'wallet-key.env'));
  try { assert.equal(bs58.encode(nacl.sign.keyPair.fromSecretKey(secret).publicKey), body.address); assert.equal(JSON.stringify(app.control()).includes(bs58.encode(secret)), false); } finally { secret.fill(0); }
  assert.equal((await post('/api/wallet/trading', { confirm: '' })).status, 409);
  restored = createApplication(options); assert.equal(restored.control().live.owner, body.address); assert.equal(restored.mode(), 'safe');
  assert.equal(restored.control().live.caps.position, 2);
  const balance = await (await fetch(url + '/api/wallet/trading')).json(); assert.equal(balance.balanceSol, 0);
  const disarmed = await (await post('/api/control', { action: 'DISARM' })).json(); assert.equal(disarmed.mode, 'safe');
  await restored.close(); restored = null;
  const replacement = await (await post('/api/wallet/trading', { confirm: 'REGENERATE' })).json();
  assert.notEqual(replacement.address, body.address); new PublicKey(replacement.address);
  restored = createApplication(options); assert.equal(restored.control().live.owner, replacement.address);
});

test('key removal and paper intents never reach a live swap', async t => {
  const x = await setup(t); await x.engine.arm('LIVE_REAL_MONEY');
  x.intent('paper-only', 1, 'BUY', 'paper'); await x.runtime.flush(); await x.engine.drain();
  assert.equal(x.sent(), 0); assert.ok(x.messages().includes('LIVE_PAPER_ONLY_INTENT'));
  fs.unlinkSync(x.keyFile); x.intent('key-removed'); await x.runtime.flush(); await x.engine.drain();
  assert.equal(x.sent(), 0); assert.ok(x.messages().includes('LIVE LOCKED: wallet-key.env missing'));
});
test('LOCKED without key; valid key alone never arms or sends', async t => {
  const x = await setup(t, { missing: true }); x.engine.start();
  assert.ok(x.messages().includes('LIVE LOCKED: wallet-key.env missing'));
  await assert.rejects(x.engine.arm('LIVE_REAL_MONEY'), /wallet-key.env missing/);
  x.intent(); await x.runtime.flush(); assert.equal(x.sent(), 0); assert.equal(x.calls.length, 0);
});
test('invalid key is redacted and exact confirmation is required', async t => {
  const x = await setup(t); await assert.rejects(x.engine.arm('LIVE'), /CONFIRMATION/);
  fs.writeFileSync(x.keyFile, 'TRADING_PRIVATE_KEY=not-a-key');
  await assert.rejects(x.engine.arm('LIVE_REAL_MONEY'), /invalid or wallet mismatch/);
  assert.ok(!JSON.stringify(x.runtime.snapshot()).includes('not-a-key')); assert.equal(x.calls.length, 0);
});
test('mock Jupiter BUY signs once and publishes actual contract-valid live receipt; SELL closes full position', async t => {
  const x = await setup(t); await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  assert.equal(x.sent(), 1); assert.equal(x.fills().length, 1, x.messages().join(','));
  const fill = x.fills()[0]; validateEvent(fill, { now });
  assert.equal(fill.payload.mode, 'live'); assert.equal(fill.payload.quantity, 1); assert.equal(fill.payload.fees, .0005);
  assert.ok(fill.evidence.includes(x.signature())); assert.equal(x.tradeStore.snapshot().positions.length, 0);
  assert.equal(x.engine.portfolio().positions.length, 1);
  x.intent('sell', 1, 'SELL'); await x.runtime.flush(); assert.equal(x.sent(), 2); assert.equal(x.fills().length, 2, x.messages().join(','));
  assert.equal(x.engine.portfolio().positions.length, 0); assert.equal(x.fills()[1].payload.exitPrice, .6);
  assert.deepEqual(x.runtime.snapshot().deliveryErrors, []);
});
for (const [name, options, quantity, reason] of [
  ['gas reserve', { lowBalance: true }, 1, 'LIVE_RESERVE_OR_FEE_BUFFER'],
  ['simulation spend cap', { excessSpend: true }, 1, 'LIVE_POSITION_CAP'], ['safety veto', { veto: true }, 1, 'LIVE_SAFETY_REJECTED'],
  ['kill before signing', { killDuringSwap: true }, 1, 'LIVE_KILL: trading halted'], ['STOP during quote', { stopDuringSwap: true }, 1, 'LIVE_STOPPED'],
  ['remote errors cannot leak keys', { remoteSecret: true }, 1, 'LIVE_REMOTE_UNAVAILABLE']
]) test(name + ' rejects without broadcasting', async t => {
  const x = await setup(t, options); await x.engine.arm('LIVE_REAL_MONEY'); x.intent('buy', quantity); await x.runtime.flush();
  assert.equal(x.sent(), 0); assert.equal(x.fills().length, 0); assert.ok(x.messages().some(message => message.includes(reason)), x.messages().join(','));
  assert.ok(!JSON.stringify(x.runtime.snapshot()).includes(fs.readFileSync(x.keyFile, 'utf8').split('=')[1]));
});
test('kill file blocks arming', async t => {
  const x = await setup(t); fs.writeFileSync(path.join(x.root, 'LIVE_KILL'), '');
  await assert.rejects(x.engine.arm('LIVE_REAL_MONEY'), /LIVE_KILL/); assert.equal(x.calls.length, 0);
});
test('daily loss cap persists across engine restart and blocks new trades', async t => {
  const x = await setup(t, { env: { TRADING_MAX_DAILY_LOSS_USD: '.001' } });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush(); x.intent('sell', 1, 'SELL'); await x.runtime.flush();
  x.intent('next'); await x.runtime.flush(); assert.equal(x.sent(), 2); assert.ok(x.messages().includes('LIVE_DAILY_LOSS_CAP'));
  x.engine.stop(); const next = x.create(); await assert.rejects(next.arm('LIVE_REAL_MONEY'), /DAILY_LOSS_CAP/);
});
test('ambiguous broadcast exhausts endpoints, persists signature, and never resends on restart', async t => {
  const x = await setup(t, { sendUnknown: true }); await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  assert.equal(x.sent(), 2); assert.equal(x.engine.isArmed(), true); assert.equal(x.engine.status().pendingSignature, x.signature());
  assert.equal(bs58.encode(x.transactions[0].signatures[0]), bs58.encode(x.transactions[1].signatures[0]));
  x.engine.stop(); // Simulate shutting down the still-armed instance before restart.
  const next = x.create();
  await next.arm('LIVE_REAL_MONEY'); assert.equal(next.status().state, 'ARMED'); assert.equal(x.sent(), 2);
  const ledger = JSON.parse(fs.readFileSync(path.join(x.root, 'live-state.json'), 'utf8'));
  assert.equal(ledger.pending, null); assert.ok(ledger.claimed.includes('buy/intent'));
  assert.equal(ledger.reconciliations[0].outcome, 'confirmed');
  assert.ok(x.messages().includes('Giao dịch treo đã xác nhận trên chain'));
});

for (const boot of [false, true]) for (const signatureStatus of [null, { err: { InstructionError: [0, 'failed'] } }, { confirmationStatus: 'confirmed', err: null }, { confirmationStatus: 'finalized', err: null }]) test(`pending reconciliation ${boot ? 'boot' : 'arm'}: ${JSON.stringify(signatureStatus)}`, async t => {
  const x = await setup(t, { signatureStatus });
  const pending = { intentId: 'old/intent', signature: bs58.encode(Buffer.alloc(64, 7)), at: stamp };
  fs.writeFileSync(path.join(x.root, 'live-state.json'), JSON.stringify({ version: 1, owner: x.config.owner, pending, claimed: [], fills: [] }));
  const next = x.create();
  if (boot) { await next.start(); assert.equal(next.status().state, 'LOCKED'); }
  await next.arm('LIVE_REAL_MONEY');
  assert.equal(next.status().state, 'ARMED'); assert.equal(next.status().pendingSignature, null);
  const ledger = JSON.parse(fs.readFileSync(path.join(x.root, 'live-state.json'), 'utf8'));
  assert.equal(ledger.pending, null); assert.equal(ledger.reconciliations.length, 1);
  const confirmed = !!signatureStatus?.confirmationStatus;
  assert.equal(ledger.claimed.includes(pending.intentId), confirmed);
  assert.equal(ledger.reconciliations[0].event.payload.message, confirmed ? 'Giao dịch treo đã xác nhận trên chain' : 'Đã đối soát: giao dịch treo không lên chain — mở khóa');
  assert.deepEqual(ledger.reconciliations[0].event.evidence, [pending.signature]);
  validateEvent(ledger.reconciliations[0].event, { now });
  assert.ok(x.messages().includes(ledger.reconciliations[0].event.payload.message));
  assert.equal(x.calls.filter(c => c === 'getSignatureStatuses').length, 1); assert.equal(x.sent(), 0);
});

for (const options of [{ statusError: true }, { statusMalformed: true }, { signatureStatus: { confirmationStatus: 'processed', err: null } }]) test(`unresolved pending stays locked: ${JSON.stringify(options)}`, async t => {
  const x = await setup(t, { ...options, sendUnknown: true });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  const next = x.create();
  await next.start(); await assert.rejects(next.arm('LIVE_REAL_MONEY'), /LIVE_RPC_FAILED|reconciliation required/);
  assert.equal(next.status().pendingSignature, x.signature()); assert.equal(x.sent(), 2);
});

test('boot and arm cannot reconcile a same-process swap actively awaiting broadcast', async t => {
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const x = await setup(t, { sendWait: () => { entered(); return blocked; } });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await started;
  try {
    x.engine.stop(); await x.engine.start();
    await assert.rejects(x.engine.arm('LIVE_REAL_MONEY'), /reconciliation required/);
    assert.equal(x.engine.status().pendingSignature, x.signature());
    assert.equal(x.calls.filter(c => c === 'getSignatureStatuses').length, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(x.root, 'live-state.json'), 'utf8')).pending.signature, x.signature());
  } finally { release(); }
  await x.runtime.flush(); assert.equal(x.fills().length, 1);
});
test('pre-arm backlog is ignored; paper cannot consume live intents even after STOP', async t => {
  const x = await setup(t); x.intent('old'); await x.engine.arm('LIVE_REAL_MONEY'); await x.runtime.flush(); assert.equal(x.sent(), 0);
  const paper = createPaperExecution({ runtime: x.runtime, tradeStore: x.tradeStore, now }); paper.start();
  x.intent('fresh'); await x.runtime.flush(); x.engine.stop(); await x.runtime.flush(); paper.stop();
  assert.equal(x.sent(), 1); assert.equal(x.fills().length, 1); assert.equal(x.fills()[0].payload.mode, 'live');
});
test('application HTTP LIVE requires exact confirmation; STOP and restart remain safe', async t => {
  const x = await setup(t), { createApplication } = require('../runtime/application.cjs');
  const previous = process.env.ONCHAIN_DISCOVERY_ENABLED; process.env.ONCHAIN_DISCOVERY_ENABLED = 'false';
  t.after(() => { if (previous === undefined) delete process.env.ONCHAIN_DISCOVERY_ENABLED; else process.env.ONCHAIN_DISCOVERY_ENABLED = previous; });
  // All external fetch calls fail locally; only node:http talks to the test server.
  t.mock.method(globalThis, 'fetch', async () => { throw Error('External network forbidden in live tests'); });
  const options = { now, capitalUsd: 100, liveConfig: x.config, valuationReader: { read: async () => ({ ...x.runtime.get('valuation'), id: 'http-value' }) }, providers: { SOLANA: { network: 'SOLANA', discover: async () => [], snapshot: async () => { throw Error('No fixture'); } } } };
  const app = createApplication(options);
  assert.equal(app.control().running, false); assert.equal(app.mode(), 'safe');
  await app.connect({ network: 'SOLANA', address: x.config.owner, chainId: 'mainnet-beta', provider: 'okx' });
  const service = require('../scripts/serve-meme-trader.cjs').createDashboardServer({ application: app, now, copyWatch: false, copyPath: path.join(x.root, 'copy.json') });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(() => service.close());
  const post = body => new Promise((resolve, reject) => {
    const request = require('node:http').request({ hostname: '127.0.0.1', port: service.server.address().port, path: '/api/control', method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
      let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    }); request.on('error', reject); request.end(JSON.stringify(body));
  });
  assert.equal((await post({ action: 'LIVE' })).status, 400);
  assert.equal((await post({ action: 'LIVE', confirm: 'LIVE' })).body.error, 'LIVE_CONFIRMATION_REQUIRED');
  assert.equal(app.mode(), 'safe');
  const armed = await post({ action: 'LIVE', confirm: 'LIVE_REAL_MONEY' });
  assert.equal(armed.status, 200); assert.equal(armed.body.mode, 'live'); assert.equal(armed.body.live.balanceSol, .1963); assert.equal(armed.body.paperExit, false);
  await assert.rejects(app.buyPaper({}), /PAPER_CONTROLS_DISABLED/);
  assert.equal((await post({ action: 'STOP' })).body.mode, 'safe'); assert.equal(app.control().running, false); assert.equal(x.sent(), 0);
  const fresh = createApplication(options); assert.equal(fresh.mode(), 'safe'); assert.equal(fresh.control().running, false); await fresh.close();
});
test('dashboard requires typed LIVE and renders chain balance only while live/safe', () => {
  const source = fs.readFileSync(require.resolve('../public/meme-trader/wallet.js'), 'utf8');
  assert.match(source, /dialog\.returnValue === 'arm' && dialog\.querySelector\('input'\)\.value === 'LIVE'/);
  assert.match(source, /confirm: 'LIVE_REAL_MONEY'/);
  const script = fs.readFileSync(require.resolve('../public/meme-trader/app.js'), 'utf8');
  const nodes = new Map(), $ = key => { if (!nodes.has(key)) nodes.set(key, {}); return nodes.get(key); };
  const context = { $, selectedDiscovery: null, snapshot: { version: 1, control: { mode: 'live', live: { balanceSol: .1963 } }, paperWallet: { solBalance: 999 } }, document: { documentElement: { dataset: {} } } };
  for (const name of ['renderWithdrawal', 'renderAgents', 'renderTrades', 'renderOverview', 'renderEvents', 'renderChart', 'renderProtection', 'renderDiscoveries', 'renderDetail']) context[name] = () => {};
  require('node:vm').runInNewContext(script.slice(script.indexOf('  function render() {'), script.indexOf('  const stream =')) + '\nrender();', context);
  assert.equal($('#trading-sol').textContent, '0.1963 SOL');
});

test('same-token refresh storm waits for the first intent and rejects an already-open position', async t => {
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const x = await setup(t, { quoteWait: () => { entered(); return blocked; } });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent('first');
  await started;
  try {
    for (let i = 0; i < 25; i++) x.intent('refresh-' + i);
    await x.flushIntake();
    assert.equal(x.messages().filter(m => m === 'LIVE_POSITION_ALREADY_OPEN').length, 0);
    assert.equal(x.calls.filter(p => p.endsWith('/quote')).length, 1);
    assert.equal(x.calls.filter(p => p.endsWith('/swap')).length, 0);
  } finally { release(); }
  await x.runtime.flush();
  assert.equal(x.sent(), 1); assert.equal(x.fills().length, 1);
  assert.equal(x.calls.filter(p => p.endsWith('/quote')).length, 1);
  assert.equal(x.calls.filter(p => p.endsWith('/swap')).length, 1);
  x.intent('already-open'); await x.runtime.flush();
  assert.equal(x.messages().filter(m => m === 'LIVE_POSITION_ALREADY_OPEN').length, 26);
  assert.equal(x.calls.filter(p => p.endsWith('/quote')).length, 1);
});

test('explicit position cap override is honored by mocked Jupiter', async t => {
  const x = await setup(t, { env: { TRADING_MAX_POSITION_USD: '3' } });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent('buy', 3); await x.runtime.flush();
  assert.equal(x.sent(), 1); assert.equal(x.engine.status().caps.position, 3);
});

test('application LIVE routes BUY into live portfolio and DISARM stays safe', async t => {
  const x = await setup(t, { application: true });
  assert.equal(x.application.mode(), 'safe');
  await x.application.live('LIVE_REAL_MONEY'); assert.equal(x.application.mode(), 'live');
  x.intent(); await x.runtime.flush(); await x.application.drainLive();
  assert.equal(x.sent(), 1, x.messages().join(','));
  assert.equal(x.fills()[0].payload.mode, 'live'); assert.ok(x.fills()[0].evidence.includes(x.signature()));
  assert.equal(x.application.tradeStore.snapshot().positions.length, 1);
  assert.equal(x.application.tradeStore.snapshot().performance.fundingId, 'app-valuation');
  await x.application.disarm(); assert.equal(x.application.mode(), 'safe');
  x.intent('after-stop'); await x.runtime.flush(); assert.equal(x.sent(), 1);
});

test('wallet HTTP creates encrypted key, exposes only address, survives restart and enforces confirmation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botmeme-onboarding-'));
  const { createApplication } = require('../runtime/application.cjs');
  const options = { now, capitalUsd: 100, providers: {}, liveConfig: { root, env: {}, fetcher: async () => ({ ok: true, json: async () => ({ result: { value: 0 } }) }) } };
  const app = createApplication(options);
  const service = require('../scripts/serve-meme-trader.cjs').createDashboardServer({ application: app, now, copyPath: null, copyWatch: false });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  let restored;
  t.after(async () => { await service.close(); await restored?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const url = 'http://127.0.0.1:' + service.server.address().port;
  const post = (route, body) => fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.notEqual((await post('/api/control', { action: 'LIVE', confirm: 'LIVE_REAL_MONEY' })).status, 200);
  const response = await post('/api/wallet/trading', { confirm: '' }); assert.equal(response.status, 200);
  const body = await response.json(); assert.deepEqual(Object.keys(body), ['address']); new PublicKey(body.address);
  assert.match(fs.readFileSync(path.join(root, 'wallet-key.env'), 'utf8'), /^TRADING_PRIVATE_KEY=dpapi:/);
  const secret = require('../core/execution/wallet-key.cjs').readKey(path.join(root, 'wallet-key.env'));
  try { assert.equal(bs58.encode(nacl.sign.keyPair.fromSecretKey(secret).publicKey), body.address); assert.equal(JSON.stringify(app.control()).includes(bs58.encode(secret)), false); } finally { secret.fill(0); }
  assert.equal((await post('/api/wallet/trading', { confirm: '' })).status, 409);
  restored = createApplication(options); assert.equal(restored.control().live.owner, body.address); assert.equal(restored.mode(), 'safe');
  assert.equal(restored.control().live.caps.position, 2);
  const balance = await (await fetch(url + '/api/wallet/trading')).json(); assert.equal(balance.balanceSol, 0);
  const disarmed = await (await post('/api/control', { action: 'DISARM' })).json(); assert.equal(disarmed.mode, 'safe');
  await restored.close(); restored = null;
  const replacement = await (await post('/api/wallet/trading', { confirm: 'REGENERATE' })).json();
  assert.notEqual(replacement.address, body.address); new PublicKey(replacement.address);
  restored = createApplication(options); assert.equal(restored.control().live.owner, replacement.address);
});

test('key removal and paper intents never reach a live swap', async t => {
  const x = await setup(t); await x.engine.arm('LIVE_REAL_MONEY');
  x.intent('paper-only', 1, 'BUY', 'paper'); await x.runtime.flush(); await x.engine.drain();
  assert.equal(x.sent(), 0); assert.ok(x.messages().includes('LIVE_PAPER_ONLY_INTENT'));
  fs.unlinkSync(x.keyFile); x.intent('key-removed'); await x.runtime.flush(); await x.engine.drain();
  assert.equal(x.sent(), 0); assert.ok(x.messages().includes('LIVE LOCKED: wallet-key.env missing'));
});
test('LOCKED without key; valid key alone never arms or sends', async t => {
  const x = await setup(t, { missing: true }); x.engine.start();
  assert.ok(x.messages().includes('LIVE LOCKED: wallet-key.env missing'));
  await assert.rejects(x.engine.arm('LIVE_REAL_MONEY'), /wallet-key.env missing/);
  x.intent(); await x.runtime.flush(); assert.equal(x.sent(), 0); assert.equal(x.calls.length, 0);
});
test('invalid key is redacted and exact confirmation is required', async t => {
  const x = await setup(t); await assert.rejects(x.engine.arm('LIVE'), /CONFIRMATION/);
  fs.writeFileSync(x.keyFile, 'TRADING_PRIVATE_KEY=not-a-key');
  await assert.rejects(x.engine.arm('LIVE_REAL_MONEY'), /invalid or wallet mismatch/);
  assert.ok(!JSON.stringify(x.runtime.snapshot()).includes('not-a-key')); assert.equal(x.calls.length, 0);
});
test('mock Jupiter BUY signs once and publishes actual contract-valid live receipt; SELL closes full position', async t => {
  const x = await setup(t); await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  assert.equal(x.sent(), 1); assert.equal(x.fills().length, 1, x.messages().join(','));
  const fill = x.fills()[0]; validateEvent(fill, { now });
  assert.equal(fill.payload.mode, 'live'); assert.equal(fill.payload.quantity, 1); assert.equal(fill.payload.fees, .0005);
  assert.ok(fill.evidence.includes(x.signature())); assert.equal(x.tradeStore.snapshot().positions.length, 0);
  assert.equal(x.engine.portfolio().positions.length, 1);
  x.intent('sell', 1, 'SELL'); await x.runtime.flush(); assert.equal(x.sent(), 2); assert.equal(x.fills().length, 2, x.messages().join(','));
  assert.equal(x.engine.portfolio().positions.length, 0); assert.equal(x.fills()[1].payload.exitPrice, .6);
  assert.deepEqual(x.runtime.snapshot().deliveryErrors, []);
});
for (const [name, options, quantity, reason] of [
  ['gas reserve', { lowBalance: true }, 1, 'LIVE_RESERVE_OR_FEE_BUFFER'],
  ['simulation spend cap', { excessSpend: true }, 1, 'LIVE_POSITION_CAP'], ['safety veto', { veto: true }, 1, 'LIVE_SAFETY_REJECTED'],
  ['kill before signing', { killDuringSwap: true }, 1, 'LIVE_KILL: trading halted'], ['STOP during quote', { stopDuringSwap: true }, 1, 'LIVE_STOPPED'],
  ['remote errors cannot leak keys', { remoteSecret: true }, 1, 'LIVE_REMOTE_UNAVAILABLE']
]) test(name + ' rejects without broadcasting', async t => {
  const x = await setup(t, options); await x.engine.arm('LIVE_REAL_MONEY'); x.intent('buy', quantity); await x.runtime.flush();
  assert.equal(x.sent(), 0); assert.equal(x.fills().length, 0); assert.ok(x.messages().some(message => message.includes(reason)), x.messages().join(','));
  assert.ok(!JSON.stringify(x.runtime.snapshot()).includes(fs.readFileSync(x.keyFile, 'utf8').split('=')[1]));
});
test('kill file blocks arming', async t => {
  const x = await setup(t); fs.writeFileSync(path.join(x.root, 'LIVE_KILL'), '');
  await assert.rejects(x.engine.arm('LIVE_REAL_MONEY'), /LIVE_KILL/); assert.equal(x.calls.length, 0);
});
test('daily loss cap persists across engine restart and blocks new trades', async t => {
  const x = await setup(t, { env: { TRADING_MAX_DAILY_LOSS_USD: '.001' } });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush(); x.intent('sell', 1, 'SELL'); await x.runtime.flush();
  x.intent('next'); await x.runtime.flush(); assert.equal(x.sent(), 2); assert.ok(x.messages().includes('LIVE_DAILY_LOSS_CAP'));
  x.engine.stop(); const next = x.create(); await assert.rejects(next.arm('LIVE_REAL_MONEY'), /DAILY_LOSS_CAP/);
});
test('ambiguous broadcast exhausts endpoints, persists signature, and never resends on restart', async t => {
  const x = await setup(t, { sendUnknown: true }); await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  assert.equal(x.sent(), 2); assert.equal(x.engine.isArmed(), true); assert.equal(x.engine.status().pendingSignature, x.signature());
  assert.equal(bs58.encode(x.transactions[0].signatures[0]), bs58.encode(x.transactions[1].signatures[0]));
  x.engine.stop(); // Simulate shutting down the still-armed instance before restart.
  const next = x.create();
  await next.arm('LIVE_REAL_MONEY'); assert.equal(next.status().state, 'ARMED'); assert.equal(x.sent(), 2);
  const ledger = JSON.parse(fs.readFileSync(path.join(x.root, 'live-state.json'), 'utf8'));
  assert.equal(ledger.pending, null); assert.ok(ledger.claimed.includes('buy/intent'));
  assert.equal(ledger.reconciliations[0].outcome, 'confirmed');
  assert.ok(x.messages().includes('Giao dịch treo đã xác nhận trên chain'));
});

for (const boot of [false, true]) for (const signatureStatus of [null, { err: { InstructionError: [0, 'failed'] } }, { confirmationStatus: 'confirmed', err: null }, { confirmationStatus: 'finalized', err: null }]) test(`pending reconciliation ${boot ? 'boot' : 'arm'}: ${JSON.stringify(signatureStatus)}`, async t => {
  const x = await setup(t, { signatureStatus });
  const pending = { intentId: 'old/intent', signature: bs58.encode(Buffer.alloc(64, 7)), at: stamp };
  fs.writeFileSync(path.join(x.root, 'live-state.json'), JSON.stringify({ version: 1, owner: x.config.owner, pending, claimed: [], fills: [] }));
  const next = x.create();
  if (boot) { await next.start(); assert.equal(next.status().state, 'LOCKED'); }
  await next.arm('LIVE_REAL_MONEY');
  assert.equal(next.status().state, 'ARMED'); assert.equal(next.status().pendingSignature, null);
  const ledger = JSON.parse(fs.readFileSync(path.join(x.root, 'live-state.json'), 'utf8'));
  assert.equal(ledger.pending, null); assert.equal(ledger.reconciliations.length, 1);
  const confirmed = !!signatureStatus?.confirmationStatus;
  assert.equal(ledger.claimed.includes(pending.intentId), confirmed);
  assert.equal(ledger.reconciliations[0].event.payload.message, confirmed ? 'Giao dịch treo đã xác nhận trên chain' : 'Đã đối soát: giao dịch treo không lên chain — mở khóa');
  assert.deepEqual(ledger.reconciliations[0].event.evidence, [pending.signature]);
  validateEvent(ledger.reconciliations[0].event, { now });
  assert.ok(x.messages().includes(ledger.reconciliations[0].event.payload.message));
  assert.equal(x.calls.filter(c => c === 'getSignatureStatuses').length, 1); assert.equal(x.sent(), 0);
});

for (const options of [{ statusError: true }, { statusMalformed: true }, { signatureStatus: { confirmationStatus: 'processed', err: null } }]) test(`unresolved pending stays locked: ${JSON.stringify(options)}`, async t => {
  const x = await setup(t, { ...options, sendUnknown: true });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await x.runtime.flush();
  const next = x.create();
  await next.start(); await assert.rejects(next.arm('LIVE_REAL_MONEY'), /LIVE_RPC_FAILED|reconciliation required/);
  assert.equal(next.status().pendingSignature, x.signature()); assert.equal(x.sent(), 2);
});

test('boot and arm cannot reconcile a same-process swap actively awaiting broadcast', async t => {
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const x = await setup(t, { sendWait: () => { entered(); return blocked; } });
  await x.engine.arm('LIVE_REAL_MONEY'); x.intent(); await started;
  try {
    x.engine.stop(); await x.engine.start();
    await assert.rejects(x.engine.arm('LIVE_REAL_MONEY'), /reconciliation required/);
    assert.equal(x.engine.status().pendingSignature, x.signature());
    assert.equal(x.calls.filter(c => c === 'getSignatureStatuses').length, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(x.root, 'live-state.json'), 'utf8')).pending.signature, x.signature());
  } finally { release(); }
  await x.runtime.flush(); assert.equal(x.fills().length, 1);
});
test('pre-arm backlog is ignored; paper cannot consume live intents even after STOP', async t => {
  const x = await setup(t); x.intent('old'); await x.engine.arm('LIVE_REAL_MONEY'); await x.runtime.flush(); assert.equal(x.sent(), 0);
  const paper = createPaperExecution({ runtime: x.runtime, tradeStore: x.tradeStore, now }); paper.start();
  x.intent('fresh'); await x.runtime.flush(); x.engine.stop(); await x.runtime.flush(); paper.stop();
  assert.equal(x.sent(), 1); assert.equal(x.fills().length, 1); assert.equal(x.fills()[0].payload.mode, 'live');
});
test('application HTTP LIVE requires exact confirmation; STOP and restart remain safe', async t => {
  const x = await setup(t), { createApplication } = require('../runtime/application.cjs');
  const previous = process.env.ONCHAIN_DISCOVERY_ENABLED; process.env.ONCHAIN_DISCOVERY_ENABLED = 'false';
  t.after(() => { if (previous === undefined) delete process.env.ONCHAIN_DISCOVERY_ENABLED; else process.env.ONCHAIN_DISCOVERY_ENABLED = previous; });
  // All external fetch calls fail locally; only node:http talks to the test server.
  t.mock.method(globalThis, 'fetch', async () => { throw Error('External network forbidden in live tests'); });
  const options = { now, capitalUsd: 100, liveConfig: x.config, valuationReader: { read: async () => ({ ...x.runtime.get('valuation'), id: 'http-value' }) }, providers: { SOLANA: { network: 'SOLANA', discover: async () => [], snapshot: async () => { throw Error('No fixture'); } } } };
  const app = createApplication(options);
  assert.equal(app.control().running, false); assert.equal(app.mode(), 'safe');
  await app.connect({ network: 'SOLANA', address: x.config.owner, chainId: 'mainnet-beta', provider: 'okx' });
  const service = require('../scripts/serve-meme-trader.cjs').createDashboardServer({ application: app, now, copyWatch: false, copyPath: path.join(x.root, 'copy.json') });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(() => service.close());
  const post = body => new Promise((resolve, reject) => {
    const request = require('node:http').request({ hostname: '127.0.0.1', port: service.server.address().port, path: '/api/control', method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
      let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    }); request.on('error', reject); request.end(JSON.stringify(body));
  });
  assert.equal((await post({ action: 'LIVE' })).status, 400);
  assert.equal((await post({ action: 'LIVE', confirm: 'LIVE' })).body.error, 'LIVE_CONFIRMATION_REQUIRED');
  assert.equal(app.mode(), 'safe');
  const armed = await post({ action: 'LIVE', confirm: 'LIVE_REAL_MONEY' });
  assert.equal(armed.status, 200); assert.equal(armed.body.mode, 'live'); assert.equal(armed.body.live.balanceSol, .1963); assert.equal(armed.body.paperExit, false);
  await assert.rejects(app.buyPaper({}), /PAPER_CONTROLS_DISABLED/);
  assert.equal((await post({ action: 'STOP' })).body.mode, 'safe'); assert.equal(app.control().running, false); assert.equal(x.sent(), 0);
  const fresh = createApplication(options); assert.equal(fresh.mode(), 'safe'); assert.equal(fresh.control().running, false); await fresh.close();
});
test('dashboard requires typed LIVE and renders chain balance only while live/safe', () => {
  const source = fs.readFileSync(require.resolve('../public/meme-trader/wallet.js'), 'utf8');
  assert.match(source, /dialog\.returnValue === 'arm' && dialog\.querySelector\('input'\)\.value === 'LIVE'/);
  assert.match(source, /confirm: 'LIVE_REAL_MONEY'/);
  const script = fs.readFileSync(require.resolve('../public/meme-trader/app.js'), 'utf8');
  const nodes = new Map(), $ = key => { if (!nodes.has(key)) nodes.set(key, {}); return nodes.get(key); };
  const context = { $, selectedDiscovery: null, snapshot: { version: 1, control: { mode: 'live', live: { balanceSol: .1963 } }, paperWallet: { solBalance: 999 } }, document: { documentElement: { dataset: {} } } };
  for (const name of ['renderWithdrawal', 'renderAgents', 'renderTrades', 'renderOverview', 'renderEvents', 'renderChart', 'renderProtection', 'renderDiscoveries', 'renderDetail']) context[name] = () => {};
  require('node:vm').runInNewContext(script.slice(script.indexOf('  function render() {'), script.indexOf('  const stream =')) + '\nrender();', context);
  assert.equal($('#trading-sol').textContent, '0.1963 SOL');
});
