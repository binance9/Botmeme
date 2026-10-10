// LONG_SHORT:GA_SIGNAL service tests — structured events, dedupe, honest NOT_CONFIGURED telegram.
// Run: node --test tests/ga-signal-service.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startGaSignalService, GA_SIGNAL_CONFIG } from '../services/ga-signal/service.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ga-signal-svc-'));
const CANDLE = (t, o, h, l, c) => ({ time: t, open: o, high: h, low: l, close: c, volume: 1 });

function breakoutSeries({ withSetup = true, withStructure = true } = {}) {
  const candles = Array.from({ length: 45 }, (_, i) => CANDLE(1700000000 + i * 300, 100, 100.5, 99.5, 100));
  if (withStructure) {
    // Confirmed resistance predates the 20-bar breakout range; support confirms before retest.
    for (const [i, high] of [[5, 110], [12, 114], [19, 118]]) candles[i].high = high;
    candles[30].low = 99;
  }
  if (withSetup) {
    candles.push(CANDLE(1700000000 + 45 * 300, 100, 102.2, 99.9, 102));       // breakout
    candles.push(CANDLE(1700000000 + 46 * 300, 101.6, 101.9, 100.5, 101.4));  // retest -> SETUP_CREATED
    candles.push(CANDLE(1700000000 + 47 * 300, 101.8, 120.2, 101.7, 119.5));  // TP1..TP3
  }
  return candles;
}
const makeFetch = series => { let call = 0; return async () => ({ candles: series[Math.min(call++, series.length - 1)], gaps: [] }); };

function mockResponse() {
  const headers = new Map();
  let body = '', status = 0;
  return {
    headers, get status() { return status; }, get body() { return body; },
    writeHead(code, headerMap) { status = code; for (const [k, v] of Object.entries(headerMap ?? {})) headers.set(k, v); },
    end(payload = '') { body += payload; },
    write() {},
  };
}
const mockRequest = ({ method = 'GET' } = {}) => ({ method, on() {}, });

test('service: scanner emits structured events; journal dedupes by signal identity', async () => {
  const dir = tmp();
  const logs = [];
  const service = await startGaSignalService({
    dataDir: dir, now: () => 1_800_000_000_000, log: m => logs.push(m), autostart: false,
    config: { scanner: { minHistory: 10, warmupBars: 0 } },
    fetchWindow: makeFetch([breakoutSeries({ withSetup: false }), breakoutSeries()]),
  });
  await service.scanner.pollAll(); // boot prime (flat) — nothing
  const bootCount = key => service.journal.events.filter(e => e.type !== 'META' && e.symbol === 'BTCUSDT').length;
  assert.equal(bootCount(), 0);
  await service.scanner.pollAll(); // setup + TPs (BTCUSDT row of the mock)
  const events = service.journal.events.filter(e => e.type !== 'META' && e.symbol === 'BTCUSDT');
  assert.deepEqual(events.map(e => e.type), ['SETUP_CREATED', 'TP1_HIT', 'TP2_HIT', 'TP3_HIT']);
  const signal = events[0];
  // Structured-event contract (requirement 9):
  assert.equal(signal.setup_id, `GA-C-BTCUSDT-5m-${signal.candle_time}`);
  assert.equal(signal.side, 'LONG');
  assert.equal(signal.confirmed, true);
  assert.ok(signal.details.reference.anchor_id);
  assert.ok(signal.details.sl.reason);
  assert.deepEqual(signal.details.targets.map(t => t.price), [110, 114, 118]);
  assert.ok(signal.details.rr.tp1 >= 1);
  assert.equal(signal.filter_state, 'BREAKOUT_UP');
  assert.equal(signal.variant, 'C');
  assert.ok(Number.isFinite(signal.candle_time));
  assert.ok(Number.isFinite(signal.ts));
  assert.equal(signal.details.setup.sl < signal.details.setup.entry_ref, true);
  await service.scanner.pollAll(); // rerun: journal must not duplicate
  assert.equal(bootCount(), 4);
  service.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('service: variant B carries ADX_QUALIFIED filter_state (real cached data when available)', async t => {
  // B = trend-pullback + ADX gate needs 250+ bars of realistic EMA structure; the LAB kline cache
  // provides it when present. Without it, engine semantics stay covered by the LAB suite (23 tests).
  const klines = 'C:/GA_SIGNAL_LAB/data/klines/BTCUSDT-5m.jsonl';
  if (!fs.existsSync(klines)) return t.skip('LAB kline cache not present on this machine');
  const candles = fs.readFileSync(klines, 'utf8').trim().split('\n').map(JSON.parse).slice(-1000);
  const dir = tmp();
  const service = await startGaSignalService({
    dataDir: dir, now: () => 1_800_000_000_000, autostart: false,
    fetchWindow: async () => ({ candles, gaps: [] }),
  });
  await service.scanner.pollAll();
  const bSignals = service.journal.events.filter(e => e.variant === 'B' && e.type === 'SETUP_CREATED');
  if (bSignals.length === 0) { service.stop(); return t.skip('no B setup in the last 1000 bars'); }
  for (const signal of bSignals) assert.ok(signal.filter_state.startsWith('ADX_QUALIFIED|'), signal.filter_state);
  assert.ok(bSignals.every(e => e.signal_id === e.setup_id));
  service.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('service HTTP: state/events/setups/404; telegram NOT_CONFIGURED never fakes a send', async () => {
  const dir = tmp();
  delete process.env.GA_TG_TOKEN; delete process.env.GA_TG_CHAT; // honest default for this test run
  const service = await startGaSignalService({
    dataDir: dir, now: () => 1_800_000_000_000, autostart: false,
    config: { scanner: { minHistory: 10, warmupBars: 0 } },
    fetchWindow: makeFetch([breakoutSeries()]),
  });
  await service.scanner.pollAll();

  const url = p => new URL(`http://127.0.0.1:7883${p}`);
  const state = mockResponse();
  await service.handle(mockRequest(), state, url('/api/ga-signal/state'));
  const stateBody = JSON.parse(state.body);
  assert.equal(stateBody.namespace, 'LONG_SHORT:GA_SIGNAL');
  assert.equal(stateBody.telegram.configured, false);
  assert.equal(stateBody.telegram.status, 'NOT_CONFIGURED');

  const events = mockResponse();
  await service.handle(mockRequest(), events, url('/api/ga-signal/events?symbol=BTCUSDT&timeframe=5m'));
  const eventsBody = JSON.parse(events.body);
  assert.equal(eventsBody.events.length, 4);
  assert.ok(eventsBody.events.every(e => e.signal_id && e.signal_id === e.setup_id && e.confirmed === true));

  const setups = mockResponse();
  await service.handle(mockRequest(), setups, url('/api/ga-signal/setups?symbol=BTCUSDT&timeframe=15m'));
  assert.equal(JSON.parse(setups.body).setups.length, 0, 'timeframe isolation');
  const other = mockResponse();
  await service.handle(mockRequest(), other, url('/api/ga-signal/setups?symbol=ETHUSDT&timeframe=5m'));
  assert.equal(JSON.parse(other.body).setups.length, 1, 'each symbol gets its own setup identity');

  const test = mockResponse();
  await service.handle(mockRequest({ method: 'POST' }), test, url('/api/ga-signal/telegram/test'));
  const testBody = JSON.parse(test.body);
  assert.equal(testBody.configured, false);
  assert.equal(testBody.status, 'NOT_CONFIGURED');
  assert.equal(service.outbox.status().counts.SENT ?? 0, 0, 'no fake SENT');

  const unknown = mockResponse();
  await service.handle(mockRequest(), unknown, url('/api/ga-signal/nope'));
  assert.equal(unknown.status, 404);

  service.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('config namespace isolation: engine never touches MEME namespace', async () => {
  assert.equal(GA_SIGNAL_CONFIG.namespace.startsWith('LONG_SHORT:GA_SIGNAL'), true);
  assert.ok(!JSON.stringify(GA_SIGNAL_CONFIG).includes('MEME'));
});
