'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), { createHash } = require('node:crypto');
const { createDexScreener } = require('../core/market-data/providers/dexscreener.cjs');
const { createRuntime } = require('../runtime/events/bus.cjs');
const { createMarketData } = require('../core/market-data/service.cjs');
const { createHunter } = require('../services/jev/hunter.cjs');
const at = '2026-09-24T10:00:00.000Z', now = () => new Date(at);
const pair = changes => ({ chainId: 'solana', pairAddress: 'pair1', baseToken: { address: 'token1' }, priceUsd: '1.25', liquidity: { usd: 100000 }, volume: { h24: 900000 }, pairCreatedAt: 1000, ...changes });
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function setup(t, fetcher, changes = {}) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-contract-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return { dir, provider: createDexScreener({ network: 'SOLANA', chainId: 'solana', now, fetcher, evidenceDirectory: dir, ...changes }) }; }
test('DEX discovery filters exact chain and retains bounded previously discovered subset', async t => {
  let calls = 0; const { provider } = setup(t, async (url, options) => {
    assert.equal(url, 'https://api.dexscreener.com/token-profiles/latest/v1'); assert.equal(options.redirect, 'error'); assert.equal(options.method, 'GET');
    return response(calls++ ? [{ chainId: 'solana', tokenAddress: 'token2' }] : [{ chainId: 'solana', tokenAddress: 'token1' }, { chainId: 'bsc', tokenAddress: 'other' }, { chainId: 'solana', tokenAddress: '../invalid' }]);
  });
  assert.deepEqual(await provider.discover(), ['token1']); assert.deepEqual(await provider.discover(), ['token1', 'token2']);
});
test('DEX chooses exact-base most-liquid valid pair and persists hash-bound raw evidence without price-time claims', async t => {
  const data = [pair(), pair({ pairAddress: 'pair2', priceUsd: '2', liquidity: { usd: 200000 } }), pair({ chainId: 'bsc', liquidity: { usd: 999999 } }), pair({ baseToken: { address: 'other' }, liquidity: { usd: 999999 } })];
  const { provider, dir } = setup(t, async url => { assert.equal(url, 'https://api.dexscreener.com/token-pairs/v1/solana/token1'); return response(data); });
  const sample = await provider.snapshot('token1'); assert.equal(sample.price, 2); assert.equal(sample.observedAt, at); assert.equal(sample.confidence, 0); assert.equal(sample.uncertainty, 1); assert.deepEqual(sample.missing_evidence, ['UPSTREAM_PRICE_TIMESTAMP_UNAVAILABLE']);
  const bodyHash = sample.evidence[0].split('/')[1], receiptHash = sample.evidence[1].split('/')[1];
  const bytes = fs.readFileSync(path.join(dir, bodyHash + '.body.json')); assert.equal(createHash('sha256').update(bytes).digest('hex'), bodyHash); assert.deepEqual(JSON.parse(bytes), data);
  const receiptBytes = fs.readFileSync(path.join(dir, receiptHash + '.receipt.json')); assert.equal(createHash('sha256').update(receiptBytes).digest('hex'), receiptHash); assert.equal(JSON.parse(receiptBytes).bodyHash, bodyHash);
  assert.deepEqual(await provider.snapshot('token1'), sample); assert.equal(fs.readdirSync(dir).length, 2);
});
test('DEX never substitutes missing prices liquidity or volume with zero and never falls back to another chain', async t => {
  for (const invalid of [pair({ priceUsd: null }), pair({ priceUsd: 'Infinity' }), pair({ priceUsd: '0' }), pair({ liquidity: {} }), pair({ volume: {} }), pair({ chainId: 'bsc' }), pair({ baseToken: { address: 'other' } })]) {
    const { provider } = setup(t, async () => response([invalid])); await assert.rejects(provider.snapshot('token1'), /NO_VALID_PAIR/);
  }
});
test('DEX protocol rejects errors redirects invalid JSON media types and oversized bodies', async t => {
  for (const make of [() => new Response('no', { status: 429 }), () => new Response('[]', { status: 302 }), () => new Response('no', { headers: { 'content-type': 'application/json' } }), () => new Response('[]', { headers: { 'content-type': 'text/html' } }), () => new Response('[]', { headers: { 'content-type': 'application/json', 'content-length': '1048577' } }), () => new Response(' '.repeat(1048577), { headers: { 'content-type': 'application/json' } }), () => response({ pairs: [] })]) {
    const { provider } = setup(t, async () => make()); await assert.rejects(provider.discover(), /DEXSCREENER_/);
  }
});
test('DEX external abort ends a noncooperative fetch without manufacturing data', async t => {
  const controller = new AbortController(), { provider } = setup(t, () => new Promise(() => {}));
  const task = provider.discover({ signal: controller.signal }); controller.abort(); await assert.rejects(task, /REQUEST_ENDED/);
});
test('DEX address input cannot alter request host or path and evidence collisions fail closed', async t => {
  let count = 0; const { provider, dir } = setup(t, async () => { count++; return response([pair()]); });
  await assert.rejects(provider.snapshot('../token'), /INVALID_DEXSCREENER_TOKEN/); assert.equal(count, 0);
  const sample = await provider.snapshot('token1'); const file = path.join(dir, sample.evidence[0].split('/')[1] + '.body.json');
  fs.writeFileSync(file, 'tampered fixture'); await assert.rejects(provider.snapshot('token1'), /EVIDENCE_WRITE_FAILED/);
});
test('DEX readiness samples traverse actual market runtime; unverifiable timing stays CHUA_XAC_MINH while real volume still surfaces a candidate', async t => {
  const { provider } = setup(t, async url => response(url.includes('token-profiles') ? [{ chainId: 'solana', tokenAddress: 'token1' }] : [pair()]));
  const runtime = createRuntime({ now }), hunter = createHunter({ runtime, now }); t.after(async () => { hunter.stop(); await runtime.close(); }); hunter.start();
  const market = createMarketData({ runtime, providers: { SOLANA: provider }, now }); const result = await market.scan(); await runtime.flush();
  assert.equal(result.completed, 1); assert.equal(result.failed, 0);
  assert.equal(runtime.snapshot().events.find(e => e.type === 'MarketSnapshot').status, 'CHUA_XAC_MINH');
  // Owner directive: vol24h > $200 emits a research candidate (REAL_VOLUME fast
  // path) even while the upstream price timestamp stays unverified — the $900k
  // pair cannot pass as fully reliable, but it must not disappear either.
  const candidates = runtime.snapshot().events.filter(e => e.type === 'TokenCandidate');
  assert.equal(candidates.length, 1);
  assert.ok(candidates[0].payload.anomalies.includes('REAL_VOLUME'));
});
