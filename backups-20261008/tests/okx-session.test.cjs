'use strict';
// Pure protocol validation cases; these do not establish a real wallet connection.
const test = require('node:test'), assert = require('node:assert/strict');
const helpers = import('../wallet/connection/okx-session.mjs');
test('OKX metadata requires exact approved chain and validated public account', async () => {
  const { publicSession } = await helpers, address = '0x' + 'a'.repeat(40);
  const session = { topic: 'protocol-fixture-only', namespaces: { eip155: { chains: ['eip155:1', 'eip155:56'], accounts: ['eip155:1:' + address] } } };
  assert.deepEqual(publicSession(session, 'ETHEREUM'), { network: 'ETHEREUM', address, chainId: 1, provider: 'okx-connect' });
  assert.throws(() => publicSession(session, 'BSC'), /APPROVED_ACCOUNT_INVALID/);
  assert.throws(() => publicSession(session, 'ROBINHOOD'), /NETWORK_NOT_APPROVED/);
  assert.throws(() => publicSession(session, 'UNKNOWN'), /UNSUPPORTED_NETWORK/);
  const result = publicSession(session, 'ETHEREUM'); assert.deepEqual(Object.keys(result).sort(), ['address', 'chainId', 'network', 'provider']); assert.equal(Object.isFrozen(result), true);
});
test('OKX selected required network and optional networks contain no signing requests', async () => {
  const { connectNamespaces, NETWORKS } = await helpers;
  for (const [network, chain] of Object.entries(NETWORKS)) {
    const result = connectNamespaces(network), required = Object.values(result.namespaces).flatMap(ns => ns.chains), optional = Object.values(result.optionalNamespaces).flatMap(ns => ns.chains);
    assert.deepEqual(required, [chain]); assert.equal(optional.length, 3); assert.ok(!optional.includes(chain));
    assert.equal(result.sessionConfig.openUniversalUrl, false); assert.equal(result.signRequest, undefined); assert.equal(result.methods, undefined);
  }
});
test('OKX chain events map only supported networks and Solana addresses decode to 32 bytes', async () => {
  const { networkForChain, publicSession, NETWORKS } = await helpers;
  assert.equal(networkForChain('0x38'), 'BSC'); assert.equal(networkForChain(1), 'ETHEREUM'); assert.equal(networkForChain('eip155:4663'), 'ROBINHOOD'); assert.equal(networkForChain(NETWORKS.SOLANA.split(':')[1]), 'SOLANA'); assert.equal(networkForChain('0x89'), null);
  const chain = NETWORKS.SOLANA, session = { namespaces: { solana: { chains: [chain], accounts: [chain + ':' + '1'.repeat(32)] } } };
  assert.equal(publicSession(session, 'SOLANA').chainId, 'mainnet-beta');
  session.namespaces.solana.accounts = [chain + ':' + '1'.repeat(33)]; assert.throws(() => publicSession(session, 'SOLANA'), /APPROVED_ACCOUNT_INVALID/);
});
