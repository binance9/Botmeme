'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { NETWORKS, getNetworkAdapter } = require('../wallet/network/index.cjs');
const { createConnectionStore } = require('../wallet/connection/store.cjs');
const ids = { SOLANA: 'mainnet-beta', ETHEREUM: 1, BSC: 56, ROBINHOOD: 4663 };
function session(network = 'SOLANA') { return { network, address: network === 'SOLANA' ? 'So11111111111111111111111111111111111111112' : '0x1234567890abcdef1234567890abcdef12345678', chainId: ids[network], provider: 'injected.test-wallet' }; }
test('wallet has four separate immutable read-only adapter identities with explicit chains', () => {
  assert.deepEqual(NETWORKS, ['SOLANA', 'ETHEREUM', 'BSC', 'ROBINHOOD']);
  for (const network of NETWORKS) {
    const adapter = getNetworkAdapter(network), result = adapter.validateSession(session(network));
    assert.deepEqual(result, session(network)); assert.equal(adapter.descriptor.chainId, ids[network]);
    assert.equal(adapter.descriptor.readOnly, true); assert.equal(adapter.descriptor.ownershipVerified, false);
    assert.deepEqual(adapter.descriptor.capabilities, ['PUBLIC_ACCOUNT_METADATA']);
    assert.deepEqual(Object.keys(adapter), ['descriptor', 'validateSession']);
    assert.ok(Object.isFrozen(adapter) && Object.isFrozen(adapter.descriptor) && Object.isFrozen(adapter.descriptor.capabilities) && Object.isFrozen(result));
  }
});
test('wallet rejects testnet wrong missing and coerced chain identities without fallback', () => {
  for (const network of NETWORKS) for (const chainId of [undefined, null, '', true, network === 'SOLANA' ? 'devnet' : 46630]) {
    assert.throws(() => getNetworkAdapter(network).validateSession({ ...session(network), chainId }), /INVALID_WALLET_CHAIN/);
  }
  assert.equal(getNetworkAdapter('BSC').validateSession({ ...session('BSC'), chainId: '0x38' }).chainId, 56);
  assert.equal(getNetworkAdapter('ROBINHOOD').validateSession({ ...session('ROBINHOOD'), chainId: '0x1237' }).chainId, 4663);
  assert.throws(() => getNetworkAdapter('ETHEREUM').validateSession(session('BSC')), /INVALID_WALLET_NETWORK_MISMATCH/);
});
test('wallet validates full decoded Solana address length and bounded EVM address format', () => {
  for (const address of ['0'.repeat(32), '1'.repeat(31), '1'.repeat(33), 'z'.repeat(44), 'So11111111111111111111111111111111111111112 ']) assert.throws(() => getNetworkAdapter('SOLANA').validateSession({ ...session(), address }), /INVALID_WALLET_ADDRESS/);
  for (const address of ['0x123', '0x' + 'g'.repeat(40), '0x' + 'a'.repeat(64), ' ' + session('BSC').address]) assert.throws(() => getNetworkAdapter('BSC').validateSession({ ...session('BSC'), address }), /INVALID_WALLET_ADDRESS/);
});
test('wallet session rejects secret fields unexpected properties accessors and prototypes without reading getters', () => {
  for (const field of ['privateKey', 'seedPhrase', 'recoveryPhrase', 'signer', 'extra']) assert.throws(() => getNetworkAdapter('SOLANA').validateSession({ ...session(), [field]: 'sensitive-value' }), /INVALID_WALLET_SESSION_FIELDS/);
  const inherited = Object.assign(Object.create({ inherited: true }), session()); assert.throws(() => getNetworkAdapter('SOLANA').validateSession(inherited), /INVALID_WALLET_SESSION/);
  let accessed = false; const getter = session(); Object.defineProperty(getter, 'address', { get() { accessed = true; return session().address; }, enumerable: true });
  assert.throws(() => getNetworkAdapter('SOLANA').validateSession(getter), /INVALID_WALLET_ACCESSOR/); assert.equal(accessed, false);
  for (const provider of ['private_key:secret', 'seed phrase words', 'x'.repeat(81)]) assert.throws(() => getNetworkAdapter('SOLANA').validateSession({ ...session(), provider }), /INVALID_WALLET_PROVIDER/);
});
test('wallet network changes disconnect rather than relabel the previous public session', () => {
  const store = createConnectionStore(); assert.equal(store.isConnected(), false);
  const first = store.connect(session()); assert.equal(store.isConnected(), true);
  assert.equal(store.selectNetwork('SOLANA').connected, true);
  const changed = store.selectNetwork('ROBINHOOD'); assert.equal(changed.session, null); assert.equal(changed.connected, false);
  assert.equal(first.network, 'SOLANA'); assert.equal(first.session.network, 'SOLANA');
  assert.throws(() => store.connect(session()), /INVALID_WALLET_NETWORK_MISMATCH/);
  store.connect(session('ROBINHOOD')); assert.equal(store.snapshot().session.chainId, 4663);
  assert.equal(store.disconnect().session, null); assert.equal(store.snapshot().network, 'ROBINHOOD');
});
test('wallet failed connection and output mutation cannot corrupt the stored public account', () => {
  const store = createConnectionStore({ network: 'ETHEREUM' }), input = session('ETHEREUM'); store.connect(input); input.address = 'bad';
  const before = store.snapshot(); assert.equal(before.session.address, session('ETHEREUM').address);
  assert.throws(() => { before.session.address = 'bad'; }, TypeError);
  assert.throws(() => store.connect({ ...session('ETHEREUM'), chainId: 56 }), /INVALID_WALLET_CHAIN_MISMATCH/);
  assert.deepEqual(store.snapshot(), before); assert.equal(store.snapshot().ownershipVerified, false);
  assert.throws(() => store.selectNetwork('__proto__'), /INVALID_WALLET_NETWORK/); assert.deepEqual(store.snapshot(), before);
});

test('saved accounts survive network round trips and explicit disconnect removes only selected account',()=>{const s=createConnectionStore();s.connect(session());s.selectNetwork('ROBINHOOD');s.connect(session('ROBINHOOD'));assert.deepEqual(s.selectNetwork('SOLANA').session,session());const saved=JSON.parse(JSON.stringify(s.saved()));const restored=createConnectionStore();restored.restore(saved);assert.deepEqual(restored.snapshot().session,session());restored.disconnect();assert.equal(restored.snapshot().session,null);assert.deepEqual(restored.selectNetwork('ROBINHOOD').session,session('ROBINHOOD'));assert.throws(()=>restored.restore([{...session(),chainId:1}]));assert.deepEqual(restored.snapshot().session,session('ROBINHOOD'));});
