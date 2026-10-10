'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { PublicKey } = require('@solana/web3.js');
const { createTokenIdentityStore, decodeMetadata, PROGRAM } = require('../core/market-data/token-identity.cjs');
const mint = 'So11111111111111111111111111111111111111112';
function account() {
  const head = Buffer.alloc(65); head[0] = 4; new PublicKey(mint).toBuffer().copy(head, 33);
  const strings = ['Fresh Pump\0', 'FRESH\0', 'https://ipfs.io/ipfs/metadata'].map(value => { const data = Buffer.from(value), size = Buffer.alloc(4); size.writeUInt32LE(data.length); return Buffer.concat([size, data]); });
  return { owner: PROGRAM.toBase58(), data: [Buffer.concat([head, ...strings]).toString('base64'), 'base64'] };
}
test('Metaplex decoder rejects wrong owner, mint and truncated strings', () => {
  assert.equal(decodeMetadata(account(), mint).tokenSymbol, 'FRESH');
  assert.deepEqual(decodeMetadata({ ...account(), owner: mint }, mint), {});
  assert.deepEqual(decodeMetadata(account(), PublicKey.default.toBase58()), {});
  const broken = account(); broken.data[0] = Buffer.from(broken.data[0], 'base64').subarray(0, 70).toString('base64');
  assert.throws(() => decodeMetadata(broken, mint), /METADATA_LENGTH/);
});
test('fresh unindexed pump identity is cached and renders in positions, history and discoveries', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pump-identity-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'identities.json'), calls = [], image = 'https://cf.mirror.world/token.png';
  const identities = createTokenIdentityStore({ filename, fetcher: async (url, options) => {
    calls.push(String(url));
    if (String(url).includes('frontend-api.pump.fun/coins/')) return Response.json({ mint, name: 'Pump API Name', symbol: 'PUMP', image_uri: image, twitter: 'https://x.com/fresh' });
    const body = JSON.parse(options.body);
    assert.equal(body.method, 'getAccountInfo');
    assert.equal(body.params[0], PublicKey.findProgramAddressSync([Buffer.from('metadata'), PROGRAM.toBuffer(), new PublicKey(mint).toBuffer()], PROGRAM)[0].toBase58());
    return Response.json({ result: { value: account() } });
  } }); t.after(() => identities.close());
  await Promise.all([identities.resolve('SOLANA', mint), identities.resolve('SOLANA', mint)]);
  assert.equal(calls.length, 2);
  await identities.resolve('SOLANA', mint); assert.equal(calls.length, 2);
  assert.equal(identities.get('SOLANA', mint).uri, 'https://ipfs.io/ipfs/metadata');
  const restored = createTokenIdentityStore({ filename }); t.after(() => restored.close());
  assert.deepEqual(restored.get('SOLANA', mint), identities.get('SOLANA', mint));
  const at = '2026-10-05T10:00:00.000Z';
  const runtime = { snapshot: () => ({ events: [], network: 'SOLANA', epoch: 1, revision: 1 }), subscribe: () => () => {} };
  const trade = { id: 'buy', cycleId: 'cycle', mode: 'live', network: 'SOLANA', token: mint, timestamp: at, side: 'BUY', state: 'OPEN', positionState: 'OPEN', quantity: 2, entryPrice: 2, exitPrice: null, realizedPnl: 0, realizedReturn: null };
  const ledger = { snapshot: () => ({ positions: [{ network: 'SOLANA', token: mint, quantity: 1, averageCost: 2, costBasis: 2, markPrice: null }], trades: [trade, { ...trade, id: 'sell', side: 'SELL', quantity: 1, allocatedCostBasis: 2, exitPrice: 2 }], performance: { capitalUsed: 2, realizedPnl: 0, unrealizedPnl: 0 } }) };
  const adapter = require('../dashboard/adapter/index.cjs').createDashboardAdapter({ runtime, tradeStore: ledger, now: () => new Date(at), tokenIdentities: identities, newlyCreated: () => [{ network: 'SOLANA', token: mint, symbol: mint, observedAt: at }] }); t.after(() => adapter.close());
  const snapshot = adapter.snapshot();
  for (const row of [...snapshot.trades, ...snapshot.discoveries, ...snapshot.paperWallet.holdings]) { assert.equal(row.symbol, 'FRESH'); assert.equal(row.image, image); }
  assert.equal(snapshot.trades[0].name, 'Fresh Pump');
  assert.equal(snapshot.trades[0].liquidityUsd, null);
  const nodes = new Map(), $ = selector => { if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', textContent: '' }); return nodes.get(selector); };
  const source = fs.readFileSync(require.resolve('../public/meme-trader/app.js'), 'utf8');
  const context = vm.createContext({ snapshot, $, window: { MemeTradeView: require('../public/meme-trader/app.js') }, pendingExits: new Set(), pendingEntries: new Set(), manualControlsEnabled: () => true, coinName: x => x, esc: x => String(x ?? ''), networkLabel: x => x, compactUsd: () => '—', tokenAge: () => '1m', money: String, time: String });
  vm.runInContext(source.slice(source.indexOf('  function renderTrades()'), source.indexOf('  function tradeTab(')) + '\nrenderTrades();', context);
  assert.match($('#trade-rows').innerHTML, /FRESH/);
  assert.match($('#trade-rows').innerHTML, /title="Fresh Pump"/);
  assert.ok($('#trade-rows').innerHTML.includes('/api/asset-image?u=' + encodeURIComponent(image)));
});
test('pump API works without Metaplex; Dex identity fills missing fields and failed lookup retries', async () => {
  let clock = 0, calls = 0, available = false;
  const store = createTokenIdentityStore({ now: () => clock, fetcher: async url => { calls++; if (!available) throw Error('offline'); return Response.json(String(url).includes('pump.fun') ? { mint, name: 'API only', symbol: 'API', image_uri: 'https://ipfs.io/ipfs/avatar' } : { result: { value: null } }); } });
  await store.resolve('SOLANA', mint); assert.deepEqual(store.get('SOLANA', mint), {});
  await store.resolve('SOLANA', mint); assert.equal(calls, 2);
  available = true; clock = 60001; await store.resolve('SOLANA', mint);
  assert.equal(store.get('SOLANA', mint).tokenSymbol, 'API');
  store.put('SOLANA', mint, { tokenSymbol: 'DEX', tokenName: 'Dex', imageUrl: 'https://cdn.dexscreener.com/a' });
  assert.equal(store.get('SOLANA', mint).tokenSymbol, 'API');
  store.put('SOLANA', 'dex-token', { tokenSymbol: 'DEX', tokenName: 'Dex', imageUrl: 'https://cdn.dexscreener.com/a' });
  assert.equal(store.get('SOLANA', 'dex-token').tokenName, 'Dex'); store.close();
});

test('application persists fallback quote identity independently of dashboard reads', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-identity-'));
  const now = () => new Date('2026-10-05T10:00:00.000Z');
  const app = require('../runtime/application.cjs').createApplication({ journalPath: path.join(dir, 'events.jsonl'), now, providers: {}, liveConfig: { root: dir, env: {} } });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  app.runtime.publish({ id: 'fallback-quote', type: 'MarketSnapshot', timestamp: now().toISOString(), producer: 'MARKET_DATA', source: 'https://api.dexscreener.com/latest/dex/tokens#dexscreener-fallback', evidence: ['quote-receipt'], status: 'OBSERVED', correlationId: 'quote', network: 'SOLANA', epoch: 1, confidence: .8, evidence_quality: .8, uncertainty: .2, missing_evidence: [], payload: { token: mint, price: 1, liquidityUsd: 0, volume24hUsd: 0, observedAt: now().toISOString(), tokenSymbol: 'DEX', tokenName: 'Dex Token', imageUrl: 'https://cdn.dexscreener.com/token.png' } });
  await app.runtime.flush();
  assert.equal(app.tokenIdentities.get('SOLANA', mint).tokenSymbol, 'DEX');
  const restored = createTokenIdentityStore({ filename: path.join(dir, 'token-identities.json') });
  assert.equal(restored.get('SOLANA', mint).imageUrl, 'https://cdn.dexscreener.com/token.png'); restored.close();
});
