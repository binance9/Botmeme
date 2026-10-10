'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createRuntime } = require('../runtime/events/bus.cjs');
const { createOnchainDiscovery } = require('../services/discovery-onchain/service.cjs');
const { createHunter } = require('../services/jev/hunter.cjs');
const chain = require('../services/discovery-onchain/chain.cjs');
function b58(bytes) {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex')), text = '';
  while (n) { text = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[Number(n % 58n)] + text; n /= 58n; }
  return text;
}
function transaction(token = 'mint-1') {
  return { meta: { err: null }, transaction: { message: { instructions: [{ programId: chain.PUMP,
    accounts: [token, 'authority', 'curve', 'vault', 'global'], data: b58(createHash('sha256').update('global:create').digest().subarray(0, 8)) }] } } };
}
function fixture(t, overrides = {}) {
  let clock = Date.parse('2026-10-02T00:00:00.000Z');
  const now = () => new Date(clock), runtime = createRuntime({ now }), sessions = [], delays = [];
  const env = overrides.env ?? {};
  const producer = createOnchainDiscovery({ runtime, now, env, key: x => x,
    connector: options => {
      const session = { options, handlers: new Map(), disposed: false, rpc: {
        onLogs(program, fn) { session.handlers.set(program, fn); return session.handlers.size; },
        getParsedTransaction: async () => transaction()
      }, dispose() { session.disposed = true; } };
      sessions.push(session); return session;
    },
    prefilter: async () => ({ top10Pct: 10 }), quoteReader: async () => ({ price: 0.001, liquidityUsd: 1000, marketCapUsd: 10000 }),
    timers: { setTimeout(fn, delay) { const timer = { fn, delay }; delays.push(timer); return timer; }, clearTimeout(timer) { if (timer) timer.cancelled = true; } },
    ...overrides });
  t.after(async () => { producer.stop(); await producer.flush(); await runtime.close(); });
  producer.start();
  return { runtime, producer, sessions, delays, advance(ms) { clock += ms; },
    async emit(signature = 'signature-1', program = chain.PUMP, logs = ['Program log: Instruction: Create']) {
      sessions.at(-1).handlers.get(program)({ signature, logs, err: null }); await producer.flush(); await runtime.flush();
    }, events(type) { return runtime.snapshot().events.filter(e => e.type === type); } };
}
test('Create publishes schema-valid snapshot then candidate; hunter does not duplicate uncertain initial quote', async t => {
  const f = fixture(t), hunter = createHunter({ runtime: f.runtime }); hunter.start(); t.after(() => hunter.stop());
  await f.emit();
  const candidate = f.events('TokenCandidate')[0], snapshot = f.events('MarketSnapshot')[0];
  assert.equal(candidate.payload.snapshotId, snapshot.id);
  assert.equal(candidate.payload.discoverySource, 'onchain-ws');
  assert.deepEqual(candidate.payload.anomalies, ['TOKEN_DISCOVERY', 'ONCHAIN_CREATE']);
  assert.equal(snapshot.payload.poolAgeMs, 0); assert.equal(f.events('TokenCandidate').length, 1);
  assert.equal(f.events('SignalObservation')[0].payload.candidateId, candidate.id);
  assert.equal(f.sessions[0].handlers.size, 2);
});
test('authority veto produces audit and never publishes candidate or snapshot', async t => {
  const f = fixture(t, { prefilter: (rpc, item, limit) => chain.filter(rpc, item, limit, { publicKey: v => v }) });
  f.sessions[0].rpc.getParsedAccountInfo = async () => ({ value: { owner: chain.TOKEN, data: { parsed: { type: 'mint', info: { isInitialized: true, mintAuthority: 'creator', freezeAuthority: null } } } } });
  await f.emit();
  assert.equal(f.events('TokenCandidate').length, 0); assert.equal(f.events('MarketSnapshot').length, 0);
  assert.equal(f.events('AIActivityEvent')[0].payload.message, 'MINT_AUTHORITY_ACTIVE');
  assert.equal(f.events('AIActivityEvent')[0].payload.agent, 'MARKET_DATA');
});
test('dedup across signatures and stop/start', async t => {
  const f = fixture(t); await f.emit(); await f.emit('signature-2'); f.producer.stop(); f.producer.start(); await f.emit('signature-3');
  assert.equal(f.events('TokenCandidate').length, 1);
});
test('rolling hourly cap releases after one hour', async t => {
  const f = fixture(t, { env: { ONCHAIN_MAX_CANDIDATES_PER_HOUR: '1' } }); await f.emit();
  f.sessions[0].rpc.getParsedTransaction = async () => transaction('mint-2'); await f.emit('signature-2');
  assert.equal(f.events('TokenCandidate').length, 1); f.advance(3600001); await f.emit('signature-3');
  assert.equal(f.events('TokenCandidate').length, 2);
});
test('WebSocket faults back off, resubscribe, and stop cancels reconnect', async t => {
  const f = fixture(t); f.sessions[0].options.onFault(Error('disconnect'));
  assert.equal(f.sessions[0].disposed, true); assert.equal(f.delays[0].delay, 1000);
  f.delays[0].fn(); assert.equal(f.sessions[1].handlers.size, 2);
  f.sessions[1].options.onFault(Error('disconnect')); assert.equal(f.delays[1].delay, 2000);
  f.delays[1].fn(); await f.emit(); assert.equal(f.events('TokenCandidate').length, 1);
  f.sessions[2].options.onFault(Error('disconnect')); f.producer.stop();
  assert.equal(f.delays.at(-1).cancelled, true); f.delays.at(-1).fn(); assert.equal(f.sessions.length, 3);
});
for (const error of [Error('Unexpected server response: 429'), { status: 429 }, { statusCode: 429 }, { code: 429 }, { response: { status: 429 } }]) test('WebSocket 429 waits at least 60s and ignores duplicate callbacks: ' + String(error.message ?? JSON.stringify(error)), t => {
  const f = fixture(t), old = f.sessions[0];
  old.options.onFault(error); old.options.onFault(1006);
  assert.equal(old.disposed, true); assert.equal(f.delays.length, 1); assert.ok(f.delays[0].delay >= 60000);
  assert.equal(f.sessions.length, 1);
  f.delays[0].fn(); assert.equal(f.sessions.length, 2);
  f.sessions[1].options.onFault(error); assert.ok(f.delays[1].delay >= 60000);
  f.producer.stop(); assert.equal(f.delays[1].cancelled, true);
});

test('WebSocket close reason and connector exceptions preserve 429 backoff', t => {
  const f = fixture(t); f.sessions[0].options.onFault(1008, Buffer.from('429 Too Many Requests'));
  assert.ok(f.delays[0].delay >= 60000);
  const g = fixture(t, { connector() { throw Object.assign(Error('limited'), { status: 429 }); } });
  assert.ok(g.delays[0].delay >= 60000);
});

test('SDK reconnect is disabled so the service owns reconnect timing', () => {
  const transport = chain.connect({ httpEndpoint: 'http://127.0.0.1:1', wsEndpoint: 'ws://127.0.0.1:1', onFault() {} });
  try { assert.equal(transport.rpc._rpcWebSocket.reconnect, false); }
  finally { transport.dispose([]); }
});

test('real WS HTTP 429 handshake schedules 60s service retry without SDK hammering', async t => {
  const http = require('node:http');
  let upgrades = 0;
  const server = http.createServer();
  server.on('upgrade', (request, socket) => { upgrades++; socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  t.mock.method(console, 'error', () => {});
  const f = fixture(t, { connector: chain.connect, key: chain.key, env: { RPC_HTTP_ENDPOINT: 'http://127.0.0.1:' + server.address().port, RPC_WEBSOCKET_ENDPOINT: 'ws://127.0.0.1:' + server.address().port } });
  for (const deadline = Date.now() + 2000; !f.delays.length && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.delays.length, 1); assert.ok(f.delays[0].delay >= 60000);
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(upgrades, 1); assert.equal(f.delays.length, 1);
});

test('stop discards in-flight RPC result', async t => {
  const f = fixture(t); let complete;
  f.sessions[0].rpc.getParsedTransaction = () => new Promise(resolve => { complete = resolve; });
  const done = f.emit(); f.producer.stop(); complete(transaction()); await done;
  assert.equal(f.events('TokenCandidate').length, 0);
});
test('RPC errors are contained and credentials never reach audit', async t => {
  const f = fixture(t); f.sessions[0].rpc.getParsedTransaction = async () => { throw Error('https://rpc/?api-key=secret'); };
  await f.emit(); assert.equal(f.events('AIActivityEvent')[0].payload.message, 'ONCHAIN_RPC_UNAVAILABLE');
});
test('Raydium initialize2 extracts non-SOL mint including inner instructions', async t => {
  const f = fixture(t), accounts = Array.from({ length: 21 }, (_, i) => 'account-' + i);
  accounts[8] = 'ray-mint'; accounts[9] = chain.SOL;
  const data = Buffer.alloc(26); data[0] = 1;
  f.sessions[0].rpc.getParsedTransaction = async () => ({ meta: { err: null, innerInstructions: [{ instructions: [{ programId: chain.RAYDIUM, accounts, data: b58(data) }] }] }, transaction: { message: { instructions: [] } } });
  await f.emit('ray-signature', chain.RAYDIUM, ['Program log: initialize2']);
  assert.equal(f.events('TokenCandidate')[0].payload.token, 'ray-mint');
});
test('unrelated instructions and failed transactions cannot masquerade as Create', async t => {
  const f = fixture(t); f.sessions[0].rpc.getParsedTransaction = async () => { const tx = transaction(); tx.transaction.message.instructions[0].data = '11111111'; return tx; };
  await f.emit(); assert.equal(f.events('TokenCandidate').length, 0);
  assert.equal(f.events('AIActivityEvent')[0].payload.message, 'UNSUPPORTED_CREATE_INSTRUCTION');
});
test('missing quote fails closed without fabricated price', async t => {
  const f = fixture(t, { quoteReader: async () => { throw Error('USD_QUOTE_UNAVAILABLE'); } }); await f.emit();
  assert.equal(f.events('TokenCandidate').length, 0); assert.equal(f.events('AIActivityEvent')[0].payload.message, 'USD_QUOTE_UNAVAILABLE');
});
test('real prefilter reads mint RPC and blocks mint/freeze authority and concentration', async () => {
  const info = { isInitialized: true, decimals: 6, mintAuthority: null, freezeAuthority: null };
  let amount = '100';
  const rpc = {
    getParsedAccountInfo: async address => ({ value: { owner: chain.TOKEN, data: { parsed: address === 'mint' ? { type: 'mint', info } : { type: 'account', info: { mint: 'mint', owner: 'curve' } } } } }),
    getTokenSupply: async () => ({ value: { amount: '1000', decimals: 6 } }),
    getTokenLargestAccounts: async () => ({ value: [{ address: 'vault', amount: '800' }, { address: 'holder', amount }] })
  };
  const check = () => chain.filter(rpc, { token: 'mint', vault: 'vault', pool: 'curve', program: chain.PUMP }, 30, { publicKey: value => value });
  assert.equal((await check()).top10Pct, 10);
  info.mintAuthority = 'creator'; await assert.rejects(check, /MINT_AUTHORITY_ACTIVE/); info.mintAuthority = null;
  info.freezeAuthority = 'creator'; await assert.rejects(check, /FREEZE_AUTHORITY_ACTIVE/); info.freezeAuthority = null;
  amount = '301'; await assert.rejects(check, /TOP10_CONCENTRATION/);
  amount = '300'; assert.equal((await check()).top10Pct, 30);
  rpc.getTokenSupply = async () => ({ value: { amount: '0', decimals: 6 } }); await assert.rejects(check, /SUPPLY_UNVERIFIED/);
});
test('prefilter sums ten largest accounts with bigint precision and excludes only verified vault', async () => {
  const total = 100000000000000000000n;
  const rpc = {
    getParsedAccountInfo: async address => ({ value: { owner: chain.TOKEN, data: { parsed: address === 'mint' ? { type: 'mint', info: { isInitialized: true, decimals: 6, mintAuthority: null, freezeAuthority: null } } : { type: 'account', info: { mint: 'mint', owner: 'curve' } } } } }),
    getTokenSupply: async () => ({ value: { amount: String(total), decimals: 6 } }),
    getTokenLargestAccounts: async () => ({ value: [{ address: 'vault', amount: String(total / 2n) }, ...Array.from({ length: 12 }, (_, i) => ({ address: 'holder' + i, amount: String(total / 25n) }))] })
  };
  await assert.rejects(() => chain.filter(rpc, { token: 'mint', vault: 'vault', pool: 'curve', program: chain.PUMP }, 30, { publicKey: v => v }), /TOP10_CONCENTRATION/);
});
