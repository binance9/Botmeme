'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), { createHash } = require('node:crypto');
const { createGeckoTerminal } = require('../core/market-data/providers/geckoterminal.cjs');
const { validateEvent } = require('../runtime/contracts/index.cjs');
const now = () => new Date('2026-09-24T10:00:10.000Z');
const pool = (token = 'token1', address = 'pool1', network = 'solana') => ({ id: network + '_' + address, type: 'pool', attributes: { address, reserve_in_usd: '100000', volume_usd: { h24: '50000' }, pool_created_at: '2026-09-24T09:57:10.000Z', market_cap_usd: '15000' }, relationships: { base_token: { data: { id: network + '_' + token, type: 'token' } } } });
const trade = (id, changes = {}) => ({ id: 'solana_' + id, type: 'trade', attributes: { tx_hash: 'tx' + id, block_number: 42, block_timestamp: '2026-09-24T10:00:00Z', from_token_address: 'token1', to_token_address: 'quote', price_from_in_usd: '2', price_to_in_usd: '1', volume_in_usd: '60', ...changes } });
const response = data => new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } });
test('old-token volume spikes stay outside the fresh sweep universe', async t => {
  let round = 0;
  const old = (token, days, volume = 0) => {
    const row = pool(token, token + 'pool');
    row.attributes.market_cap_usd = '15000';
    row.attributes.pool_created_at = new Date(+now() - days * 86400000).toISOString();
    row.attributes.volume_usd.m5 = String(volume); return row;
  };
  const residents = Array.from({ length: 60 }, (_, i) => old('resident' + i, 90));
  const { provider } = setup(t, async url => {
    if (url.includes('new_pools')) { round++; return response([]); }
    const page = Number(new URL(url).searchParams.get('page'));
    return response(page === 1 ? residents : page === 2 ? [old('returning', 45, round > 1 ? 1500 : 400)] : []);
  });
  assert.equal((await provider.discover()).includes('returning'), false);
  const next = await provider.discover();
  assert.deepEqual(next, []); assert.equal(round, 2);
});
function setup(t, fetcher, changes = {}) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gecko-contract-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return { dir, provider: createGeckoTerminal({ network: 'SOLANA', networkId: 'solana', now, fetcher, evidenceDirectory: dir, ...changes }) }; }
test('Gecko exact-chain limited discovery and timestamped trade validation preserve raw evidence with paced requests', async t => {
  const times = [], { provider, dir } = setup(t, async (url, options) => {
    times.push(performance.now()); assert.equal(options.redirect, 'error'); assert.equal(options.method, 'GET'); assert.ok(url.startsWith('https://api.geckoterminal.com/api/v2/networks/solana/'));
    if (url.includes('trending_pools')) return response([]);
    if (url.includes('new_pools')) return response([pool('wrong', 'pool0', 'bsc'), ...Array.from({ length: 8 }, (_, i) => pool('token' + (i + 1), 'pool' + (i + 1)))]);
    if (url.includes('sort=')) return response([]); // wide band sweep: empty page ends the sweep
    if (url.endsWith('/trades')) return response([trade('old'), trade('new', { block_timestamp: '2026-09-24T10:00:05Z', from_token_address: 'quote', to_token_address: 'token1', price_to_in_usd: '3' }), trade('future', { block_timestamp: '2030-01-01T00:00:00Z', price_from_in_usd: '999' }), trade('wrongtoken', { from_token_address: 'another', price_from_in_usd: '999' })]);
    return response(pool());
  });
  assert.deepEqual(await provider.discover(), ['token1', 'token2', 'token3', 'token4', 'token5', 'token6', 'token7', 'token8']);
  const sample = await provider.snapshot('token1'); assert.equal(sample.price, 3); assert.equal(sample.observedAt, now().toISOString()); assert.equal(sample.poolAgeMs, 180000); assert.equal(sample.confidence, .8); assert.deepEqual(sample.missing_evidence, []);
  assert.match(sample.source, /#trade-sha256=[a-f0-9]{64}$/);
  assert.doesNotThrow(() => validateEvent({ id: 'sample', type: 'MarketSnapshot', timestamp: now().toISOString(), producer: 'MARKET_DATA', source: sample.source, evidence: sample.evidence, status: 'OBSERVED', correlationId: 'sample', network: 'SOLANA', epoch: 1, confidence: sample.confidence, evidence_quality: sample.evidence_quality, missing_evidence: sample.missing_evidence, uncertainty: sample.uncertainty, payload: { token: sample.token, price: sample.price, liquidityUsd: sample.liquidityUsd, volume24hUsd: sample.volume24hUsd, observedAt: sample.observedAt } }, { now }));
  assert.ok(times[1] > times[0]);
  assert.ok(times[1] - times[0] < 500, 'a new-pool page is not held for seconds before the next read');
  assert.equal(times.length, 2, 'one new-pool page and one timestamped trade request');
  assert.equal(sample.evidence.length, 4);
  for (const id of sample.evidence) { const [kind, digest] = id.split('/'), suffix = kind.endsWith('body') ? '.body.json' : '.receipt.json'; const bytes = fs.readFileSync(path.join(dir, digest + suffix)); assert.equal(createHash('sha256').update(bytes).digest('hex'), digest); }
});
test('Gecko rejects missing upstream trade time without using pool or receipt timestamp', async t => {
  const { provider } = setup(t, async url => response(url.includes('trending_pools') ? [] : url.includes('new_pools') ? [pool()] : url.includes('sort=') ? [] : url.endsWith('/trades') ? [trade('missing', { block_timestamp: null }), trade('bad', { block_timestamp: 'invalid' }), trade('impossible-date', { block_timestamp: '2026-02-30T00:00:00Z' })] : pool()));
  await provider.discover(); await assert.rejects(provider.snapshot('token1'), /TIMESTAMPED_TRADE_UNVERIFIED/);
});
test('Gecko refreshes expired discovery liquidity and revalidates network before requesting trades', async t => {
  let calls = 0, clock = now(); const { provider } = setup(t, async url => { calls++; return response(url.includes('trending_pools') ? [] : url.includes('new_pools') ? [pool()] : url.includes('sort=') ? [] : pool('other', 'pool1', 'bsc')); }, { now: () => clock });
  await provider.discover(); clock = new Date(clock.getTime() + 30001);
  await assert.rejects(provider.snapshot('token1'), /POOL_UNVERIFIED/); assert.equal(calls, 2, 'new-pool page and the revalidated pool route');
});
test('Gecko never falls back for unknown Robinhood network or unverified pool tokens', async t => {
  const urls = [], { provider } = setup(t, async url => { urls.push(url); return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }); }, { network: 'ROBINHOOD', networkId: 'robinhood' });
  await assert.rejects(provider.discover(), /HTTP_FAILED/); assert.equal(urls.length, 1); assert.ok(urls[0].includes('/robinhood/'));
  await assert.rejects(provider.snapshot('token1'), /TOKEN_NOT_DISCOVERED/); await assert.rejects(provider.snapshot('../token'), /TOKEN_NOT_DISCOVERED/); assert.equal(urls.length, 1);
});
test('Gecko HTTP rejects oversized invalid and redirected responses', async t => {
  for (const make of [() => new Response(' '.repeat(1048577), { headers: { 'content-type': 'application/json' } }), () => new Response('no', { headers: { 'content-type': 'application/json' } }), () => new Response('{}', { status: 302 }), () => new Response('[]', { headers: { 'content-type': 'application/json' } })]) {
    const { provider } = setup(t, async () => make()); await assert.rejects(provider.discover(), /GECKOTERMINAL_/);
  }
});
test('Gecko queued requests honor abort during enforced pacing', async t => {
  let calls = 0; const { provider } = setup(t, async () => { calls++; return response([]); });
  await provider.discover(); const controller = new AbortController(), task = provider.discover({ signal: controller.signal });
  controller.abort(); await assert.rejects(task, /REQUEST_ENDED/); assert.equal(calls, 1, 'new-pool page; the aborted sweep adds no request');
});
test('Gecko scans every validated active and new pool on the selected network', async t => {
  let scan = 0;
  const active = (token, count) => { const row = pool(token, token + 'pool'); row.attributes.transactions = { m5: { buys: count, sells: 0 } }; return row; };
  const rich = pool('rich', 'richpool'); rich.attributes.market_cap_usd = '150000';
  const old = pool('old', 'oldpool'); old.attributes.pool_created_at = '2026-09-24T09:00:00.000Z';
  const { provider, dir } = setup(t, async url => {
    if (url.includes('new_pools')) { scan++; const missingLiquidity = pool('nullLiquidity', 'nullpool'); missingLiquidity.attributes.reserve_in_usd = null; return response([missingLiquidity, rich, old, ...Array.from({ length: 5 }, (_, i) => pool('new' + scan + i, 'pool' + scan + i))]); }
    if (url.includes('sort=')) return response([]); // wide band sweep: empty page ends the sweep
    if (url.includes('trending_pools')) return response([active('quiet', 0), active('active10', 10), active('active30', 30), active('active20', 20), { ...active('crossChain', 999), id: 'bsc_crossChainpool' }, pool('unknownActivity', 'unknownpool')]);
    throw Error('Discovery-only test.');
  });
  // The entry band excludes 150k; the sweep also excludes one-hour pools.
  assert.deepEqual(await provider.discover(), ['new10', 'new11', 'new12', 'new13', 'new14']);
  assert.deepEqual(await provider.discover(), ['new10', 'new11', 'new12', 'new13', 'new14', 'new20', 'new21', 'new22', 'new23', 'new24']);
  const receipts = fs.readdirSync(dir).filter(f => f.endsWith('.receipt.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f))));
  assert.ok(receipts.some(row => row.url.includes('new_pools')));
  assert.equal(receipts.some(row => row.url.includes('trending_pools')), false);
});
test('Gecko reads later pages until the newest list is full, then filters expired pools and rejects 150k caps', async t => {
  const pages = [];
  const { provider } = setup(t, async url => {
    pages.push(url);
    if (url.includes('sort=')) return response([]); // wide band sweep: empty page ends the sweep
    if (url.includes('page=1')) return new Response(JSON.stringify({ data: [pool('a', 'pa')], links: { next: 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=2' } }), { headers: { 'content-type': 'application/json' } });
    if (url.includes('page=2')) {
      const aged = pool('b', 'pb'); aged.attributes.pool_created_at = '2026-09-24T09:00:00.000Z';
      const rich = pool('rich', 'prich'); rich.attributes.market_cap_usd = '150000';
      return new Response(JSON.stringify({ data: [pool('c', 'pc'), aged, rich], links: { next: 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=3' } }), { headers: { 'content-type': 'application/json' } });
    }
    return response([]);
  });
  assert.deepEqual(await provider.discover(), ['a', 'c']);
  assert.equal(provider.swept, 3, 'fresh pools are counted as swept even when their cap fails admission');
  assert.equal(pages.filter(url => url.includes('new_pools') && url.includes('page=3')).length, 0, 'the two-page newest budget is respected');
});
test('Gecko stops at the newest-pool page budget', async t => {
  const pages = [];
  const { provider } = setup(t, async url => {
    const page = Number(new URL(url).searchParams.get('page'));
    pages.push(url);
    if (url.includes('sort=')) return response([]); // wide band sweep: empty page ends the sweep
    const start = (page - 1) * 20;
    const data = Array.from({ length: 20 }, (_, i) => pool('t' + (start + i), 'p' + (start + i)));
    const next = 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=' + (page + 1);
    return new Response(JSON.stringify({ data, links: { next } }), { headers: { 'content-type': 'application/json' } });
  });
  const tokens = await provider.discover();
  assert.deepEqual(pages.filter(url => url.includes('new_pools')).map(url => Number(new URL(url).searchParams.get('page'))), [1, 2], 'the newest feed gets its two-page budget, no more');
  assert.equal(tokens.length, 40);
  assert.equal(tokens[0], 't0');
  assert.equal(tokens[39], 't39');
  assert.equal(provider.swept, 40);
});
test('full watchlist admits a genuinely newer pool and returns it first',async t=>{let round=0;const {provider}=setup(t,async()=>{round++;if(round===1)return response(Array.from({length:200},(_,i)=>pool('older'+i,'pool'+i)));const newest=pool('newest','newestpool');newest.attributes.pool_created_at='2026-09-24T09:59:10.000Z';return response([newest]);});assert.equal((await provider.discover()).length,200);const next=await provider.discover();assert.equal(next.length,200);assert.equal(next[0],'newest');assert.ok(!next.includes('older0'));});

test('Gecko retains the 10k floor and refreshes five-minute volume while excluding old pools', async t => {
  const young = pool('young', 'youngpool'), old = pool('old', 'oldpool');
  young.attributes.market_cap_usd = '10000'; young.attributes.base_token_price_usd = '.001';
  old.attributes.market_cap_usd = '150000'; old.attributes.base_token_price_usd = '.001';
  old.attributes.pool_created_at = new Date(+now() - 45 * 86400000).toISOString();
  young.attributes.volume_usd.m5 = '400'; young.attributes.transactions = { m5: { buys: 2, sells: 2 } };
  const { provider } = setup(t, async url => response(url.includes('new_pools') ? [young] : url.includes('multi/') ? [young] : url.includes('sort=') ? [old] : []));
  const tokens = await provider.discover();
  assert.deepEqual(tokens, ['young']);
  assert.equal(provider.profile('old'), null);
  let samples = await provider.quotes(['young']); assert.equal(samples[0].recentVolumeUsd, 400);
  young.attributes.volume_usd.m5 = '1500';
  samples = await provider.quotes(['young']);
  assert.equal(samples[0].recentVolumeUsd, 1500); assert.equal(samples[0].recentTxs5m, 4);
  assert.equal(samples[0].poolAgeMs, 3 * 60000);
});

test('Gecko discovery and explicit watch share inclusive 10k to 20k cap boundaries', async t => {
  const caps = [9999, 10000, 20000, 20001, 25000, 30000, 30001, 10000000, 10000001, 50000000, 1000000000];
  const rows = caps.map(cap => { const row = pool('cap' + cap, 'pool' + cap); row.attributes.market_cap_usd = String(cap); return row; });
  const { provider } = setup(t, async url => response(url.includes('new_pools') ? rows : rows.filter(row => url.includes('/tokens/' + row.relationships.base_token.data.id.slice(7) + '/'))));
  assert.deepEqual(await provider.discover(), ['cap10000', 'cap20000']);
  for (const cap of caps) {
    provider.forget('cap' + cap);
    assert.equal(await provider.watch('cap' + cap), cap >= 10000 && cap <= 20000);
  }
});

test('Gecko shares upstream 429 backoff across network adapters without retry storms', async t => {
  let calls = 0; const { provider } = setup(t, async () => { calls++; return new Response('{}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60' } }); });
  await assert.rejects(provider.discover(), /HTTP_FAILED_429/);
  const other = setup(t, async () => { calls++; return response([]); }, { network: 'BSC', networkId: 'bsc' }).provider;
  await assert.rejects(other.discover(), /RATE_LIMIT_COOLDOWN/); assert.equal(calls, 1);
});
