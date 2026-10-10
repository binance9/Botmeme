'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('../runtime/events/bus.cjs');
const { createMarketData } = require('../core/market-data/service.cjs');
const { createMarketRuntime } = require('../runtime/market-runtime.cjs');
const at = '2026-09-24T09:00:00.000Z', now = () => new Date(at);
test('rate-limited unread pools stay queued and are not counted as found', async t => {
  const runtime=createRuntime({now});t.after(()=>runtime.close());let calls=0;
  const service=createMarketData({runtime,now,providers:{SOLANA:{network:'SOLANA',async discover(){return ['a','b','c'];},async snapshot(){calls++;throw Error('GECKOTERMINAL_HTTP_FAILED_429');},retryAfterMs:()=>30000}}});
  const started=Date.now();
  const result=await service.scan();
  assert.ok(Date.now()-started<400);
  assert.equal(calls,1);
  assert.equal(result.total,3);assert.equal(result.completed,0);assert.equal(result.failed,0);assert.equal(result.status,'PARTIAL_FAILURE');
  assert.equal(runtime.snapshot().events.filter(e=>e.type==='MarketSnapshot').length,0);
  const progress=runtime.snapshot().events.findLast(e=>e.type==='ScanProgress');
  assert.equal(progress.payload.completed,0);assert.equal(progress.payload.total,3);assert.equal(progress.payload.state,'PARTIAL_FAILURE');
});
// Interface counterexamples only: these do not verify an external data provider.
function sample(token) { return { token, price: 2, liquidityUsd: 10000, volume24hUsd: 1000, poolAgeMs: 5 * 60000, marketCapUsd: 10000, observedAt: at, source: 'protocol-fixture', evidence: ['fixture-record'], confidence: 0.8, evidence_quality: 0.8, missing_evidence: [], uncertainty: 0.2 }; }
test('market discovery outage stays partial and only resets after a successful scan', async t => {
  const runtime=createRuntime({now}); t.after(()=>runtime.close()); let fail=true, recovered=0;
  const provider={network:'SOLANA',async discover(){if(fail)throw Error('GECKOTERMINAL_HTTP_FAILED_429');return ['a'];},async snapshot(){return sample('a');},retryAfterMs:()=>3600000,recovered(){recovered++;}};
  const service=createMarketData({runtime,now,providers:{SOLANA:provider}});
  const partial = await service.scan();
  assert.equal(partial.status, 'PARTIAL_FAILURE'); assert.equal(partial.completed, 0);
  assert.equal(recovered,0); fail=false; await service.scan(); assert.equal(recovered,1);
});
test('market discovery progress advances only after actual provider work settles and errors never fabricate prices', async t => {
  const runtime = createRuntime({ now }); t.after(() => runtime.close());
  let release;
  const provider = { network: 'SOLANA', async discover() { return ['a', 'b']; }, async snapshot(token) { if (token === 'b') throw Error('provider private detail'); return new Promise(resolve => { release = () => resolve(sample(token)); }); } };
  const service = createMarketData({ runtime, providers: { SOLANA: provider }, now });
  const scan = service.scan(); await new Promise(resolve => setImmediate(resolve));
  const early = runtime.snapshot().events;
  assert.equal(early.filter(e => e.type === 'MarketSnapshot').length, 0);
  assert.equal(early[0].payload.progress, null);
  release(); const result = await scan; await runtime.flush();
  assert.equal(result.completed, 2); assert.equal(result.failed, 1); assert.equal(result.status, 'PARTIAL_FAILURE');
  const events = runtime.snapshot().events;
  assert.equal(events.filter(e => e.type === 'MarketSnapshot').length, 1);
  assert.deepEqual(events.filter(e => e.type === 'AIActivityEvent').map(e => e.payload.progress), [null, 0, 0.5, 1, 1]);
  assert.equal(events.at(-1).payload.state, 'PARTIAL_FAILURE');
  assert.ok(!JSON.stringify(events).includes('provider private detail'));
});
test('market service never substitutes a different network provider and rejects late sessions', async t => {
  const runtime = createRuntime({ now }); t.after(() => runtime.close());
  const service = createMarketData({ runtime, now, providers: { SOLANA: { network: 'BSC' } } });
  await assert.rejects(service.scan(), /NETWORK_PROVIDER_UNVERIFIED/);
  const changing = createMarketData({ runtime, now, providers: { SOLANA: { network: 'SOLANA', async discover() { runtime.selectNetwork('BSC'); return ['a']; }, async snapshot() { throw Error('must not run'); } } } });
  await assert.rejects(changing.scan(), /SCAN_SESSION_ENDED/);
  assert.equal(runtime.snapshot().events.filter(e => e.type === 'MarketSnapshot').length, 0);
});
test('market service retains missing upstream evidence and denies mismatched token records', async t => {
  const runtime = createRuntime({ now }); t.after(() => runtime.close());
  const service = createMarketData({ runtime, now, providers: { SOLANA: { network: 'SOLANA', async discover() { return ['a', 'b']; }, async snapshot(token) { return token === 'a' ? { ...sample(token), missing_evidence: ['UPSTREAM_TIMESTAMP_UNAVAILABLE'] } : sample('a'); } } } });
  const result = await service.scan(); await runtime.flush();
  assert.equal(result.failed, 1);
  const data = runtime.snapshot().events.filter(e => e.type === 'MarketSnapshot');
  assert.equal(data.length, 1); assert.equal(data[0].status, 'CHUA_XAC_MINH');
  assert.deepEqual(data[0].missing_evidence, ['UPSTREAM_TIMESTAMP_UNAVAILABLE']);
});

test('market service bounds hung providers and stop cancels outstanding discovery', async t => {
  const runtime = createRuntime({ now }); t.after(() => runtime.close());
  const providers = { SOLANA: { network: 'SOLANA', discover: () => new Promise(() => {}), snapshot: () => new Promise(() => {}) } };
  const timed = createMarketData({ runtime, now, providers, providerTimeoutMs: 15 });
  const partial = await timed.scan();
  assert.equal(partial.status, 'PARTIAL_FAILURE'); assert.equal(partial.completed, 0);
  const stopped = createMarketData({ runtime, now, providers });
  const pending = stopped.scan(); stopped.stop();
  await assert.rejects(pending, /SCAN_SESSION_ENDED/);
  assert.equal(runtime.snapshot().events.filter(e => e.type === 'MarketSnapshot').length, 0);
});

test('research composition wires discovery through journal to Hunter and follows the selected network', async t => {
  const provider = network => ({ network, async discover() { return ['token']; }, async snapshot(token) { return sample(token); } });
  const app = createMarketRuntime({ now, providers: { SOLANA: provider('SOLANA'), BSC: provider('BSC') } });
  t.after(() => app.close());
  await app.market.scan(); await app.runtime.flush();
  let candidates = app.runtime.snapshot().events.filter(e => e.type === 'TokenCandidate');
  assert.equal(candidates.length, 1); assert.equal(candidates[0].network, 'SOLANA');
  app.selectNetwork('BSC'); await app.market.scan(); await app.runtime.flush();
  candidates = app.runtime.snapshot().events.filter(e => e.type === 'TokenCandidate');
  assert.deepEqual(candidates.map(e => [e.network, e.epoch]), [['SOLANA', 1], ['BSC', 2]]);
  assert.ok(app.runtime.snapshot().events.every(e => !['ExecutionIntent', 'TradeResult'].includes(e.type)));
});
test('market deduplicates repeated and older timestamps across service restart while retaining real progress', async t => {
  const runtime = createRuntime({ now }); t.after(() => runtime.close()); let value = sample('token');
  const providers = { SOLANA: { network: 'SOLANA', async discover() { return ['token']; }, async snapshot() { return value; } } };
  await createMarketData({ runtime, now, providers }).scan();
  value = { ...value, evidence: ['different-receipt-same-trade'], liquidityUsd: 11000 };
  const restarted = createMarketData({ runtime, now, providers });
  const duplicate = await restarted.scan(); assert.equal(duplicate.skipped, 1); assert.equal(duplicate.completed, 1); assert.equal(duplicate.failed, 0);
  value = { ...value, observedAt: '2026-09-24T08:59:00.000Z', price: 1 };
  const old = await restarted.scan(); assert.equal(old.skipped, 1); assert.equal(old.failed, 0);
  assert.equal(runtime.snapshot().events.filter(e => e.type === 'MarketSnapshot').length, 1);
  assert.equal(runtime.snapshot().events.findLast(e => e.type === 'AIActivityEvent').payload.progress, 1);
  const counts = runtime.snapshot().events.findLast(e => e.type === 'ScanProgress').payload;
  assert.equal(counts.completed, 1); assert.equal(counts.total, 1); assert.equal(counts.skipped, 1); assert.equal(counts.failed, 0);
});
test('market rejects changed price at identical timestamp and validates malformed/future timestamps before dedupe', async t => {
  const runtime = createRuntime({ now }); t.after(() => runtime.close()); let value = sample('token');
  const service = createMarketData({ runtime, now, providers: { SOLANA: { network: 'SOLANA', async discover() { return ['token']; }, async snapshot() { return value; } } } });
  await service.scan();
  for (const change of [{ price: 3 }, { observedAt: 'bad-date' }, { observedAt: '2026-09-24T10:00:00.000Z' }, { price: NaN }]) {
    value = { ...sample('token'), ...change }; const result = await service.scan(); assert.equal(result.failed, 1); assert.equal(result.skipped, 0); assert.equal(result.completed, 1);
  }
  assert.equal(runtime.snapshot().events.filter(e => e.type === 'MarketSnapshot').length, 1);
});
test('market timestamp dedupe isolates token network epoch and accepts strictly newer observations', async t => {
  let clock = new Date(at), value = sample('token'); const localNow = () => clock;
  const runtime = createRuntime({ now: localNow }); t.after(() => runtime.close());
  const provider = network => ({ network, async discover() { return ['token', 'other']; }, async snapshot(token) { return { ...value, token }; } });
  const service = createMarketData({ runtime, now: localNow, providers: { SOLANA: provider('SOLANA'), BSC: provider('BSC') } });
  await service.scan(); clock = new Date('2026-09-24T09:00:01.000Z'); value = { ...value, observedAt: clock.toISOString() }; await service.scan();
  runtime.selectNetwork('BSC'); await service.scan(); runtime.selectNetwork('SOLANA'); await service.scan();
  const rows = runtime.snapshot().events.filter(e => e.type === 'MarketSnapshot'); assert.equal(rows.length, 8);
  assert.deepEqual(rows.map(e => e.epoch), [1, 1, 1, 1, 2, 2, 3, 3]);
});
test('stop cancels a chunked scan without waiting for the remaining pools', async t => {
  const runtime = createRuntime({ now }); t.after(() => runtime.close());
  let seen = 0;
  const provider = { network: 'SOLANA', usesChain: true, watched() { return ['a', 'b', 'c', 'd']; }, census() { return { watching: 4 }; },
    async chainSnapshots(list, { signal }) {
      const out = [];
      for (const token of list) {
        seen += 1;
        await new Promise(resolve => setImmediate(resolve));
        if (signal?.aborted) throw Error('PROVIDER_REQUEST_ENDED');
        out.push(sample(token));
      }
      return out;
    },
    async discover() { return ['a', 'b', 'c', 'd']; }, async snapshot() { throw Error('UNEXPECTED'); } };
  const service = createMarketData({ runtime, now, providers: { SOLANA: provider } });
  const pending = service.scan();
  await new Promise(resolve => setImmediate(resolve));
  const started = Date.now();
  service.stop();
  await assert.rejects(pending, /SCAN_SESSION_ENDED/);
  assert.ok(Date.now() - started < 1000);
  assert.ok(seen < 4);
});

test('sweep preserves discovery order for equally prioritized young pools', async t => {
  const runtime = createRuntime({ now }); t.after(() => runtime.close());
  const calls = [], ages = { 'z-old': 20 * 60000, 'a-new': 2 * 60000 };
  const provider = { network: 'SOLANA', async discover() { return ['z-old', 'a-new']; },
    profile: token => ({ liquidityUsd: 20000, born: Date.parse(at) - ages[token] }),
    async snapshot(token) { calls.push(token); return { ...sample(token), poolAgeMs: ages[token] }; } };
  await createMarketData({ runtime, now, providers: { SOLANA: provider } }).scan();
  assert.deepEqual(calls, ['z-old', 'a-new'], 'owner directive: oldest pool first');
});

test('unknown age stays in the sweep and is quoted and published once', async t => {
  const runtime = createRuntime({ now }); t.after(() => runtime.close());
  const calls = [], value = sample('unknown'); delete value.poolAgeMs; delete value.marketCapUsd;
  const provider = { network: 'SOLANA', watched: () => ['unknown'], discover: async () => ['unknown'],
    profile: () => ({ volume24hUsd: 1000 }),
    fallbackQuotes: async () => { throw Error('unexpected fallback'); },
    quotes: async tokens => { calls.push(...tokens); return [value, value]; },
    snapshot: async () => { throw Error('unexpected deep quote'); } };
  const result = await createMarketData({ runtime, now, providers: { SOLANA: provider } }).scan();
  assert.equal(result.status, 'COMPLETED'); assert.equal(result.total, 1); assert.equal(result.completed, 1);
  assert.deepEqual(calls, ['unknown']);
  const events = runtime.snapshot().events.filter(e => e.type === 'MarketSnapshot');
  assert.equal(events.length, 1); assert.equal(Object.hasOwn(events[0].payload, 'poolAgeMs'), false);
});

test('sweep drops known ages over 30 minutes before quoting and after metadata lookup', async t => {
  const runtime = createRuntime({ now }); t.after(() => runtime.close()); const calls = [];
  const provider = { network: 'SOLANA', discover: async () => ['known-old', 'lookup-old', 'boundary'],
    profile: token => token === 'known-old' ? { born: Date.parse(at) - 30 * 60000 - 1 } : null,
    async snapshot(token) { calls.push(token); return { ...sample(token), poolAgeMs: 30 * 60000 + (token === 'lookup-old' ? 1 : 0) }; } };
  const result = await createMarketData({ runtime, now, providers: { SOLANA: provider } }).scan();
  assert.equal(result.failed, 0); assert.deepEqual(calls, ['lookup-old', 'boundary']);
  assert.deepEqual(runtime.snapshot().events.filter(e => e.type === 'MarketSnapshot').map(e => e.payload.token), ['boundary']);
});
