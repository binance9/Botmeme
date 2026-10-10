'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createApplication } = require('../runtime/application.cjs');

// Isolated live root: the operator's real wallet-key.env / live-state.json must
// never leak hasKey, mode or reconciliation events into control assertions.
const roots = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
const isolatedRoot = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botmeme-appctl-')); roots.push(root); return { root }; };

test('application is stopped and cannot acquire market data before wallet connection', async () => {
  let calls = 0;
  const app = createApplication({ capitalUsd: 10000, providers: { SOLANA: { network: 'SOLANA', discover() { calls++; return []; }, snapshot() { throw Error('UNEXPECTED'); } } }, liveConfig: isolatedRoot() });
  try {
    assert.equal(app.control().running, false);
    assert.equal(app.control().mode, 'paper');
    assert.equal(app.control().wallet.connected, false);
    await assert.rejects(app.start(), /WALLET_CONNECTION_REQUIRED/);
    assert.equal(calls, 0);
    assert.equal(app.runtime.snapshot().events.length, 0);
  } finally { await app.close(); }
});

test('network changes are serialized, epoch-scoped and leave automation stopped', async () => {
  const app = createApplication({ capitalUsd: 10000, providers: {}, liveConfig: isolatedRoot() });
  try {
    const states = await Promise.all([app.selectNetwork('BSC'), app.selectNetwork('ROBINHOOD')]);
    assert.equal(states[0].network, 'BSC'); assert.equal(states[0].epoch, 2);
    assert.equal(states[1].network, 'ROBINHOOD'); assert.equal(states[1].epoch, 3);
    assert.equal(states[1].wallet.connected, false); assert.equal(states[1].running, false);
    await assert.rejects(app.selectNetwork('UNKNOWN'));
    assert.equal(app.control().network, 'ROBINHOOD'); assert.equal(app.control().epoch, 3);
    assert.equal((await app.stop()).running, false);
  } finally { await app.close(); }
});

test('invalid public wallet metadata cannot start automation or survive validation', async () => {
  const app = createApplication({ capitalUsd: 10000, providers: {}, liveConfig: isolatedRoot() });
  try {
    await assert.rejects(app.connect({ network: 'SOLANA', address: 'invalid', chainId: 'mainnet-beta', provider: 'phantom' }));
    assert.equal(app.control().wallet.connected, false);
    await assert.rejects(app.start(), /WALLET_CONNECTION_REQUIRED/);
    assert.equal((await app.disconnect()).running, false);
  } finally { await app.close(); }
});

test('wallet change follows verified network metadata atomically without starting a stopped bot', async () => {
  const app = createApplication({ capitalUsd: 10000, providers: {}, liveConfig: isolatedRoot() });
  const session = { network: 'ETHEREUM', address: '0x' + '1'.repeat(40), chainId: 1, provider: 'okx' };
  try {
    await assert.rejects(app.followWallet(session), /WALLET_CONNECTION_REQUIRED/);
    await app.selectNetwork('ETHEREUM'); await app.connect(session);
    const before = app.control().epoch;
    const next = await app.followWallet({ ...session, network: 'BSC', chainId: 56 });
    assert.equal(next.network, 'BSC'); assert.equal(next.wallet.session.chainId, 56);
    assert.equal(next.epoch, before + 1); assert.equal(next.running, false);
    await assert.rejects(app.followWallet({ ...session, network: 'BSC', chainId: 1 }));
    assert.equal(app.control().running, false); assert.equal(app.control().wallet.connected, false);
    assert.equal(app.control().lastError, 'WALLET_NETWORK_UNVERIFIED');
  } finally { await app.close(); }
});

test('wallet network change resumes only an already-running acquisition on the selected provider', async () => {
  const called = [];
  const providers = Object.fromEntries(['ETHEREUM', 'BSC'].map(network => [network, { network, async discover() { called.push(network); return []; }, async snapshot() { throw Error('UNEXPECTED'); } }]));
  const app = createApplication({ providers, capitalUsd: 10000, liveConfig: isolatedRoot() });
  const session = { network: 'ETHEREUM', address: '0x' + '2'.repeat(40), chainId: 1, provider: 'okx' };
  try {
    await app.selectNetwork('ETHEREUM'); await app.connect(session); await app.start();
    const next = await app.followWallet({ ...session, network: 'BSC', chainId: 56 });
    assert.equal(next.running, true); assert.equal(next.network, 'BSC');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(called, ['BSC']);
    assert.equal(app.runtime.snapshot().events.filter(e => e.type === 'MarketSnapshot').length, 0);
  } finally { await app.close(); }
});
