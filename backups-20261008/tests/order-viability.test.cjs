'use strict';
// Regression tests for the 2026-10-06 "bot không vào được lệnh" fix set:
// 1. Live orders below the Solana rent+fee floor are vetoed at risk level with
//    the real reason instead of dying later as LIVE_RESERVE_OR_FEE_BUFFER.
// 2. Holdings without fresh marks no longer reserve exposure or drawdown
//    capital in the live portfolio (their cost is only charged once they sell).
// 3. SOL valuation falls through to Bybit/OKX when Coinbase/Binance stall.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createHash } = require('node:crypto');
const nacl = require('tweetnacl'), bs58 = require('bs58');
const { createRuntime } = require('../runtime/events/bus.cjs');
const { createRiskEngine } = require('../core/risk/engine.cjs');
const { createLiveExecution } = require('../core/execution/live.cjs');
const { createValuationReader } = require('../wallet/connection/valuation.cjs');

const at = '2026-10-06T10:00:00.000Z', now = () => new Date(at);

function memeSeed(runtime) {
  const emit = (id, type, producer, payload, changes = {}) => runtime.publish({ id, type, producer, payload, timestamp: at, source: 'viability-test', evidence: ['observation'], status: 'OBSERVED', correlationId: 'decision', network: 'SOLANA', epoch: runtime.status().epoch, confidence: .9, evidence_quality: .9, uncertainty: .1, missing_evidence: [], ...changes });
  emit('snapshot', 'MarketSnapshot', 'MARKET_DATA', { token: 'token', price: 10, liquidityUsd: 100000, volume24hUsd: 20000, observedAt: at, marketCapUsd: 15000, poolAgeMs: 45 * 86400000 });
  emit('candidate', 'TokenCandidate', 'JEV', { token: 'token', symbol: 'T', snapshotId: 'snapshot', liquidityUsd: 100000, volume24hUsd: 20000, rank: 1, anomalies: ['TOKEN_DISCOVERY', 'REAL_VOLUME'] });
  emit('signal', 'SignalObservation', 'JEV', { candidateId: 'candidate', snapshotId: 'snapshot', signals: [{ name: 'momentum', value: .1 }] });
  emit('regime-pending', 'MarketRegimeState', 'MARKET_DATA', { regime: 'UNKNOWN', snapshotIds: ['snapshot'], reason: 'Classification pending.' });
}
function memeDecision(id = 'decision') {
  return { id, type: 'StrategyDecision', producer: 'CODEX_1', payload: { candidateId: 'candidate', snapshotId: 'snapshot', signalIds: ['signal'], strategyVersion: 'meme-flow-v1', quantEvidenceIds: [], criticReportIds: [], regimeId: 'regime-pending', action: 'BUY', disposition: 'TRADE', reason: 'Fresh meme entry.' }, timestamp: at, source: 'viability-test', evidence: ['observation'], status: 'OBSERVED', correlationId: id, network: 'SOLANA', epoch: 1, confidence: .9, evidence_quality: .9, uncertainty: .1, missing_evidence: [] };
}
function riskSetup(t, equity, mode) {
  const bus = createRuntime({ now });
  const runtime = Object.assign(bus, mode ? { executionMode: () => mode } : {});
  const tradeStore = { maxEntryUsd: () => 2, snapshot: () => ({ performance: { equity, cash: equity, capitalUsed: 0, maxDrawdown: 0 }, positions: [], trades: [] }) };
  memeSeed(runtime);
  const risk = createRiskEngine({ runtime, tradeStore, now });
  risk.start();
  t.after(async () => { risk.stop(); await runtime.close(); });
  return runtime;
}

test('live entry budget below the rent+fee floor is vetoed with the real reason', async t => {
  const runtime = riskSetup(t, 2, 'live');
  runtime.publish(memeDecision());
  await runtime.flush();
  const verdict = runtime.snapshot().events.filter(e => e.type === 'RiskDecision').at(-1);
  assert.equal(verdict.payload.approved, false);
  assert.match(verdict.payload.reason, /below the minimum executable order \$0\.50/);
});

test('the same dust budget still trades in paper mode (no rent on paper fills)', async t => {
  const runtime = riskSetup(t, 2, null);
  runtime.publish(memeDecision());
  await runtime.flush();
  const verdict = runtime.snapshot().events.filter(e => e.type === 'RiskDecision').at(-1);
  assert.equal(verdict.payload.approved, true);
  assert.ok(Math.abs(verdict.payload.maxExposureUsd - 0.17) < 1e-9);
});

test('live viable budget is approved at full size', async t => {
  const runtime = riskSetup(t, 12, 'live');
  runtime.publish(memeDecision());
  await runtime.flush();
  const verdict = runtime.snapshot().events.filter(e => e.type === 'RiskDecision').at(-1);
  assert.equal(verdict.payload.approved, true);
  assert.ok(Math.abs(verdict.payload.maxExposureUsd - 1.02) < 1e-9);
});

test('unpriced holdings do not reserve exposure or drawdown capital in the live portfolio', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botmeme-viability-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pair = nacl.sign.keyPair(), owner = bs58.encode(pair.publicKey);
  const tokenA = bs58.encode(nacl.sign.keyPair().publicKey), tokenB = bs58.encode(nacl.sign.keyPair().publicKey);
  const envelope = (id, type, producer, payload) => ({ id, type, producer, payload, timestamp: at, source: 'viability.test', evidence: ['evidence/' + id], status: 'COMPLETED', correlationId: 'case', network: 'SOLANA', epoch: 1, confidence: 1, evidence_quality: 1, uncertainty: 0, missing_evidence: [] });
  const buy = (id, token, quantity, entryPrice, fees) => envelope(id, 'TradeResult', 'LIVE_EXECUTION', { mode: 'live', intentId: 'intent-' + id, token, candidateId: 'cand-' + id, snapshotId: 'snap-' + id, signalIds: ['signal'], strategyVersion: 'meme-flow-v1', decisionId: 'decision-' + id, riskDecisionId: 'risk-' + id, side: 'BUY', quantity, entryPrice, exitPrice: null, realizedPnl: 0, fees, slippageBps: 100, state: 'OPEN' });
  const fillA = buy('fillA', tokenA, 2, 0.5, 0.01), fillB = buy('fillB', tokenB, 1, 2, 0);
  fs.writeFileSync(path.join(root, 'live-state.json'), JSON.stringify({ version: 1, owner, pending: null, fills: [fillA, fillB], claimed: ['intent-fillA', 'intent-fillB'], initialUsd: 100 }));
  const runtime = createRuntime({ now });
  t.after(async () => { await runtime.close(); });
  runtime.publish({ ...envelope('mark', 'MarketSnapshot', 'MARKET_DATA', { token: tokenA, price: 0.5, liquidityUsd: 1000, volume24hUsd: 1000, observedAt: at }), status: 'OBSERVED' });
  const accountHash = createHash('sha256').update('SOLANA:' + owner).digest('hex');
  runtime.publish({ ...envelope('valuation', 'WalletValuation', 'RUNTIME', { amount: '1.000000000', symbol: 'SOL', balanceAt: at, priceAt: at, priceUsd: 100, valueUsd: 100, accountHash }), status: 'OBSERVED' });
  const fetcher = async (url, init) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: JSON.parse(init.body).method === 'getBalance' ? { value: 1000000000 } : null }), { status: 200 });
  const live = createLiveExecution({ runtime, tradeStore: { snapshot: () => ({ performance: {}, positions: [], trades: [] }) }, now, config: { root, owner, fetcher, env: {} } });
  await live.refreshBalance();
  const performance = live.portfolio().performance;
  // tokenA is marked at 0.5 (cost 1.01, value 1.0); tokenB has no mark (cost 2).
  assert.ok(Math.abs(performance.cash - 100) < 1e-9);
  assert.ok(Math.abs(performance.capitalUsed - 1.01) < 1e-9, 'capitalUsed must count only marked positions, got ' + performance.capitalUsed);
  assert.ok(Math.abs(performance.equity - 101) < 1e-9);
  assert.ok(Math.abs(performance.maxDrawdown - 0.0001) < 1e-9, 'drawdown must exclude unpriced cost, got ' + performance.maxDrawdown);
});

test('SOL valuation falls through stalled venues to Bybit and OKX', async t => {
  const balances = { read: async () => ({ status: 'OBSERVED', symbol: 'SOL', amount: '2.000000000', observedAt: at }) };
  const json = body => new Response(JSON.stringify(body), { status: 200 });
  const reader = createValuationReader({
    balances, now,
    fetcher: async url => {
      if (String(url).includes('coinbase') || String(url).includes('binance')) return new Response('stalled', { status: 503 });
      if (String(url).includes('bybit')) return json({ result: { list: [{ lastPrice: '123.45' }] } });
      if (String(url).includes('okx')) return json({ data: [{ last: '123.46', ts: String(Date.parse(at)) }] });
      return new Response('unused', { status: 500 });
    }
  });
  const bybit = await reader.read({ network: 'SOLANA', address: 'addr', chainId: 'mainnet-beta', provider: 'local' });
  assert.equal(bybit.quote.price, '123.45');
  assert.match(bybit.source, /bybit/);
  const okx = createValuationReader({
    balances, now,
    fetcher: async url => {
      if (String(url).includes('okx')) return json({ data: [{ last: '123.46', ts: String(Date.parse(at)) }] });
      return new Response('stalled', { status: 503 });
    }
  });
  const fallback = await okx.read({ network: 'SOLANA', address: 'addr', chainId: 'mainnet-beta', provider: 'local' });
  assert.equal(fallback.quote.price, '123.46');
  assert.match(fallback.source, /okx/);
});
