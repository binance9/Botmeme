'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createBalanceReader } = require('../wallet/connection/balance.cjs');
const session = { network: 'ROBINHOOD', chainId: 4663, address: '0x1234567890abcdef1234567890abcdef12345678', provider: 'okx-connect' };
function fetcher(results, calls) { return async (url, options) => { const body = JSON.parse(options.body); calls.push(body); return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: results[body.method] }), { status: 200 }); }; }
test('reads exact native quantity at a pinned block, checks chain and caches without signing', async () => {
  const calls = [], reader = createBalanceReader({ fetcher: fetcher({ eth_chainId: '0x1237', eth_blockNumber: '0x10', eth_getBalance: '0xde0b6b3a7640001' }, calls) });
  const result = await reader.read(session);
  assert.equal(result.amount, '1.000000000000000001'); assert.equal(result.status, 'OBSERVED'); assert.equal(result.block, '0x10');
  assert.deepEqual(calls.map(c => c.method), ['eth_chainId', 'eth_blockNumber', 'eth_getBalance']);
  assert.deepEqual(calls[2].params, [session.address, '0x10']);
  await reader.read(session); assert.equal(calls.length, 3);
});
test('wrong chain and RPC errors never become zero balances', async () => {
  for (const provider of [fetcher({ eth_chainId: '0x1' }, []), async () => { throw Error('private-provider-detail'); }]) {
    const value = await createBalanceReader({ fetcher: provider }).read(session);
    assert.equal(value.status, 'CHUA_XAC_MINH'); assert.equal(value.amount, null); assert.ok(!JSON.stringify(value).includes('private-provider-detail'));
  }
});
test('Solana verifies genesis and preserves lamport precision', async () => {
  const calls = [], reader = createBalanceReader({ fetcher: fetcher({ getGenesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', getBalance: { context: { slot: 21 }, value: 1000000001 } }, calls) });
  const value = await reader.read({ ...session, network: 'SOLANA', chainId: 'mainnet-beta', address: 'So11111111111111111111111111111111111111112' });
  assert.equal(value.amount, '1.000000001'); assert.equal(value.symbol, 'SOL'); assert.equal(value.block, '21');
});
test('cache does not reuse balances across accounts or networks', async () => {
  const calls = [], reader = createBalanceReader({ fetcher: fetcher({ eth_chainId: '0x1237', eth_blockNumber: '0x10', eth_getBalance: '0x0' }, calls) });
  await reader.read(session); await reader.read({ ...session, address: '0x2234567890abcdef1234567890abcdef12345678' });
  assert.equal(calls.length, 6);
  const wrong = await reader.read({ ...session, network: 'BSC', chainId: 56 }); assert.equal(wrong.amount, null);
});
