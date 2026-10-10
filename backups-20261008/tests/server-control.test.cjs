'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createApplication } = require('../runtime/application.cjs');
const { createDashboardServer } = require('../scripts/serve-meme-trader.cjs');
async function setup(t) {
  // Real application and transport, no wallet extension, market provider, or bot START.
  // Isolated live root so the operator's real wallet-key.env / live-state.json on this
  // machine cannot leak hasKey, mode or reconciliation events into the assertions.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botmeme-control-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const application = createApplication({ capitalUsd: 10000, providers: {}, liveConfig: { root } }), service = createDashboardServer({ application });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(() => service.close()); const origin = 'http://127.0.0.1:' + service.server.address().port;
  const post = (url, body, headers = {}) => fetch(origin + url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { application, service, origin, post };
}
test('production server exposes actual control/state, refuses event injection and START before wallet', async t => {
  const x = await setup(t), control = await (await fetch(x.origin + '/api/control')).json();
  assert.equal(control.running, false); assert.equal(control.mode, 'paper'); assert.equal(control.wallet.connected, false);
  assert.equal((await x.post('/api/events', {})).status, 405);
  const start = await x.post('/api/control', { action: 'START' }); assert.equal(start.status, 409); assert.equal((await start.json()).error, 'WALLET_CONNECTION_REQUIRED');
  assert.equal((await x.post('/api/control', { action: 'STOP' })).status, 200);
  const state = await (await fetch(x.origin + '/api/state')).json(); assert.equal(state.trades.length, 0); assert.equal(x.application.runtime.snapshot().events.length, 0);
});
test('control routes enforce exact fields JSON size origin and host; expose only intended assets', async t => {
  const x = await setup(t);
  assert.equal((await x.post('/api/control', { action: 'STOP', extra: true })).status, 400);
  assert.equal((await x.post('/api/control', { action: 'BUY' })).status, 400);
  assert.equal((await x.post('/api/wallet/disconnect', { extra: true })).status, 400);
  assert.equal((await x.post('/api/network', { network: 'SOLANA' }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await x.post('/api/control', { action: 'STOP' }, { origin: 'https://foreign.example' })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => { const request = http.get(x.origin + '/api/control', { headers: { host: 'foreign.example' } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject); });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await x.post('/api/network', { network: 'x'.repeat(65536) })).status, 413);
  for (const name of ['wallet.js', 'wallet.css']) assert.equal((await fetch(x.origin + '/meme-trader/' + name)).status, 200);
  assert.equal((await fetch(x.origin + '/data/runtime.jsonl')).status, 404);
  assert.equal((await x.post('/api/orders', {})).status, 404);
});
test('network selection changes actual epoch and SSE snapshot without attaching any wallet', async t => {
  const x = await setup(t), response = await fetch(x.origin + '/api/events'), reader = response.body.getReader();
  t.after(() => reader.cancel()); const decoder = new TextDecoder(); let buffer = '';
  async function next() { while (true) { const end = buffer.indexOf('\n\n'); if (end >= 0) { const block = buffer.slice(0, end); buffer = buffer.slice(end + 2); const data = block.split('\n').find(line => line.startsWith('data: ')); if (data) return JSON.parse(data.slice(6)); } else { const result = await reader.read(); if (result.done) throw Error('SSE_CLOSED'); buffer += decoder.decode(result.value); } } }
  await next(); const result = await x.post('/api/network', { network: 'BSC' }); assert.equal(result.status, 200);
  const control = await result.json(); assert.equal(control.network, 'BSC'); assert.equal(control.epoch, 2); assert.equal(control.wallet.connected, false);
  const pushed = await next(); assert.ok(pushed); assert.equal(x.application.runtime.snapshot().network, 'BSC');
  assert.equal((await x.post('/api/network', { network: 'UNKNOWN' })).status, 409); await reader.cancel();
});
test('wallet route rejects incomplete secret-bearing or unsupported metadata without connection', async t => {
  const x = await setup(t);
  assert.equal((await x.post('/api/wallet/connect', { network: 'SOLANA', address: 'invalid' })).status, 400);
  assert.equal((await x.post('/api/wallet/connect', { network: 'SOLANA', address: 'invalid', chainId: 'mainnet-beta', provider: 'phantom', privateKey: 'forbidden' })).status, 400);
  const response = await x.post('/api/wallet/connect', { network: 'SOLANA', address: 'invalid', chainId: 'mainnet-beta', provider: 'phantom' }); assert.equal(response.status, 409);
  assert.equal(x.application.control().wallet.connected, false); assert.equal((await x.post('/api/wallet/disconnect', {})).status, 200);
});
