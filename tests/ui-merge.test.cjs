'use strict';
// UI-MERGE — BotManager + hub routes tests. The two bots share no strategy state;
// the manager only start/stop/status/health.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { createBotManager } = require('../services/bot-manager.cjs');
const { createDashboardServer } = require('../scripts/serve-meme-trader.cjs');
const { createApplication } = require('../runtime/application.cjs');

function fakeApp({ running = false, mode = 'paper' } = {}) {
  const control = () => ({ running, mode, network: 'SOLANA', epoch: 1, lastError: running ? null : null, wallet: { connected: running } });
  return { control,
    start: async () => { running = true; return control(); },
    stop: async () => { running = false; return control(); } };
}

function fakeFetch(routes) {
  return async (url, options) => {
    const target = String(url).replace(/^https?:\/\/[^/]+/, '');
    const handler = routes.get(`${options?.method ?? 'GET'} ${target}`) ?? routes.get(target);
    if (!handler) return { ok: false, status: 404, json: async () => ({ error: 'NOT_FOUND' }) };
    const [status, body] = await handler(options);
    return { ok: status < 400, status, json: async () => body };
  };
}

test('M01 bot manager reports OFF/ON per bot from real runtimes', async () => {
  const manager = createBotManager({ application: fakeApp({ running: false }), fetch: fakeFetch(new Map([
    ['GET /api/bot/state', async () => [200, { power: { enabled: false }, ft: { connected: true, state: 'stopped', strategy: 'AtlasCore' } }]],
  ])) });
  const status = await manager.status();
  assert.equal(status.meme.state, 'OFF');
  assert.equal(status.longShort.state, 'OFF');
  assert.equal(status.meme.namespace, 'MEME');
  assert.equal(status.longShort.namespace, 'LONG_SHORT');
});

test('M02 start/stop route to the right runtimes without sharing state', async () => {
  const calls = [];
  const app = fakeApp({ running: false });
  const realStart = app.start, realStop = app.stop;
  app.start = async () => { calls.push('meme:start'); return realStart.call(app); };
  app.stop = async () => { calls.push('meme:stop'); return realStop.call(app); };
  const manager = createBotManager({ application: app, fetch: fakeFetch(new Map([
    ['POST /api/bot/power', async options => { calls.push(`long-short:start=${JSON.parse(options.body).enabled}`); return [200, { enabled: JSON.parse(options.body).enabled }]; }],
    ['GET /api/bot/state', async () => [200, { power: { enabled: true }, ft: { connected: true, state: 'running', strategy: 'AtlasCore' } }]],
  ])) });
  await manager.start('meme');
  await manager.start('long-short');
  await manager.stop('meme');
  assert.deepEqual(calls, ['meme:start', 'long-short:start=true', 'meme:stop']);
  const status = await manager.status();
  assert.equal(status.meme.state, 'OFF');
  assert.equal(status.longShort.state, 'ON');
});

test('M03 ON means FreqTrade running; OFF means powered down but connected', async () => {
  const manager = createBotManager({ application: fakeApp({ running: true }), fetch: fakeFetch(new Map([
    ['GET /api/bot/state', async () => [200, { power: { enabled: false }, ft: { connected: true, state: 'stopped' } }]],
  ])) });
  assert.equal((await manager.status()).longShort.state, 'OFF');
});

test('M04 gateway offline or FreqTrade lost = ERROR, never a fake ON', async () => {
  const down = createBotManager({ application: fakeApp(), fetch: async () => { throw new Error('connect ECONNREFUSED'); } });
  assert.equal((await down.status()).longShort.state, 'ERROR');
  const lostFt = createBotManager({ application: fakeApp(), fetch: fakeFetch(new Map([
    ['GET /api/bot/state', async () => [200, { power: { enabled: true }, ft: { connected: false, state: 'unreachable' } }]],
  ])) });
  assert.equal((await lostFt.status()).longShort.state, 'ERROR');
});

test('M05 health reports isolation contract', async () => {
  const manager = createBotManager({ application: fakeApp(), fetch: fakeFetch(new Map([
    ['GET /api/bot/state', async () => [200, { power: { enabled: false }, ft: { connected: true, state: 'stopped' } }]],
  ])) });
  const health = await manager.health();
  assert.equal(health.isolation.sharedStrategyState, false);
  assert.equal(health.isolation.memeNamespace, 'MEME');
  assert.equal(health.isolation.longShortNamespace, 'LONG_SHORT');
});

async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
const get = async (port, pathname) => {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { host: `127.0.0.1:${port}` } });
  return { status: response.status, body: await response.text(), type: response.headers.get('content-type') };
};

test('M06 hub server serves GA assets same-origin and blocks traversal', async () => {
  const app = createApplication({ capitalUsd: 10000, providers: {} });
  const service = createDashboardServer({ application: app });
  try {
    const port = await listen(service.server);
    const module = await get(port, '/ga-assets/js/core/state.mjs');
    assert.equal(module.status, 200);
    assert.match(module.type, /text\/javascript/);
    assert.ok(module.body.includes('SMC_DEFAULTS'));
    const traversal = await get(port, '/ga-assets/..%2F..%2Fpackage.json');
    assert.equal(traversal.status, 404);
    const outside = await get(port, '/ga-assets/package.json');
    assert.equal(outside.status, 404);
  } finally { await service.close(); }
});

test('M07 hub server proxies /api/bot/* to the gateway and reports bot status', async () => {
  const received = [];
  const gateway = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      received.push([request.method, request.url, body]);
      if (request.url === '/api/bot/state') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ power: { enabled: true }, ft: { connected: true, state: 'running' }, bridge: { lastSeq: 1 } })); }
      else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ enabled: true })); }
    });
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  process.env.GA_GATEWAY = `http://127.0.0.1:${gateway.address().port}`;
  const app = createApplication({ capitalUsd: 10000, providers: {} });
  const service = createDashboardServer({ application: app });
  try {
    const port = await listen(service.server);
    const state = await get(port, '/api/bot/state');
    assert.equal(state.status, 200);
    assert.ok(JSON.parse(state.body).ft.connected);
    const power = await fetch(`http://127.0.0.1:${port}/api/bot/power`, { method: 'POST', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    assert.equal(power.status, 200);
    assert.deepEqual(received[1], ['POST', '/api/bot/power', JSON.stringify({ enabled: false })]);
    const bots = JSON.parse((await get(port, '/api/bots/status')).body);
    assert.equal(bots.longShort.state, 'ON');
    assert.ok('meme' in bots);
  } finally { await service.close(); await new Promise(resolve => gateway.close(resolve)); delete process.env.GA_GATEWAY; }
});

test('M08 gateway down makes /api/bot/* answer 502 instead of breaking the page', async () => {
  process.env.GA_GATEWAY = 'http://127.0.0.1:1'; // nothing listens here
  const app = createApplication({ capitalUsd: 10000, providers: {} });
  const service = createDashboardServer({ application: app });
  try {
    const port = await listen(service.server);
    const state = await get(port, '/api/bot/state');
    assert.equal(state.status, 502);
    assert.ok(JSON.parse(state.body).error.includes('GATEWAY_OFFLINE'));
    const bots = JSON.parse((await get(port, '/api/bots/status')).body);
    assert.equal(bots.longShort.state, 'ERROR');
  } finally { await service.close(); delete process.env.GA_GATEWAY; }
});

test('M09 meme bot start keeps its existing gates (wallet/provider) — semantics untouched', async () => {
  const app = createApplication({ capitalUsd: 10000, providers: {} });
  const service = createDashboardServer({ application: app });
  try {
    const port = await listen(service.server);
    const response = await fetch(`http://127.0.0.1:${port}/api/bots/meme/start`, { method: 'POST', headers: { host: `127.0.0.1:${port}` } });
    const body = await response.json();
    // The exact gate depends on the machine (wallet key present or not); what must
    // hold is that a bare start stays gated and leaves the bot not running.
    assert.ok(response.status >= 400, 'start must be gated');
    assert.match(body.error, /WALLET_CONNECTION_REQUIRED|NETWORK_PROVIDER_UNVERIFIED/);
    const control = JSON.parse((await get(port, '/api/control')).body);
    assert.equal(control.running, false);
  } finally { await service.close(); }
});
