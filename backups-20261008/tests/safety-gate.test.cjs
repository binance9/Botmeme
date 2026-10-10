'use strict';
// Safety gate tests — hard fail-closed veto before any paper buy.
// Run: node --test tests/safety-gate.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('../runtime/events/bus.cjs');
const { createSafetyGate: createStrictSafetyGate } = require('../core/safety/gate.cjs');
// The existing cases explicitly exercise the unchanged paper policy.
const createSafetyGate = options => createStrictSafetyGate({ executionMode: () => 'paper', ...options });
const { normalizeReport } = require('../core/safety/rugcheck.cjs');

const goodReader = () => ({ network: 'SOLANA', async read() {
  return { mintAuthorityRevoked: true, freezeAuthorityRevoked: true, maxLpLockedPct: 85, top10HolderPct: 25, insiderHolderPct: 5, scoreNormalised: 10 };
} });

function snapshot(id, token, price) {
  const at = new Date().toISOString();
  return { id, type: 'MarketSnapshot', timestamp: at, producer: 'MARKET_DATA', source: 'test.scan', evidence: [], status: 'OBSERVED', correlationId: 'corr-' + id, network: 'SOLANA', epoch: 1, confidence: 0.9, evidence_quality: 0.9, missing_evidence: [], uncertainty: 0.1,
    payload: { token, price, liquidityUsd: 85000, volume24hUsd: 400000, observedAt: at, marketCapUsd: 15000, poolAgeMs: 20 * 60 * 1000, realVolumeUsd: 50000 } };
}
function candidate(id, snap) {
  return { id, type: 'TokenCandidate', timestamp: snap.timestamp, producer: 'JEV', source: 'test.hunter', evidence: [snap.id], status: 'OBSERVED', correlationId: snap.correlationId, network: snap.network, epoch: snap.epoch, confidence: 0.85, evidence_quality: 0.85, missing_evidence: [], uncertainty: 0.15,
    payload: { token: snap.payload.token, symbol: 'TKA', snapshotId: snap.id, liquidityUsd: snap.payload.liquidityUsd, volume24hUsd: snap.payload.volume24hUsd, rank: 1, anomalies: ['TOKEN_DISCOVERY'] } };
}
const safety = (runtime, candidateId) => runtime.snapshot().events.filter(e => e.type === 'SafetyDecision' && e.payload.candidateId === candidateId).at(-1);
const latestAction = (runtime, candidateId) => safety(runtime, candidateId)?.payload.approved;

for (const mode of ['live', 'safe']) {
  for (const result of ['verified', 'empty', 'null', 'outage', 'missing-lp', 'missing-holder', 'missing-score', 'nan', 'authority-active', 'no-reader']) {
    test(mode + ' fallback evidence: ' + result, async t => {
      const runtime = createRuntime({ now: () => new Date() });
      const snap = snapshot('live-snap', 'FRESHTOKEN', .001), cand = candidate('live-cand', snap);
      const { createFallbackSafetyReader } = require('../core/safety/rugcheck.cjs');
      let primaryCalls = 0, fallbackCalls = 0;
      const reader = createFallbackSafetyReader({
        primary: { async read(token, quote) { primaryCalls++; assert.equal(quote.id, snap.id); throw Error('RUGCHECK_HTTP_400'); } },
        fallback: { async read(token, quote) {
          fallbackCalls++; assert.equal(token, snap.payload.token); assert.equal(quote.id, snap.id);
          if (result === 'outage') throw Error('SOLANA_RPC_HTTP_429');
          if (result === 'empty') return {};
          if (result === 'null') return null;
          const meta = await goodReader().read();
          // RPC cannot compute a RugCheck score; explicit unknown is honest.
          meta.scoreNormalised = null; meta.insiderHolderPct = null;
          if (result === 'missing-lp') meta.maxLpLockedPct = null;
          if (result === 'missing-holder') delete meta.top10HolderPct;
          if (result === 'missing-score') delete meta.scoreNormalised;
          if (result === 'nan') meta.maxLpLockedPct = NaN;
          if (result === 'authority-active') meta.mintAuthorityRevoked = false;
          return meta;
        } }
      });
      const gate = createStrictSafetyGate({ runtime: { ...runtime, executionMode: () => mode }, readers: result === 'no-reader' ? {} : { SOLANA: reader } });
      t.after(async () => { gate.stop(); await runtime.close(); });
      runtime.publish(snap); runtime.publish(cand); gate.start(); await runtime.flush();
      const decision = safety(runtime, cand.id);
      assert.equal(decision.payload.approved, result === 'verified');
      assert.equal(decision.status, result === 'verified' ? 'APPROVED' : 'REJECTED');
      assert.equal(primaryCalls, result === 'no-reader' ? 0 : 1);
      assert.equal(fallbackCalls, primaryCalls);
      if (result === 'verified') {
        for (const [key, value] of Object.entries({ mintAuthorityRevoked: true, freezeAuthorityRevoked: true, maxLpLockedPct: 85, top10HolderPct: 25, scoreNormalised: null, insiderHolderPct: null })) assert.equal(decision.payload[key], value, key);
      }
    });
  }
}

test('unspecified execution mode fails closed and a paper-to-live change cannot publish an advisory approval', async t => {
  for (const switching of [false, true]) {
    const runtime = createRuntime({ now: () => new Date() });
    let calls = 0;
    const gate = createStrictSafetyGate({ runtime, ...(switching ? { executionMode: () => ++calls === 1 ? 'paper' : 'live' } : {}),
      readers: { SOLANA: { async read() { throw Error('RUGCHECK_HTTP_503'); } } } });
    t.after(async () => { gate.stop(); await runtime.close(); });
    const snap = snapshot('mode-snap', 'TOKEN', .001), cand = candidate('mode-cand', snap);
    runtime.publish(snap); runtime.publish(cand); gate.start(); await runtime.flush();
    assert.equal(safety(runtime, cand.id).payload.approved, false);
  }
});

test('production RPC fallback with unknown LP cannot approve live even with revoked authorities', async t => {
  const { createSolanaRpcSafetyReader, createFallbackSafetyReader } = require('../core/safety/rugcheck.cjs');
  const rpc = createSolanaRpcSafetyReader({ fetcher: async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const result = method === 'getAccountInfo' ? params[1].encoding === 'base64' ? { value: null } : { value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', executable: false, data: { parsed: { type: 'mint', info: { isInitialized: true, mintAuthority: null, freezeAuthority: null } } } } } :
      method === 'getTokenSupply' ? { value: { amount: '1000' } } : { value: [{ address: 'holder', amount: '100' }] };
    return { ok: true, json: async () => ({ result }) };
  } });
  const runtime = createRuntime({ now: () => new Date() });
  const gate = createStrictSafetyGate({ runtime, readers: { SOLANA: createFallbackSafetyReader({
    primary: { async read() { throw Error('RUGCHECK_HTTP_400'); } }, fallback: rpc
  }) } });
  t.after(async () => { gate.stop(); await runtime.close(); });
  const snap = snapshot('rpc-snap', 'So11111111111111111111111111111111111111112', .001), cand = candidate('rpc-cand', snap);
  runtime.publish(snap); runtime.publish(cand); gate.start(); await runtime.flush();
  assert.equal(safety(runtime, cand.id).payload.approved, false);
  assert.match(safety(runtime, cand.id).payload.reason, /evidence missing/);
  assert.equal(safety(runtime, cand.id).payload.top10HolderPct, 10);
});

function pumpRpcFixture(options = {}) {
  const { PublicKey } = require('@solana/web3.js');
  const { createHash } = require('node:crypto');
  const { createSolanaRpcSafetyReader } = require('../core/safety/rugcheck.cjs');
  const token = 'So11111111111111111111111111111111111111112'; // No suffix-based trust.
  const program = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
  const tokenProgram = new PublicKey(options.tokenProgram || 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const mint = new PublicKey(token);
  const curve = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mint.toBuffer()], program)[0];
  const vault = PublicKey.findProgramAddressSync([curve.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'))[0].toBase58();
  const bytes = Buffer.alloc(81);
  createHash('sha256').update('account:BondingCurve').digest().copy(bytes, 0, 0, 8);
  bytes[48] = options.complete || 0;
  if (options.badDiscriminator) bytes[0] ^= 255;
  const calls = [];
  const reader = createSolanaRpcSafetyReader({ fetcher: async (url, init) => {
    const { method, params } = JSON.parse(init.body); calls.push({ method, params });
    if (options.rpcError === method) return { ok: true, json: async () => ({ error: { code: -32000 } }) };
    let result;
    if (method === 'getAccountInfo' && params[0] === token) {
      assert.equal(params[1].encoding, 'jsonParsed');
      result = { value: { owner: tokenProgram.toBase58(), executable: false, data: { parsed: { type: 'mint', info: { isInitialized: true, mintAuthority: null, freezeAuthority: null, ...options.authorities } } } } };
    } else if (method === 'getAccountInfo') {
      assert.equal(params[0], curve.toBase58()); assert.equal(params[1].encoding, 'base64');
      result = { value: options.noCurve ? null : { owner: options.wrongOwner ? tokenProgram.toBase58() : program.toBase58(), executable: false, data: [(options.truncated ? bytes.subarray(0, 48) : bytes).toString('base64'), 'base64'] } };
    } else if (method === 'getTokenSupply') {
      result = { value: { amount: options.supply ?? '10000000000000000000', uiAmount: null } };
    } else {
      assert.equal(method, 'getTokenLargestAccounts');
      result = { value: options.rows ?? [{ address: vault, amount: '5000000000000000000', uiAmount: null }, { address: 'whale', amount: options.whale ?? '800000000000000000', uiAmount: null }] };
    }
    return { ok: true, json: async () => ({ result }) };
  } });
  return { reader, token, calls };
}

for (const mode of ['live', 'safe']) for (const [name, options, approved, pct] of [
  ['revoked authorities and 8%', {}, true, 8],
  ['token-2022 curve', { tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' }, true, 8],
  ['active mint authority', { authorities: { mintAuthority: 'dev' } }, false, 8],
  ['active freeze authority', { authorities: { freezeAuthority: 'dev' } }, false, 8],
  ['45% whale is not excluded', { whale: '4500000000000000000' }, false, 45],
  ['threshold boundary', { whale: '3000000000000000000' }, true, 30],
  ['over threshold', { whale: '3000000000001000000' }, false, 30.00000000001],
  ['migrated curve needs LP evidence', { complete: 1 }, false, 58],
  ['absent curve needs LP evidence', { noCurve: true }, false, 58],
  ['wrong program owner', { wrongOwner: true }, false],
  ['invalid discriminator', { badDiscriminator: true }, false],
  ['truncated curve', { truncated: true }, false],
  ['invalid complete bit', { complete: 2 }, false],
  ['missing authority', { authorities: { mintAuthority: undefined } }, false],
  ['RPC hard error', { rpcError: 'getTokenLargestAccounts' }, false],
  ['zero supply', { supply: '0' }, false],
  ['malformed holder', { rows: [{ address: 'whale', amount: 'bad' }] }, false],
  ['empty holders', { rows: [] }, false],
  ['inconsistent supply', { supply: '100' }, false]
]) test(mode + ' pump RPC fallback: ' + name, async t => {
  const { createFallbackSafetyReader } = require('../core/safety/rugcheck.cjs');
  const fixture = pumpRpcFixture(options);
  const runtime = createRuntime({ now: () => new Date() });
  const gate = createStrictSafetyGate({ runtime, executionMode: () => mode, readers: { SOLANA: createFallbackSafetyReader({
    primary: { async read() { throw Error('RUGCHECK_HTTP_400'); } }, fallback: fixture.reader
  }) } });
  t.after(async () => { gate.stop(); await runtime.close(); });
  const snap = snapshot('pump-snap', fixture.token, .001), cand = candidate('pump-cand', snap);
  // Untrusted discovery metadata must never hide the whale.
  snap.payload.poolAddress = 'whale';
  snap.payload.recentTxs5m = 10;
  snap.payload.recentVolumeUsd = 100;
  runtime.publish(snap); runtime.publish(cand); gate.start(); await runtime.flush();
  const decision = safety(runtime, cand.id);
  assert.ok(decision, 'gate must publish a decision');
  assert.equal(decision.status, approved ? 'APPROVED' : 'REJECTED', decision.payload.reason);
  assert.equal(decision.payload.approved, approved);
  if (pct !== undefined) {
    assert.equal(decision.payload.top10HolderPct, pct);
    assert.equal(decision.payload.mintAuthorityRevoked, !options.authorities?.mintAuthority);
    assert.equal(decision.payload.freezeAuthorityRevoked, !options.authorities?.freezeAuthority);
    assert.equal(decision.payload.maxLpLockedPct, null);
    assert.equal(decision.payload.lpStatus, options.complete || options.noCurve ? undefined : 'bonding-curve');
  }
});

test('RPC top10 uses raw amounts, sorts all rows and sums only ten holders', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ address: 'holder-' + i, amount: String((i + 1) * 100), uiAmount: 999999 }));
  const fixture = pumpRpcFixture({ rows, supply: '100000' });
  assert.equal((await fixture.reader.read(fixture.token)).top10HolderPct, 7.5);
});

for (const [name, changes, policy, approved] of [
  ['omitted LP accepted', { maxLpLockedPct: undefined }, {}, true],
  ['traditional LP floor inapplicable', {}, { minLpLockedPct: 90 }, true],
  ['configured holder ceiling enforced', {}, { maxTop10HolderPct: 5 }, false],
  ['NaN LP rejected', { maxLpLockedPct: NaN }, {}, false],
  ['missing holders rejected', { top10HolderPct: undefined }, {}, false]
]) test('pump gate evidence: ' + name, async t => {
  const fixture = pumpRpcFixture();
  const meta = { ...await fixture.reader.read(fixture.token), ...changes };
  const runtime = createRuntime({ now: () => new Date() });
  const gate = createStrictSafetyGate({ runtime, policy, readers: { SOLANA: { read: async () => meta } } });
  t.after(async () => { gate.stop(); await runtime.close(); });
  const snap = snapshot('evidence-snap', fixture.token, .001), cand = candidate('evidence-cand', snap);
  runtime.publish(snap); runtime.publish(cand); gate.start(); await runtime.flush();
  assert.equal(safety(runtime, cand.id).payload.approved, approved);
  if (approved) assert.equal(safety(runtime, cand.id).payload.maxLpLockedPct, null);
});

test('indexed RugCheck report remains primary without calling RPC', async t => {
  const { createFallbackSafetyReader } = require('../core/safety/rugcheck.cjs');
  const meta = normalizeReport({ token: { mintAuthority: null, freezeAuthority: null }, markets: [{ lp: { lpLockedPct: 85 } }], topHolders: [{ pct: 45 }], score_normalised: 10 });
  let fallbackCalls = 0;
  const reader = createFallbackSafetyReader({ primary: { read: async () => meta }, fallback: { read: async () => { fallbackCalls++; throw Error('UNEXPECTED_FALLBACK'); } } });
  assert.strictEqual(await reader.read('indexed'), meta);
  const runtime = createRuntime({ now: () => new Date() });
  const gate = createStrictSafetyGate({ runtime, readers: { SOLANA: reader } });
  t.after(async () => { gate.stop(); await runtime.close(); });
  const snap = snapshot('indexed-snap', 'INDEXED', .001), cand = candidate('indexed-cand', snap);
  runtime.publish(snap); runtime.publish(cand); gate.start(); await runtime.flush();
  assert.equal(safety(runtime, cand.id).payload.approved, true);
  for (const [key, value] of Object.entries(meta)) assert.equal(safety(runtime, cand.id).payload[key], value);
  assert.equal(fallbackCalls, 0);
});

test('gate approves a candidate whose on-chain metadata passes every hard rule', async () => {
  const runtime = createRuntime({ now: () => new Date() });
  const snap = snapshot('snap-ok', 'TOKENOK', 0.001), cand = candidate('cand-ok', snap);
  runtime.publish(snap); runtime.publish(cand);
  const gate = createSafetyGate({ runtime, readers: { SOLANA: goodReader() } });
  gate.start(); await runtime.flush();
  assert.equal(latestAction(runtime, cand.id), true, JSON.stringify(safety(runtime, cand.id)?.payload));
  const verdict = safety(runtime, cand.id);
  assert.ok(verdict.payload.checks.some(c => c.name === 'MINT_AUTHORITY_REVOKED' && c.passed));
  await gate.stop(); await runtime.close();
});

test('a network without an on-chain reader passes advisory-UNVERIFIED (paper mode), reader failure still rejects', async () => {
  const runtime = createRuntime({ now: () => new Date() });
  const snap = snapshot('snap-noReader', 'TOKENR', 0.001), cand = candidate('cand-noReader', snap);
  runtime.publish(snap); runtime.publish(cand);
  const gate = createSafetyGate({ runtime, readers: {} }); // no reader for SOLANA
  gate.start(); await runtime.flush();
  const verdict = safety(runtime, cand.id);
  assert.equal(verdict.payload.approved, true, 'paper-mode advisory pass: ' + verdict.payload.reason);
  assert.ok(verdict.payload.checks.some(c => c.name === 'ONCHAIN_METADATA' && /UNVERIFIED/.test(c.detail)));
  await gate.stop(); await runtime.close();
});

test('liquidity 0 (provider did not report) is unknown, not an empty pool', async () => {
  const runtime = createRuntime({ now: () => new Date() });
  const snap = snapshot('snap-zeroliq', 'TOKENZ', 0.001);
  snap.payload.liquidityUsd = 0;
  const cand = candidate('cand-zeroliq', snap); cand.payload.anomalies = [];
  runtime.publish(snap); runtime.publish(cand);
  const gate = createSafetyGate({ runtime, readers: { SOLANA: goodReader() } });
  gate.start(); await runtime.flush();
  const verdict = safety(runtime, cand.id);
  assert.equal(verdict.payload.approved, true, 'zero-liquidity data must not hard-reject: ' + verdict.payload.reason);
  assert.ok(verdict.payload.checks.some(c => c.name === 'LIQUIDITY_UNKNOWN' && c.passed));
  await gate.stop(); await runtime.close();
});

test('an availability outage is UNVERIFIED-advisory (paper mode); an opaque reader failure still rejects', async () => {
  const runtime = createRuntime({ now: () => new Date() });
  const snap = snapshot('snap-err', 'TOKENE', 0.001), cand = candidate('cand-err', snap);
  runtime.publish(snap); runtime.publish(cand);
  // Availability outage (HTTP 503): never reads as danger — advisory UNVERIFIED pass.
  const outage = createSafetyGate({ runtime, readers: { SOLANA: { network: 'SOLANA', async read() { throw Error('RUGCHECK_HTTP_503'); } } } });
  outage.start(); await runtime.flush();
  const approved = safety(runtime, cand.id);
  assert.equal(approved.payload.approved, true, 'outage is not a danger finding');
  assert.match(approved.payload.reason, /UNVERIFIED/);
  assert.ok(approved.payload.checks.some(c => c.name === 'ONCHAIN_METADATA' && c.passed && /UNVERIFIED/.test(c.detail)));
  await outage.stop(); await runtime.close();

  const runtime2 = createRuntime({ now: () => new Date() });
  const snap2 = snapshot('snap-err2', 'TOKENE2', 0.001), cand2 = candidate('cand-err2', snap2);
  runtime2.publish(snap2); runtime2.publish(cand2);
  const gate = createSafetyGate({ runtime: runtime2, readers: { SOLANA: { network: 'SOLANA', async read() { throw Error('SAFETY_READER_CORRUPTED'); } } } });
  gate.start(); await runtime2.flush();
  const verdict = safety(runtime2, cand2.id);
  assert.equal(verdict.payload.approved, false, 'opaque failure stays fail-closed');
  assert.match(verdict.payload.reason, /SAFETY_READER_CORRUPTED/);
  await gate.stop(); await runtime2.close();
});

test('entry safety has no age split for old pools', async () => {
  const runtime = createRuntime({ now: () => new Date() });
  const snap = snapshot('snap-old', 'TOKENO', 0.001);
  snap.payload.poolAgeMs = 90 * 24 * 60 * 60 * 1000; // 90 days old
  const cand = candidate('cand-old', snap);
  runtime.publish(snap); runtime.publish(cand);
  const gate = createSafetyGate({ runtime, readers: { SOLANA: goodReader() } });
  gate.start(); await runtime.flush();
  const verdict = safety(runtime, cand.id);
  assert.equal(verdict.payload.approved, true, 'old token passes the shared band: ' + verdict.payload.reason);
  assert.ok(verdict.payload.checks.some(c => c.name === 'POOL_AGE' && c.passed));
  await gate.stop(); await runtime.close();
});

for (const poolAgeMs of [0, 59000, 30 * 60000, 45 * 86400000]) test('safety shares cap band at age ' + poolAgeMs, async t => {
  const runtime = createRuntime({ now: () => new Date() });
  const gate = createSafetyGate({ runtime, readers: { SOLANA: goodReader() } });
  t.after(async () => { gate.stop(); await runtime.close(); });
  gate.start();
  for (const cap of [9999, 10000, 20000, 20001, 25000, 30000, 30001, 10000000, 10000001, 50000000, 1000000000]) {
    const snap = snapshot('cap-' + cap, 'TOKEN' + cap, .001);
    Object.assign(snap.payload, { poolAgeMs, marketCapUsd: cap, liquidityUsd: 50 });
    const cand = candidate('cand-' + cap, snap);
    runtime.publish(snap); runtime.publish(cand); await runtime.flush();
    assert.equal(safety(runtime, cand.id).payload.approved, cap >= 10000 && cap <= 20000);
  }
});

test('fallback reader promotes RPC-verified metadata when RugCheck has no data for a new pool', async () => {
  const runtime = createRuntime({ now: () => new Date() });
  const snap = snapshot('snap-fb', 'TOKENF', 0.001), cand = candidate('cand-fb', snap);
  runtime.publish(snap); runtime.publish(cand);
  const { createFallbackSafetyReader } = require('../core/safety/rugcheck.cjs');
  const chain = createFallbackSafetyReader({
    primary: { network: 'SOLANA', async read() { throw Error('RUGCHECK_HTTP_400'); } },
    fallback: { network: 'SOLANA', async read() { return { mintAuthorityRevoked: true, freezeAuthorityRevoked: true, maxLpLockedPct: null, top10HolderPct: 22, insiderHolderPct: null, scoreNormalised: null }; } }
  });
  const gate = createSafetyGate({ runtime, readers: { SOLANA: chain } });
  gate.start(); await runtime.flush();
  const verdict = safety(runtime, cand.id);
  assert.equal(verdict.payload.approved, true, 'RPC fallback proves mint/freeze revoked and top10 sane; LP/insider unknown is not a veto');
  assert.ok(verdict.payload.checks.some(c => c.name === 'LP_LOCKED_FLOOR' && c.passed && c.detail === 'lpLockedPct=null'));
  await gate.stop(); await runtime.close();
});

test('fallback chain outage records UNVERIFIED-advisory in paper mode', async () => {
  const runtime = createRuntime({ now: () => new Date() });
  const snap = snapshot('snap-fb2', 'TOKENG', 0.001), cand = candidate('cand-fb2', snap);
  runtime.publish(snap); runtime.publish(cand);
  const { createFallbackSafetyReader } = require('../core/safety/rugcheck.cjs');
  const chain = createFallbackSafetyReader({
    primary: { network: 'SOLANA', async read() { throw Error('RUGCHECK_HTTP_400'); } },
    fallback: { network: 'SOLANA', async read() { throw Error('SOLANA_RPC_HTTP_429'); } }
  });
  const gate = createSafetyGate({ runtime, readers: { SOLANA: chain } });
  gate.start(); await runtime.flush();
  const verdict = safety(runtime, cand.id);
  assert.equal(verdict.payload.approved, true, 'an outage chain is advisory-UNVERIFIED, not danger: ' + verdict.payload.reason);
  assert.match(verdict.payload.reason, /UNVERIFIED/);
  await gate.stop(); await runtime.close();
});

test('gate rejects honeypot-like metadata (mint authority kept, LP unlocked, holders concentrated)', async () => {
  const runtime = createRuntime({ now: () => new Date() });
  const snap = snapshot('snap-honeypot', 'TOKENH', 0.001), cand = candidate('cand-honeypot', snap);
  runtime.publish(snap); runtime.publish(cand);
  const badReader = { network: 'SOLANA', async read() {
    return { mintAuthorityRevoked: false, freezeAuthorityRevoked: true, maxLpLockedPct: 5, top10HolderPct: 88, insiderHolderPct: 40, scoreNormalised: 95 };
  } };
  const gate = createSafetyGate({ runtime, readers: { SOLANA: badReader } });
  gate.start(); await runtime.flush();
  const verdict = safety(runtime, cand.id);
  assert.equal(verdict.payload.approved, false);
  for (const name of ['MINT_AUTHORITY_REVOKED']) {
    assert.ok(verdict.payload.checks.some(c => c.name === name && !c.passed), 'missing failed check ' + name);
  }
  await gate.stop(); await runtime.close();
});

test('gate retains liquidity floor for non-discovery candidates', async () => {
  const runtime = createRuntime({ now: () => new Date() });
  const snap = snapshot('snap-liq', 'TOKENL', 0.001);
  snap.payload.liquidityUsd = 300; // below the $500 floor
  const cand = candidate('cand-liq', snap); cand.payload.anomalies = [];
  runtime.publish(snap); runtime.publish(cand);
  const gate = createSafetyGate({ runtime, readers: { SOLANA: goodReader() } });
  gate.start(); await runtime.flush();
  const verdict = safety(runtime, cand.id);
  assert.equal(verdict.payload.approved, false);
  assert.match(verdict.payload.reason, /liquidity below floor/);
  await gate.stop(); await runtime.close();
});

test('a Jev REJECT supersedes an earlier approval (paper reads the latest verdict)', async () => {
  const runtime = createRuntime({ now: () => new Date() });
  const snap = snapshot('snap-jev', 'TOKENJ', 0.001), cand = candidate('cand-jev', snap);
  runtime.publish(snap); runtime.publish(cand);
  const gate = createSafetyGate({ runtime, readers: { SOLANA: goodReader() } });
  gate.start(); await runtime.flush();
  assert.equal(latestAction(runtime, cand.id), true);
  const at = new Date().toISOString();
  runtime.publish({ id: 'jev-v-1', type: 'JevVerdict', timestamp: at, producer: 'JEV', source: 'test', evidence: [cand.id], status: 'COMPLETED', correlationId: cand.correlationId, network: 'SOLANA', epoch: 1, confidence: 0.99, evidence_quality: 0.9, missing_evidence: [], uncertainty: 0.1,
    payload: { candidateId: cand.id, action: 'REJECT', confidence: 0.99, tradableProbability: 0.05, momentum: 0, model: 'jev-1.13.0', latencyMs: 900, violations: [] } });
  await runtime.flush();
  assert.equal(latestAction(runtime, cand.id), false);
  assert.match(safety(runtime, cand.id).payload.reason, /Jev verdict REJECT/);
  await gate.stop(); await runtime.close();
});

test('a candidate rejected under the liquidity floor is re-screened on a fresh snapshot', async () => {
  const runtime = createRuntime({ now: () => new Date() });
  const snap = snapshot('snap-rescreen', 'TOKENRS', 0.001);
  snap.payload.liquidityUsd = 300; // below the floor at discovery time
  const cand = candidate('cand-rescreen', snap); cand.payload.anomalies = [];
  runtime.publish(snap); runtime.publish(cand);
  const gate = createSafetyGate({ runtime, readers: { SOLANA: goodReader() } });
  gate.start();
  await runtime.flush();
  assert.equal(safety(runtime, cand.id).payload.approved, false);
  // Liquidity improves: the next snapshot for the same token must re-screen it.
  const better = snapshot('snap-rescreen-2', 'TOKENRS', 0.0012);
  better.payload.liquidityUsd = 15000;
  better.correlationId = 'corr-better';
  runtime.publish(better);
  await runtime.flush();
  const latest = safety(runtime, cand.id);
  assert.equal(latest.payload.approved, true, 're-screen approved: ' + latest.payload.reason);
  assert.ok(latest.timestamp >= better.timestamp, 'rescreen verdict is not future-traced');
  await gate.stop(); await runtime.close();
});

test('rugcheck normalizer maps the live report contract and refuses unparsable data', () => {
  const mapped = normalizeReport({
    token: { mintAuthority: null, freezeAuthority: null, decimals: 5, isInitialized: true, supply: '1' },
    markets: [{ lp: { lpLockedPct: 12.5 } }, { lp: { lpLockedPct: 90 } }],
    topHolders: [{ pct: 9, insider: false }, { pct: 3.3, insider: true }],
    score: 101, score_normalised: 7
  });
  assert.deepEqual([mapped.mintAuthorityRevoked, mapped.freezeAuthorityRevoked, mapped.maxLpLockedPct, Math.round(mapped.top10HolderPct * 10) / 10, mapped.insiderHolderPct, mapped.scoreNormalised],
    [true, true, 90, 12.3, 3.3, 7]);
  assert.throws(() => normalizeReport({ token: { mintAuthority: 5, freezeAuthority: null } }), /RUGCHECK_UNPARSABLE_MINT_AUTHORITY/);
  assert.throws(() => normalizeReport({ token: { mintAuthority: null, freezeAuthority: null } }), /RUGCHECK_UNPARSABLE_LIQUIDITY/);
});

test('a safety API outage approves advisory-UNVERIFIED on the first screen without retries',async()=>{
 let clock=new Date(),calls=0;const runtime=createRuntime({now:()=>clock});
 const gate=createSafetyGate({runtime,now:()=>clock,readers:{SOLANA:{async read(){calls++;throw Error('RUGCHECK_HTTP_503');}}}});
 try{gate.start();let snap=snapshot('outage-first','OUTAGE',.001);snap.timestamp=clock.toISOString();snap.payload.observedAt=snap.timestamp;runtime.publish(snap);const cand=candidate('outage-candidate',snap);runtime.publish(cand);await runtime.flush();
 assert.equal(calls,1);assert.equal(latestAction(runtime,cand.id),true,'outage approves as UNVERIFIED-advisory');
 clock=new Date(clock.getTime()+40000);let quote=snapshot('outage-next','OUTAGE',.0011);quote.timestamp=clock.toISOString();quote.payload.observedAt=quote.timestamp;runtime.publish(quote);await runtime.flush();
 assert.equal(calls,1,'an approved candidate is not re-screened');
 }finally{gate.stop();await runtime.close();}
});
