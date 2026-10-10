'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createRuntime } = require('../runtime/events/bus.cjs');
const { createTradeStore } = require('../core/trades/store.cjs');
const { createMarketData } = require('../core/market-data/service.cjs');
const { createRegimeEngine } = require('../core/market-data/regime.cjs');
const { createHunter } = require('../services/jev/hunter.cjs');
const { createCommander } = require('../services/commander/service.cjs');
const { createRiskEngine } = require('../core/risk/engine.cjs');
const { createStrategyEngine } = require('../core/strategy/engine.cjs');
const { createSafetyGate } = require('../core/safety/gate.cjs');
const { createPaperExecution } = require('../core/execution/paper.cjs');

test('Gecko admits only fresh pools and never requests old-band rotation', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-fresh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = new Date('2026-10-05T10:00:00Z'); const calls = [];
  const pool = (token, minutes) => ({ type: 'pool', id: 'solana_' + token + 'pool', attributes: { address: token + 'pool', pool_created_at: new Date(+clock - minutes * 60000).toISOString(), base_token_price_usd: '.001', market_cap_usd: '10000', reserve_in_usd: '0', volume_usd: { h24: '1000' } }, relationships: { base_token: { data: { type: 'token', id: 'solana_' + token } } } });
  const rows = [pool('fresh', 29), pool('expired', 31), pool('oldBand', 45 * 24 * 60)];
  const provider = require('../core/market-data/providers/geckoterminal.cjs').createGeckoTerminal({ network: 'SOLANA', networkId: 'solana', now: () => clock, evidenceDirectory: dir,
    fetcher: async url => { calls.push(url); return new Response(JSON.stringify({ data: rows }), { headers: { 'content-type': 'application/json' } }); } });
  assert.deepEqual(await provider.discover(), ['fresh']);
  assert.deepEqual(provider.watched(), ['fresh']);
  assert.equal((await provider.quotes(['fresh', 'expired', 'oldBand'])).length, 1);
  assert.ok(calls.every(url => !url.includes('sort=') && !url.includes('expiredpool') && !url.includes('oldBandpool')));
  clock = new Date(+clock + 2 * 60000);
  assert.deepEqual(provider.watched(), []);
  assert.deepEqual(await provider.quotes(['fresh']), []);
});

test('owner entry constants and inclusive age/volume boundaries', () => {
  const { ENTRY_BAND, ENTRY_MIN_VOL_USD, entryBand, memeEntryReason } = require('../core/risk/engine.cjs');
  assert.deepEqual(ENTRY_BAND, [10000, 20000]);
  assert.equal(ENTRY_MIN_VOL_USD, 1000);
  for (const age of [undefined, null, -1, 1.5, NaN, Infinity]) assert.equal(entryBand(age), null);
  for (const poolAgeMs of [0, 59000, 60000, 31 * 60000, 2 * 3600000, 45 * 86400000]) {
    for (const marketCapUsd of [9999, 10000, 20000, 20001, 25000, 30000, 30001, 10000000, 10000001, 50000000, 1000000000]) {
      assert.equal(memeEntryReason({ poolAgeMs, marketCapUsd, realVolumeUsd: 1000 }) === null, marketCapUsd >= 10000 && marketCapUsd <= 20000);
    }
    assert.match(memeEntryReason({ poolAgeMs, marketCapUsd: 10000, recentVolumeUsd: 999, realVolumeUsd: 100000 }), /Insufficient volume/);
    assert.equal(memeEntryReason({ poolAgeMs, marketCapUsd: 10000, recentVolumeUsd: 1000, realVolumeUsd: 0 }), null);
  }
  for (const age of [0, 59000, 59999, 30 * 60000 + 1, 31 * 60000, 30 * 86400000 - 1]) assert.deepEqual(entryBand(age), ENTRY_BAND);
  for (const age of [60000, 180000, 300000, 360000, 29 * 60000, 30 * 60000]) assert.deepEqual(entryBand(age), [10000, 20000]);
  assert.deepEqual(entryBand(30 * 86400000), [10000, 20000]);
  for (const volume of [199, 999, 1000, 2000, 2001, 100000]) {
    for (const volumeFields of [{ realVolumeUsd: volume, volume24hUsd: 99999 }, { volume24hUsd: volume }]) {
      const reason = memeEntryReason({ poolAgeMs: 300000, marketCapUsd: 10000, ...volumeFields });
      if (volume < 1000) assert.match(reason, /Insufficient volume/);
      else assert.equal(reason, null);
    }
  }
  assert.equal(memeEntryReason({ poolAgeMs: 30 * 86400000, marketCapUsd: 20000, recentVolumeUsd: 2001 }), null);
});

test('entry band ceiling applies to all ages independently of the absolute hard ceiling', () => {
  const { memeEntryReason, entryBand, MAX_CAP_HARD_USD } = require('../core/risk/engine.cjs');
  assert.equal(MAX_CAP_HARD_USD, 10000000);
  assert.deepEqual(entryBand(45 * 86400000), [10000, 20000]);
  for (const poolAgeMs of [60000, 45 * 86400000]) for (const marketCapUsd of [20001, 25000, 30000, 10000000, 10000001, 50000000, 1000000000]) {
    assert.equal(memeEntryReason({ poolAgeMs, marketCapUsd, realVolumeUsd: 1500, recentVolumeUsd: 1500 }), 'Cap outside the $10000-$20000 entry band.');
  }
});

test('sweep drops 31-minute and old-band tokens before quoting; 29-minute token ages out', async t => {
  let clock = new Date('2026-10-04T00:00:00Z');
  const now = () => clock, runtime = createRuntime({ now });
  const births = { fresh: +clock - 29 * 60000, expired: +clock - 31 * 60000, oldBand: +clock - 45 * 86400000 };
  const quoted = [], watched = [], forgotten = [];
  const provider = { network: 'SOLANA', watched: () => Object.keys(births), discover: async () => Object.keys(births),
    profile: token => ({ born: births[token], band: token === 'oldBand', volume24hUsd: 100 }),
    forget: token => forgotten.push(token), watch: async token => { watched.push(token); return true; },
    quotes: async tokens => { quoted.push(...tokens); return tokens.map(token => ({ token, price: .001, liquidityUsd: 10, volume24hUsd: 1000,
      poolAgeMs: +clock - births[token], marketCapUsd: 10000, observedAt: now().toISOString(), source: 'fixture#pool-price',
      evidence: ['fixture'], confidence: .9, evidence_quality: .9, uncertainty: .1, missing_evidence: [] })); },
    snapshot: async () => { throw Error('No deep lookup expected'); } };
  const market = createMarketData({ runtime, now, providers: { SOLANA: provider } });
  t.after(async () => { market.stop(); await runtime.close(); });
  const first = await market.scan();
  assert.equal(first.total, 1); assert.deepEqual(quoted, ['fresh']);
  assert.deepEqual(runtime.snapshot().events.filter(e => e.type === 'MarketSnapshot').map(e => e.payload.token), ['fresh']);
  clock = new Date(+clock + 2 * 60000);
  assert.equal((await market.scan()).total, 0);
  assert.deepEqual(quoted, ['fresh']); assert.deepEqual(watched, []);
  assert.ok(['expired', 'oldBand', 'fresh'].every(token => forgotten.includes(token)));
});
