'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { createHash } = require('node:crypto');
const { createDexScreener } = require('../core/market-data/providers/dexscreener.cjs');
const { createGeckoTerminal } = require('../core/market-data/providers/geckoterminal.cjs');
const { createRuntime } = require('../runtime/events/bus.cjs');
const { createMarketData } = require('../core/market-data/service.cjs');
const { createHunter } = require('../services/jev/hunter.cjs');
const { createTradeStore } = require('../core/trades/store.cjs');
const { createDashboardAdapter } = require('../dashboard/adapter/index.cjs');
const at = Date.parse('2026-09-24T10:00:00Z');
const pair = token => ({ chainId: 'solana', dexId: 'raydium', baseToken: { address: token }, priceUsd: '2', liquidity: { usd: 20000 }, volume: { h24: 1000, m5: 1000 }, txns: { m5: { buys: 3, sells: 2 } }, pairCreatedAt: at - 60000, marketCap: 15000 });
const response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
function setup(t, count = 2) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-fallback-')); let clock = at;
  const now = () => new Date(clock), calls = [], tokens = Array.from({ length: count }, (_, i) => 'token' + i);
  const runtime = createRuntime({ now });
  t.after(async () => { await runtime.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const dex = createDexScreener({ network: 'SOLANA', chainId: 'solana', now, evidenceDirectory: dir, fetcher: async url => {
    calls.push(url); return response({ pairs: url.split('/').at(-1).split(',').map(token => data(token)) });
  } });
  let data = pair;
  const provider = { network: 'SOLANA', watched: () => tokens, discover: async () => tokens, snapshot: async () => { throw Error('unexpected deep quote'); }, quotes: async () => { throw Error('GECKOTERMINAL_HTTP_FAILED_429'); }, fallbackQuotes: dex.batchQuotes };
  const market = createMarketData({ runtime, providers: { SOLANA: provider }, now });
  return { dir, now, runtime, provider, market, calls, tokens, dex, advance: (ms = 1000) => { clock += ms; }, data: fn => { data = fn; }, events: () => runtime.snapshot().events.filter(e => e.type === 'MarketSnapshot') };
}
test('DexScreener watch admission shares the 10k to 20k cap band after metadata lookup', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-band-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const caps = [9999, 10000, 20000, 20001, 25000, 30000, 30001, 10000000, 10000001, 50000000, 1000000000], tokens = caps.map(cap => 'cap' + cap);
  const dex = createDexScreener({ network: 'SOLANA', chainId: 'solana', now: () => new Date(at), evidenceDirectory: dir,
    fetcher: async url => response(url.includes('token-profiles') ? tokens.map(tokenAddress => ({ chainId: 'solana', tokenAddress })) : { pairs: tokens.map((token, i) => ({ ...pair(token), marketCap: caps[i] })) }) });
  assert.deepEqual(await dex.discover(), tokens, 'unknown caps remain available for metadata lookup');
  assert.equal((await dex.batchQuotes(tokens)).length, tokens.length, 'price observations remain available outside the entry band');
  assert.deepEqual(await dex.discover(), ['cap10000', 'cap20000']);
  for (const cap of caps) assert.equal(dex.profile('cap' + cap).band, cap >= 10000 && cap <= 20000);
});

test('429 batch fallback publishes receipt-timed MarketSnapshots and immutable hash evidence', async t => {
  const f = setup(t); const result = await f.market.scan(); await f.runtime.flush();
  assert.equal(result.completed, 2); assert.equal(f.calls.length, 1);
  for (const e of f.events()) {
    assert.match(e.source, /dexscreener-fallback/); assert.equal(e.payload.observedAt, f.now().toISOString());
    assert.equal(e.payload.price, 2); assert.equal(e.payload.poolAgeMs, 60000); assert.equal(e.payload.marketCapUsd, 15000);
    assert.equal(e.payload.recentVolumeUsd, 1000); assert.equal(e.payload.recentTxs5m, 5);
    assert.equal(e.confidence, .8); assert.equal(e.evidence_quality, .8); assert.equal(e.uncertainty, .2);
    for (const id of e.evidence) {
      const [kind, hash] = id.split('/'); const bytes = fs.readFileSync(path.join(f.dir, hash + (kind.endsWith('body') ? '.body.json' : '.receipt.json')));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
    }
  }
});
test('fallback keeps missing creation time and quotes the token once per sweep', async t => {
  const f = setup(t, 1);
  f.data(token => { const value = pair(token); delete value.pairCreatedAt; return value; });
  const result = await f.market.scan();
  assert.equal(result.status, 'COMPLETED'); assert.equal(f.calls.length, 1);
  assert.equal(f.events().length, 1);
  assert.equal(Object.hasOwn(f.events()[0].payload, 'poolAgeMs'), false);
});

test('Gecko admits, retains and screens pools with unknown creation time', async t => {
  const f = setup(t, 1), calls = [];
  const pool = { id: 'solana_pool0', type: 'pool', attributes: { address: 'pool0', base_token_price_usd: '2', reserve_in_usd: '20000', volume_usd: { h24: '1000' }, market_cap_usd: '15000' }, relationships: { base_token: { data: { id: 'solana_token0', type: 'token' } } } };
  const gecko = createGeckoTerminal({ network: 'SOLANA', networkId: 'solana', now: f.now, evidenceDirectory: f.dir,
    fetcher: async url => { calls.push(url); return response({ data: url.includes('new_pools') || url.includes('/multi/') ? [pool] : [] }); } });
  const market = createMarketData({ runtime: f.runtime, now: f.now, providers: { SOLANA: gecko } });
  assert.equal((await market.scan()).status, 'COMPLETED');
  assert.deepEqual(gecko.watched(), ['token0']);
  assert.equal(gecko.profile('token0').born, null);
  assert.equal(f.events().length, 1); assert.equal(Object.hasOwn(f.events()[0].payload, 'poolAgeMs'), false);
  assert.equal(calls.filter(url => url.includes('/multi/')).length, 1);
  assert.equal(calls.filter(url => url.includes('/trades')).length, 0);
  assert.deepEqual(gecko.adopt([{ token: 'adopted', poolAddress: 'pool1' }]), ['adopted']);
  assert.equal(gecko.profile('adopted').born, null); assert.ok(gecko.watched().includes('adopted'));
});

test('healthy Gecko quotes do not invoke DexScreener', async t => {
  const f = setup(t);
  f.provider.quotes = async tokens => tokens.map(token => ({ token, price: 1, liquidityUsd: 20000, volume24hUsd: 1000, observedAt: f.now().toISOString(), source: 'gecko#pool-price', evidence: ['fixture'], confidence: .8, evidence_quality: .8, missing_evidence: [], uncertainty: .2 }));
  assert.equal((await f.market.scan()).completed, 2); assert.equal(f.calls.length, 0);
});

test('DexScreener drops aged pairs on metadata lookup and never re-quotes known expired identifiers', async t => {
  const f = setup(t, 2);
  f.data(token => ({ ...pair(token), liquidity: { usd: 0 }, pairCreatedAt: at - (token === 'token0' ? 29 : 31) * 60000 }));
  assert.deepEqual((await f.dex.batchQuotes(f.tokens)).map(s => s.token), ['token0']);
  const start = f.calls.length;
  assert.deepEqual((await f.dex.batchQuotes(f.tokens)).map(s => s.token), ['token0']);
  assert.ok(f.calls.slice(start).every(url => !url.includes('token1')));
  f.advance(2 * 60000);
  const end = f.calls.length;
  assert.deepEqual(await f.dex.batchQuotes(f.tokens), []); assert.equal(f.calls.length, end);
});

test('fallback identity is sanitized on samples and persisted in MarketSnapshot payloads', async t => {
  const f = setup(t, 1), imageUrl = 'https://cdn.dexscreener.com/cms/images/token.webp';
  f.data(token => ({ ...pair(token), baseToken: { address: token, symbol: '  MEME\u0000  ', name: 'N'.repeat(90) }, info: { imageUrl } }));
  const identity = { tokenSymbol: 'MEME', tokenName: 'N'.repeat(80), imageUrl };
  const sample = (await f.dex.batchQuotes(f.tokens))[0];
  await f.market.scan();
  for (const value of [sample, f.events()[0].payload]) for (const [key, expected] of Object.entries(identity)) assert.equal(value[key], expected);
  f.data(token => ({ ...pair(token), baseToken: { address: token, symbol: 'S'.repeat(40) } }));
  assert.equal((await f.dex.batchQuotes(f.tokens))[0].tokenSymbol.length, 32);
});

test('absent and invalid identity is omitted without fabrication and contracts reject unsanitized fields', async t => {
  const f = setup(t, 1), keys = ['tokenSymbol', 'tokenName', 'imageUrl'];
  for (const metadata of [{}, { symbol: 42, name: {}, imageUrl: 'http://example.com/a' }, { symbol: ['MEME'], name: false, imageUrl: 'https://' }, { symbol: ' ', name: '\u0000', imageUrl: 'https://example.com/' + 'a'.repeat(400) }, { imageUrl: { url: 'https://example.com/a' } }, { imageUrl: 'javascript:alert(1)' }]) {
    f.data(token => ({ ...pair(token), baseToken: { address: token, symbol: metadata.symbol, name: metadata.name }, info: { imageUrl: metadata.imageUrl } }));
    const sample = (await f.dex.batchQuotes(f.tokens))[0];
    f.advance(); await f.market.scan();
    for (const value of [sample, f.events().at(-1).payload]) for (const key of keys) assert.equal(Object.hasOwn(value, key), false);
  }
  const { validateEvent } = require('../runtime/contracts/index.cjs'), event = f.events().at(-1);
  for (const [key, value] of [['tokenSymbol', {}], ['tokenSymbol', 'x'.repeat(33)], ['tokenName', 'x'.repeat(81)], ['imageUrl', 'http://example.com/a']]) assert.throws(() => validateEvent({ ...event, payload: { ...event.payload, [key]: value } }, { now: f.now }), /TOKEN_IDENTITY/);
});

test('newest fallback identity resolves positions, history and paper wallet; Gecko identity wins', async t => {
  const f = setup(t, 1), token = f.tokens[0], image = 'https://dd.dexscreener.com/ds-data/tokens/solana/token.png';
  f.data(token => ({ ...pair(token), baseToken: { address: token, symbol: 'OLD' }, info: { imageUrl: image } }));
  await f.market.scan(); const first = f.events()[0];
  f.advance();
  f.data(token => ({ ...pair(token), baseToken: { address: token, symbol: 'NEW' }, info: { imageUrl: image + '?v=2' } }));
  await f.market.scan();
  // A delayed older observation must not replace the newest identity.
  f.runtime.publish({ ...first, id: 'delayed-identity' });
  const trade = { id: 'paper-buy', cycleId: 'cycle', mode: 'paper', network: 'SOLANA', token, timestamp: first.timestamp, snapshotId: first.id, side: 'BUY', state: 'OPEN', positionState: 'OPEN', quantity: 2, entryPrice: 2, exitPrice: null, realizedPnl: 0, realizedReturn: null };
  const ledger = { snapshot: () => ({ positions: [{ network: 'SOLANA', token, quantity: 1, averageCost: 2, costBasis: 2, markPrice: 2 }], trades: [trade, { ...trade, id: 'paper-sell', side: 'SELL', quantity: 1, allocatedCostBasis: 2, exitPrice: 2 }], performance: { capitalUsed: 2, realizedPnl: 0, unrealizedPnl: 0 } }) };
  const adapter = createDashboardAdapter({ runtime: f.runtime, tradeStore: ledger, now: f.now, evidenceRoot: f.dir });
  t.after(() => adapter.close());
  const check = (symbol, expectedImage) => {
    const state = adapter.snapshot();
    assert.equal(state.trades.length, 2); assert.equal(state.paperWallet.holdings.length, 1);
    for (const row of [...state.trades, ...state.paperWallet.holdings, state.markets[state.activeToken]]) { assert.equal(row.symbol, symbol); assert.equal(row.image, expectedImage); }
  };
  check('NEW', image + '?v=2');
  const body = JSON.stringify({ data: [{ type: 'pool', attributes: { name: 'GECKO / SOL' }, relationships: { base_token: { data: { id: 'solana_' + token } } } }], included: [{ type: 'token', id: 'solana_' + token, attributes: { image_url: 'https://assets.geckoterminal.com/token.png' } }] });
  const digest = createHash('sha256').update(body).digest('hex');
  fs.mkdirSync(path.join(f.dir, 'SOLANA')); fs.writeFileSync(path.join(f.dir, 'SOLANA', digest + '.body.json'), body);
  f.runtime.publish({ ...first, id: 'gecko-identity', evidence: ['geckoterminal.body/' + digest] });
  check('GECKO', 'https://assets.geckoterminal.com/token.png');
});

test('asset-image serves DexScreener CDN avatars while rejecting other hosts and redirects', async t => {
  const { createApplication } = require('../runtime/application.cjs');
  const { createDashboardServer } = require('../scripts/serve-meme-trader.cjs');
  const service = createDashboardServer({ application: createApplication({ providers: {} }) });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(() => service.close());
  const origin = 'http://127.0.0.1:' + service.server.address().port, fetcher = globalThis.fetch, requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).startsWith(origin)) return fetcher(url, options);
    requests.push({ url, options });
    return new Response(Buffer.from('fixture-image'), { headers: { 'content-type': 'image/png' } });
  });
  for (const host of ['assets.geckoterminal.com', 'cdn.dexscreener.com', 'dd.dexscreener.com', 'ipfs.io', 'cf.mirror.world']) {
    const url = 'https://' + host + '/tokens/token.png?v=2', response = await fetcher(origin + '/api/asset-image?u=' + encodeURIComponent(url));
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(await response.text(), 'fixture-image'); assert.equal(requests.at(-1).url, url); assert.equal(requests.at(-1).options.redirect, 'error');
  }
  for (const url of ['http://cdn.dexscreener.com/a', 'https://127.0.0.1/a', 'https://cdn.dexscreener.com.evil.example/a', 'https://cdn.dexscreener.com@evil.example/a']) assert.equal((await fetcher(origin + '/api/asset-image?u=' + encodeURIComponent(url))).status, 400);
  assert.equal(requests.length, 5);
});

test('non-chain Gecko re-quotes 130 known fresh candidates absent from discovery in four-batch rotations', async t => {
  const f = discoverySetup(t, 130);
  assert.equal(f.provider.usesChain, false);
  // Seed candidate evidence before the two regression sweeps.
  f.provider.discover = async () => [...f.tokens];
  f.provider.quotes = tokens => f.dex.batchQuotes(tokens);
  await f.market.scan(); await f.runtime.flush();
  assert.equal(f.runtime.snapshot().events.filter(e => e.type === 'TokenCandidate').length, 130);
  f.provider.discover = async () => [];
  const quoteRequests = [];
  f.provider.quotes = async tokens => { quoteRequests.push(tokens); throw Error('GECKOTERMINAL_HTTP_FAILED_429'); };
  const batches = [];
  f.provider.fallbackQuotes = tokens => { batches.push([...tokens]); return f.dex.batchQuotes(tokens); };
  const rounds = [];
  for (let sweep = 0; sweep < 2; sweep++) {
    f.advance(60000);
    const result = await f.market.scan(); await f.runtime.flush();
    assert.equal(result.total, 130); assert.equal(result.completed, 120);
    assert.equal(result.status, 'PARTIAL_FAILURE');
    const samples = f.events().filter(e => e.correlationId.startsWith(result.runId + ':price-'));
    assert.equal(samples.length, 120);
    assert.ok(samples.every(e => e.source.includes('#dexscreener-fallback') && e.evidence.length));
    rounds.push(samples.map(e => e.payload.token));
    const progress = f.runtime.snapshot().events.filter(e => e.type === 'ScanProgress' && e.payload.runId === result.runId).at(-1);
    assert.equal(progress.payload.completed, 120);
  }
  assert.ok(quoteRequests.length > 0);
  assert.deepEqual(batches.map(tokens => tokens.length), [30, 30, 30, 30, 30, 30, 30, 30]);
  const remaining = f.tokens.filter(token => !rounds[0].includes(token));
  assert.equal(remaining.length, 10);
  assert.deepEqual(new Set(rounds[1].slice(0, 10)), new Set(remaining));
  assert.equal(new Set(rounds.flat()).size, 130);
  assert.deepEqual(f.runtime.snapshot().deliveryErrors, []);
});

test('non-chain screening excludes aged open positions and old-band tokens', async t => {
  const f = setup(t, 3);
  f.provider.usesChain = false;
  await f.market.scan();
  f.advance(31 * 60000);
  // The service consumes retained OPEN events; no execution is part of this fixture.
  const snapshot = f.runtime.snapshot.bind(f.runtime);
  f.runtime.snapshot = () => {
    const state = snapshot();
    return { ...state, events: [...state.events, { type: 'TradeResult', network: state.network, epoch: state.epoch, payload: { token: 'token2', state: 'OPEN' } }] };
  };
  f.tokens.push('fresh');
  f.data(token => ({ ...pair(token), pairCreatedAt: token === 'fresh' ? +f.now() - 60000 : at - 60000 }));
  f.provider.discover = async () => ['fresh'];
  f.provider.profile = token => token === 'token1' ? { liquidityUsd: 20000, band: true } : null;
  const start = f.calls.length;
  assert.equal((await f.market.scan()).completed, 1);
  assert.deepEqual(f.calls.slice(start).flatMap(url => url.split('/').at(-1).split(',')), ['fresh']);
});

test('successful non-chain screening counts quotes instead of the discovery sweep count', async t => {
  const f = setup(t, 2);
  f.provider.swept = 20;
  f.provider.quotes = tokens => f.dex.batchQuotes(tokens);
  const result = await f.market.scan();
  assert.equal(result.total, 2); assert.equal(result.completed, 2);
  assert.equal(f.events().length, 2);
  const progress = f.runtime.snapshot().events.filter(e => e.type === 'ScanProgress').at(-1);
  assert.equal(progress.payload.completed, 2);
});
test('omitted cap carries latest prior snapshot with provenance; absent prior cap stays absent', async t => {
  const f = setup(t); await f.market.scan(); f.advance();
  f.tokens.push('newtoken'); f.data(token => { const p = pair(token); delete p.marketCap; return p; });
  await f.market.scan();
  const recent = f.events().filter(e => e.payload.observedAt === f.now().toISOString());
  assert.equal(recent.length, 3);
  for (const e of recent) {
    if (e.payload.token === 'newtoken') { assert.equal(Object.hasOwn(e.payload, 'marketCapUsd'), false); assert.doesNotMatch(e.source, /prior-marketCap/); }
    else { assert.equal(e.payload.marketCapUsd, 15000); assert.match(e.source, /prior-marketCapUsd/); assert.ok(e.evidence.length >= 3); }
  }
});
test('batch endpoint chunks 31 tokens into 30 and 1 and shares each response evidence', async t => {
  const f = setup(t, 31), samples = await f.dex.batchQuotes(f.tokens);
  assert.deepEqual(f.calls.map(url => url.split('/').at(-1).split(',').length), [30, 1]);
  assert.equal(samples.length, 31); assert.deepEqual(samples[0].evidence, samples[29].evidence);
});
test('scan budget is four batch calls and cooldown sweeps rotate pending tokens', async t => {
  const f = setup(t, 175); f.provider.discover = async () => { throw Error('GECKOTERMINAL_RATE_LIMIT_COOLDOWN'); };
  assert.equal((await f.market.scan()).completed, 120); assert.equal(f.calls.length, 4);
  f.advance(); await f.market.scan(); assert.equal(f.calls.length, 8);
  f.advance(); await f.market.scan(); assert.equal(f.calls.length, 12);
  assert.equal(new Set(f.events().map(e => e.payload.token)).size, 175);
});

test('800 dead pools cannot bury 40 alive pools or prevent five-sample accumulation', async t => {
  const f = setup(t, 0);
  const dead = Array.from({ length: 800 }, (_, i) => 'dead' + i);
  const live = Array.from({ length: 40 }, (_, i) => 'live' + i);
  f.tokens.push(...dead, ...live);
  // The watchlist was first discovered long ago; discovery must not refresh it.
  const snapshot = f.runtime.snapshot.bind(f.runtime);
  f.runtime.snapshot = () => {
    const state = snapshot();
    return { ...state, events: [...state.events, ...f.tokens.map(token => ({ type: 'TokenCandidate', network: state.network, epoch: state.epoch, timestamp: new Date(at - (token.startsWith('dead') ? 60 : 29) * 60000).toISOString(), payload: { token, anomalies: [] } }))] };
  };
  f.data(token => token.startsWith('live') ? pair(token) : { ...pair(token), priceUsd: '0' });
  const cooled = new Set();
  for (let sweep = 0; sweep < 5; sweep++) {
    const start = f.calls.length;
    const result = await f.market.scan();
    const batches = f.calls.slice(start).map(url => url.split('/').at(-1).split(','));
    assert.equal(batches.length, 4);
    assert.ok(batches.every(batch => batch.length === 30));
    const attempted = batches.flat();
    assert.ok(attempted.every(token => !cooled.has(token)), 'empty results must never consume a later sweep slot during cooldown');
    assert.deepEqual(new Set(attempted.slice(0, 40)), new Set(live));
    const samples = f.events().filter(e => e.correlationId.startsWith(result.runId + ':price-'));
    assert.deepEqual(new Set(samples.map(e => e.payload.token)), new Set(live));
    assert.equal(result.completed, 40);
    for (const token of attempted.filter(token => token.startsWith('dead'))) cooled.add(token);
    // Age out the fresh tier immediately after the first sweep. Live-known
    // priority must then keep winning against the unattempted dead backlog.
    f.advance(60000);
  }
  assert.equal(cooled.size, 400);
  assert.ok(live.every(token => f.events().filter(e => e.payload.token === token).length === 5));
  assert.ok(f.events().every(e => Date.parse(e.payload.observedAt) - at < 30 * 60000));
  assert.deepEqual(f.runtime.snapshot().deliveryErrors, []);
});

for (const empty of [false, true]) test('dead quote cooldown lasts exactly six hours after ' + (empty ? 'an empty batch' : 'a partially matched batch'), async t => {
  const f = setup(t, 2);
  const dex = createDexScreener({ network: 'SOLANA', chainId: 'solana', now: f.now, evidenceDirectory: f.dir, fetcher: async url => {
    f.calls.push(url);
    // token1 has no matching pair even though the batch has other pairs.
    return response({ pairs: empty ? [] : [pair('token0'), pair('unrelated')] });
  } });
  f.provider.fallbackQuotes = dex.batchQuotes;
  await f.market.scan();
  assert.equal(f.calls.length, 1);
  const attemptedSince = start => f.calls.slice(start).flatMap(url => url.split('/').at(-1).split(','));
  f.advance(6 * 3600000 - 1);
  let start = f.calls.length;
  await f.market.scan();
  assert.equal(attemptedSince(start).includes('token1'), false);
  if (empty) assert.equal(f.calls.length, start);
  f.advance(1);
  start = f.calls.length;
  await f.market.scan();
  assert.ok(attemptedSince(start).includes('token1'));
  assert.equal(f.events().some(e => e.payload.token === 'token1'), false);
});

test('expired open positions and 120 aged known tokens use no fallback budget', async t => {
  const f = setup(t, 121);
  f.provider.quotes = tokens => f.dex.batchQuotes(tokens);
  await f.market.scan();
  assert.equal(f.events().length, 121);
  f.advance(31 * 60000);
  const position = f.tokens.at(-1), snapshot = f.runtime.snapshot.bind(f.runtime);
  f.runtime.snapshot = () => {
    const state = snapshot();
    return { ...state, events: [...state.events, { type: 'TradeResult', network: state.network, epoch: state.epoch, payload: { token: position, state: 'OPEN' } }] };
  };
  f.provider.quotes = async () => { throw Error('GECKOTERMINAL_HTTP_FAILED_429'); };
  const start = f.calls.length;
  assert.equal((await f.market.scan()).completed, 0);
  const batches = f.calls.slice(start).map(url => url.split('/').at(-1).split(','));
  assert.equal(batches.length, 0);
  assert.equal(f.events().filter(e => e.payload.token === position).length, 1);
});
test('generic quote failure and chain remember failure both reach fallback publication', async t => {
  const f = setup(t); f.provider.usesChain = true; f.provider.chainSnapshots = async () => { throw Error('RPC_DOWN'); };
  f.provider.quotes = async () => { throw Error('GECKOTERMINAL_HTTP_FAILED_503'); };
  assert.equal((await f.market.scan()).completed, 2); assert.equal(f.events().length, 2); assert.equal(f.calls.length, 1);
});
test('batch picks highest-liquidity exact Solana base, keeps absent metadata absent, and bounds source length', async t => {
  const f = setup(t), token = 'A'.repeat(44);
  const provider = createDexScreener({ network: 'SOLANA', chainId: 'solana', now: f.now, evidenceDirectory: f.dir, fetcher: async () => response({ pairs: [
    pair(token), { ...pair(token), priceUsd: '3', liquidity: { usd: 30000 }, marketCap: undefined, pairCreatedAt: undefined },
    { ...pair(token), chainId: 'bsc', priceUsd: '999', liquidity: { usd: 999999 } },
    { ...pair('other'), priceUsd: '999', liquidity: { usd: 999999 } }
  ] }) });
  const samples = await provider.batchQuotes([token]);
  assert.equal(samples.length, 1); assert.equal(samples[0].price, 3);
  assert.equal(Object.hasOwn(samples[0], 'marketCapUsd'), false); assert.equal(Object.hasOwn(samples[0], 'poolAgeMs'), false);
  assert.ok(samples[0].source.length <= 500);
});
test('fallback outage remains partial without fake samples or per-token retries', async t => {
  const f = setup(t, 40); let calls = 0;
  f.provider.fallbackQuotes = async () => { calls++; throw Error('DEXSCREENER_HTTP_FAILED'); };
  const result = await f.market.scan();
  assert.equal(result.status, 'PARTIAL_FAILURE'); assert.equal(result.completed, 0); assert.equal(f.events().length, 0); assert.equal(calls, 2);
});
test('fallback batch timeout preserves 30 completed samples and retries pending tokens next sweep', async t => {
  const f = setup(t, 60), batches = []; let started, signal;
  const ready = new Promise(resolve => { started = resolve; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.provider.fallbackQuotes = async (tokens, context) => {
    batches.push([...tokens]);
    if (batches.length === 2) { signal = context.signal; started(); return new Promise(() => {}); }
    return f.dex.batchQuotes(tokens);
  };
  const task = f.market.scan(); await ready;
  t.mock.timers.tick(15000); assert.equal(signal.aborted, false);
  t.mock.timers.tick(14999); assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  const result = await task;
  assert.equal(signal.aborted, true);
  assert.equal(result.status, 'PARTIAL_FAILURE'); assert.equal(result.completed, 30);
  assert.equal(result.failed, 0); assert.equal(batches.length, 2);
  assert.equal(f.events().length, 30);
  const progress = f.runtime.snapshot().events.findLast(e => e.type === 'ScanProgress').payload;
  assert.equal(progress.state, 'PARTIAL_FAILURE'); assert.equal(progress.completed, 30);
  f.advance(); await f.market.scan();
  assert.deepEqual(batches[2], batches[1]);
  assert.equal(new Set(f.events().map(e => e.payload.token)).size, 60);
});

for (const failure of ['PROVIDER_REQUEST_ENDED', 'UPSTREAM_ERROR']) test('screening skips only a quotes batch after ' + failure, async t => {
  const f = setup(t, 90); let calls = 0;
  delete f.provider.fallbackQuotes;
  f.provider.quotes = tokens => {
    if (++calls === 2) throw Error(failure);
    return f.dex.batchQuotes(tokens);
  };
  const result = await f.market.scan();
  assert.equal(result.status, 'PARTIAL_FAILURE'); assert.equal(result.completed, 60);
  assert.equal(calls, 3); assert.equal(f.events().length, 60);
});

test('chain fallback retains earlier batches when a later batch errors', async t => {
  const f = setup(t, 60); let calls = 0;
  f.provider.usesChain = true;
  f.provider.chainSnapshots = async () => [];
  f.provider.fallbackQuotes = tokens => {
    if (++calls === 2) throw Error('PROVIDER_REQUEST_ENDED');
    return f.dex.batchQuotes(tokens);
  };
  const result = await f.market.scan();
  assert.equal(result.status, 'PARTIAL_FAILURE'); assert.equal(result.completed, 30);
  assert.equal(calls, 2); assert.equal(f.events().length, 30);
});

for (const change of ['network', 'epoch']) test(change + ' change during fallback ends the scan session', async t => {
  const f = setup(t);
  f.provider.fallbackQuotes = async () => {
    f.runtime.selectNetwork('BSC');
    if (change === 'epoch') f.runtime.selectNetwork('SOLANA');
    throw Error('PROVIDER_REQUEST_ENDED');
  };
  await assert.rejects(f.market.scan(), /SCAN_SESSION_ENDED/);
  assert.equal(f.events().length, 0);
});

test('stopping a scan aborts fallback and publishes no late samples', async t => {
  const f = setup(t); let started;
  const ready = new Promise(resolve => { started = resolve; });
  f.provider.fallbackQuotes = async (_, { signal }) => { started(); return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('DEXSCREENER_REQUEST_ENDED')), { once: true })); };
  const task = f.market.scan(); await ready; f.market.stop();
  await assert.rejects(task, /SCAN_SESSION_ENDED/); assert.equal(f.events().length, 0);
});
test('actual Gecko adapter exposes Solana fallback and survives discovery 429 with watched tokens', async t => {
  const f = setup(t); let dexCalls = 0;
  const gecko = createGeckoTerminal({ network: 'SOLANA', networkId: 'solana', now: f.now, evidenceDirectory: f.dir, fetcher: async url => {
    if (url.startsWith('https://api.dexscreener.com/')) { dexCalls++; return response(url.includes('token-profiles') ? [] : { pairs: f.tokens.map(pair) }); }
    return new Response('{}', { status: 429, headers: { 'retry-after': '60' } });
  } });
  gecko.adopt(f.tokens.map(token => ({ token, poolAddress: token + 'pool', born: at - 60000 })));
  const market = createMarketData({ runtime: f.runtime, providers: { SOLANA: gecko }, now: f.now });
  assert.equal((await market.scan()).completed, 2); assert.equal(dexCalls, 2); assert.equal(f.events().length, 2);
});

function discoverySetup(t, count = 2, quoteCount = Infinity) {
  const f = setup(t, count), calls = [];
  const gecko = createGeckoTerminal({ network: 'SOLANA', networkId: 'solana', now: f.now, evidenceDirectory: f.dir, fetcher: async url => {
    calls.push(url);
    if (url.includes('token-profiles')) return response(f.tokens.map(tokenAddress => ({ chainId: 'solana', tokenAddress })));
    if (url.includes('/latest/dex/tokens/')) return response({ pairs: url.split('/').at(-1).split(',').filter(token => f.tokens.indexOf(token) < quoteCount).map(pair) });
    return new Response('{}', { status: 429, headers: { 'retry-after': '60' } });
  } });
  const hunter = createHunter({ runtime: f.runtime, now: f.now }); hunter.start(); t.after(() => hunter.stop());
  const adapter = createDashboardAdapter({ runtime: f.runtime, now: f.now, tradeStore: createTradeStore({ runtime: f.runtime, now: f.now }) });
  t.after(() => adapter.close());
  return { ...f, calls, adapter, provider: gecko, market: createMarketData({ runtime: f.runtime, providers: { SOLANA: gecko }, now: f.now }) };
}
test('empty Gecko discovery 429 falls back to profiles plus quotes with honest completed progress', async t => {
  const f = discoverySetup(t), result = await f.market.scan(); await f.runtime.flush();
  assert.equal(result.status, 'COMPLETED'); assert.equal(result.completed, 2); assert.equal(result.total, 2);
  assert.equal(f.calls.filter(url => url.includes('dexscreener')).length, 2);
  const candidates = f.runtime.snapshot().events.filter(e => e.type === 'TokenCandidate');
  assert.equal(candidates.length, 2); assert.equal(f.events().length, 2);
  for (const candidate of candidates) {
    const sample = f.runtime.get(candidate.payload.snapshotId);
    assert.match(sample.source, /dexscreener-fallback/); assert.ok(sample.evidence.every(id => id.startsWith('dexscreener.')));
  }
  assert.equal(f.adapter.snapshot().scan.completed, 2); assert.equal(f.adapter.snapshot().scan.total, 2);
  assert.ok(f.runtime.snapshot().events.some(e => e.type === 'AIActivityEvent' && e.payload.message.startsWith('Discovery processed 2/2')));
});
test('profiles without quote samples never become candidates or trade inputs', async t => {
  const f = discoverySetup(t, 2, 1), result = await f.market.scan(); await f.runtime.flush();
  assert.equal(result.total, 2); assert.equal(result.completed, 1); assert.equal(result.status, 'PARTIAL_FAILURE');
  const events = f.runtime.snapshot().events;
  assert.equal(events.filter(e => e.type === 'TokenCandidate').length, 1);
  assert.equal(events.some(e => ['MarketSnapshot', 'TokenCandidate', 'ExecutionIntent', 'TradeResult'].includes(e.type) && e.payload.token === f.tokens[1]), false);
});

for (const retainedOnly of [false, true]) test('Gecko discovery outage and empty profiles re-quote five fresh candidates' + (retainedOnly ? ' retained only in discoveredAt' : ''), async t => {
  const f = discoverySetup(t, 5);
  await f.market.scan(); await f.runtime.flush();
  assert.deepEqual(f.provider.watched(), []);
  const tokens = [...f.tokens];
  f.tokens.length = 0;
  if (retainedOnly) {
    const snapshot = f.runtime.snapshot.bind(f.runtime);
    f.runtime.snapshot = () => {
      const state = snapshot();
      return { ...state, events: state.events.filter(e => !['MarketSnapshot', 'TokenCandidate'].includes(e.type) || Date.parse(e.timestamp) > at) };
    };
  }
  for (let sweep = 1; sweep <= 2; sweep++) {
    f.advance(60000);
    const start = f.calls.length, result = await f.market.scan(); await f.runtime.flush();
    assert.equal(result.status, 'PARTIAL_FAILURE');
    assert.equal(result.total, 5); assert.equal(result.completed, 5); assert.equal(result.failed, 0);
    const samples = f.events().filter(e => e.payload.observedAt === f.now().toISOString());
    assert.deepEqual(samples.map(e => e.payload.token).sort(), tokens);
    assert.equal(f.calls.slice(start).filter(url => url.includes('/latest/dex/tokens/')).length, 1);
    for (const sample of samples) {
      assert.match(sample.source, /dexscreener-fallback/);
      for (const id of sample.evidence) {
        const [kind, hash] = id.split('/');
        const bytes = fs.readFileSync(path.join(f.dir, hash + (kind.endsWith('body') ? '.body.json' : '.receipt.json')));
        assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
      }
    }
    const progress = f.runtime.snapshot().events.filter(e => e.type === 'ScanProgress' && e.payload.runId === result.runId).at(-1);
    assert.equal(progress.payload.completed, 5); assert.equal(progress.payload.total, 5);
    assert.ok(f.runtime.snapshot().events.some(e => e.type === 'AIActivityEvent' && e.correlationId === result.runId && e.payload.message.startsWith('Discovery processed 5/5')));
  }
});

test('Gecko discovery outage and empty profiles with zero fresh candidates complete partial with honest zero', async t => {
  const f = discoverySetup(t, 0), result = await f.market.scan(); await f.runtime.flush();
  assert.equal(result.status, 'PARTIAL_FAILURE'); assert.equal(result.total, 0); assert.equal(result.completed, 0);
  assert.equal(f.events().length, 0);
  assert.equal(f.calls.filter(url => url.includes('/latest/dex/tokens/')).length, 0);
  assert.ok(f.runtime.snapshot().events.some(e => e.type === 'AIActivityEvent' && e.payload.message.startsWith('Discovery processed 0/0')));
});

for (const count of [0, 5]) test('both discovery feeds fail with ' + count + ' fresh candidates without aborting the sweep', async t => {
  const f = discoverySetup(t, count);
  if (count) { await f.market.scan(); await f.runtime.flush(); f.advance(60000); }
  f.provider.fallbackDiscover = async () => { throw Error('DEXSCREENER_HTTP_FAILED'); };
  const result = await f.market.scan();
  assert.equal(result.status, 'PARTIAL_FAILURE'); assert.equal(result.completed, count); assert.equal(result.total, count);
  assert.equal(f.events().filter(e => e.payload.observedAt === f.now().toISOString()).length, count);
});

test('discovery request timeout still reaches fresh candidate quotes', async t => {
  const f = discoverySetup(t, 5);
  await f.market.scan(); await f.runtime.flush(); f.advance(60000);
  f.provider.discover = () => new Promise(() => {});
  f.provider.fallbackDiscover = () => new Promise(() => {});
  const market = createMarketData({ runtime: f.runtime, providers: { SOLANA: f.provider }, now: f.now, providerTimeoutMs: 100 });
  const result = await market.scan();
  assert.equal(result.status, 'PARTIAL_FAILURE'); assert.equal(result.completed, 5);
  assert.equal(f.events().filter(e => e.payload.observedAt === f.now().toISOString()).length, 5);
});
test('discovery fallback retains four quote batches per sweep and rotates during Gecko cooldown', async t => {
  const f = discoverySetup(t, 175);
  for (let sweep = 0; sweep < 15; sweep++) {
    const start = f.calls.length;
    assert.equal((await f.market.scan()).completed, 120);
    const calls = f.calls.slice(start);
    assert.equal(calls.filter(url => url.includes('token-profiles')).length, 1);
    assert.equal(calls.filter(url => url.includes('/latest/dex/tokens/')).length, 4);
    f.advance(60000);
  }
  const counts = f.tokens.map(token => f.events().filter(e => e.payload.token === token).length);
  assert.ok(Math.min(...counts) >= 5);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
});

test('fallback-only candidate is re-quoted next sweep and publishes five samples and signals within 30 minutes', async t => {
  const f = discoverySetup(t, 1);
  await f.market.scan(); await f.runtime.flush();
  assert.deepEqual(f.provider.watched(), []); // Fallback identifiers never enter Gecko's pool cache.
  f.tokens.length = 0; // The latest discovery feed no longer contains this token.
  for (let sweep = 1; sweep < 5; sweep++) {
    f.advance(5 * 60000);
    await f.market.scan(); await f.runtime.flush();
    assert.equal(f.events().filter(e => e.payload.token === 'token0').length, sweep + 1);
  }
  const samples = f.events();
  assert.equal(new Set(samples.map(e => e.payload.observedAt)).size, 5);
  assert.equal(f.runtime.snapshot().events.filter(e => e.type === 'SignalObservation').length, 5);
  assert.ok(samples.every(e => e.source.includes('#dexscreener-fallback') && e.evidence.length > 0));
  assert.deepEqual(f.runtime.snapshot().deliveryErrors, []);
});

test('recovered discovery still re-quotes fallback-only tokens missing from Gecko quotes', async t => {
  const f = discoverySetup(t, 1);
  await f.market.scan(); f.advance(60000);
  f.provider.discover = async () => [];
  f.provider.quotes = async () => [];
  await f.market.scan();
  assert.equal(f.events().length, 2);
});

for (const action of ['BUY', 'NO_ACTION']) test(action + ' decision removes a token from fresh re-quote priority', async t => {
  const f = discoverySetup(t, 1);
  await f.market.scan(); await f.runtime.flush();
  const candidate = f.runtime.snapshot().events.find(e => e.type === 'TokenCandidate');
  const sample = f.runtime.get(candidate.payload.snapshotId);
  f.runtime.publish({ ...sample, id: 'fixture-regime', type: 'MarketRegimeState', payload: { regime: 'TRENDING', snapshotIds: [sample.id], reason: 'Priority fixture' } });
  f.runtime.publish({ ...sample, id: 'priority-decision', type: 'StrategyDecision', producer: 'CODEX_1', status: 'COMPLETED', payload: {
    candidateId: candidate.id, snapshotId: sample.id, signalIds: [], strategyVersion: 'fixture', quantEvidenceIds: [], criticReportIds: [], regimeId: 'fixture-regime', action, disposition: action === 'BUY' ? 'TRADE' : 'REJECT', reason: 'Priority fixture'
  } });
  f.tokens.push(...Array.from({ length: 120 }, (_, i) => 'fresh' + i));
  f.advance(60000); await f.market.scan();
  f.advance(60000); await f.market.scan();
  assert.equal(f.events().filter(e => e.payload.token === 'token0').length, 1);
  assert.ok(f.tokens.slice(1).every(token => f.events().filter(e => e.payload.token === token).length === 2));
});

test('fallback candidates expire instead of rotating back into the old-band queue', async t => {
  const f = discoverySetup(t, 120);
  await f.market.scan();
  f.advance(30 * 60000);
  f.provider.adopt(f.tokens.map(token => ({ token, poolAddress: token + 'pool', born: at - 86400000 })));
  f.provider.profile = token => token.startsWith('token') ? { liquidityUsd: 20000, band: true, born: at - 86400000 } : null;
  await f.market.scan();
  f.advance(60000); await f.market.scan();
  assert.ok(f.tokens.slice(0, 120).every(token => f.events().filter(e => e.payload.token === token).length === 1));
  f.advance(29 * 60000); await f.market.scan();
  assert.ok(f.tokens.slice(0, 120).every(token => f.events().filter(e => e.payload.token === token).length === 1));
  assert.deepEqual(f.provider.watched(), []);
});
test('agent projection counts fallback hunter work, verdicts and downstream decisions without source filtering', async t => {
  const f = discoverySetup(t); await f.market.scan(); await f.runtime.flush();
  const events = f.runtime.snapshot().events, candidate = events.find(e => e.type === 'TokenCandidate'), sample = f.runtime.get(candidate.payload.snapshotId), signal = events.find(e => e.type === 'SignalObservation');
  // Downstream contract fixtures retain the real fallback candidate/snapshot links.
  const envelope = { ...sample, evidence: [candidate.id, sample.id], status: 'COMPLETED' };
  f.runtime.publish({ ...envelope, id: 'fallback-verdict', type: 'JevVerdict', producer: 'JEV', payload: { candidateId: candidate.id, action: 'WATCH', confidence: .8, tradableProbability: .5, momentum: 2, model: 'fixture', latencyMs: 1, violations: [] } });
  f.runtime.publish({ ...envelope, id: 'fallback-regime', type: 'MarketRegimeState', payload: { regime: 'TRENDING', snapshotIds: [sample.id], reason: 'Projection fixture' } });
  f.runtime.publish({ ...envelope, id: 'fallback-decision', type: 'StrategyDecision', producer: 'CODEX_1', payload: { candidateId: candidate.id, snapshotId: sample.id, signalIds: [signal.id], strategyVersion: 'meme-flow-v1', quantEvidenceIds: [], criticReportIds: [], regimeId: 'fallback-regime', action: 'BUY', disposition: 'TRADE', reason: 'Projection fixture' } });
  for (const producer of ['CODEX_1', 'CODEX_2', 'CODEX_3']) f.runtime.publish({ ...envelope, id: 'fallback-activity-' + producer, type: 'AIActivityEvent', producer, payload: { agent: producer, task: sample.id, state: 'COMPLETED', progress: null, message: 'Fallback evidence reviewed' } });
  await f.runtime.flush();
  const state = f.adapter.snapshot();
  assert.equal(state.agents.length, 4); assert.ok(state.agents.every(agent => agent.completed > 0));
  assert.equal(state.agents[0].tokensThisHour, 2); assert.equal(state.agents[0].metric.done, 2);
  assert.equal(state.agents[1].metric.done, 1); assert.equal(state.jev.verdicts, 1);
  assert.deepEqual(f.runtime.snapshot().deliveryErrors, []);
});
