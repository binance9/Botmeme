import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLevels, buildStructures, atr14 } from '../services/ga-signal/level-engine.mjs';
import { Scanner } from '../services/ga-signal/scanner/scanner.mjs';
import { LabJournal } from '../services/ga-signal/lib/journal.mjs';

const meta = { symbol: 'BTCUSDT', timeframe: '5m', signal_time: 20000 };
const point = (kind, price, id = kind) => ({ kind, price, id, time: 100, confirmed_at: 200, status: 'CONFIRMED' });
const zone = (side, bottom, top, id = side) => ({ side, bottom, top, id, confirmed_at: 200, status: 'CONFIRMED' });
const input = (structures = {}, overrides = {}) => ({ direction: 'LONG', entry: 100, atr14: 10, tick: .01,
  structures: { ...meta, ...structures }, ...overrides });
const support = point('swing_low', 97);
const resistance = point('swing_high', 110);
const good = () => input({ swings: [support, resistance] });

test('A: LONG without support rejects NO_REFERENCE', () => {
  assert.equal(resolveLevels(input({ swings: [resistance] })).reason, 'NO_REFERENCE');
});
test('B: near resistance is excluded; first eligible resistance fails RR without moving targets', () => {
  const args = input({ swings: [point('swing_low', 90), point('swing_high', 103, 'near'), point('swing_high', 106)] });
  const before = JSON.stringify(args);
  assert.equal(resolveLevels(args).reason, 'RR_LOW');
  assert.equal(JSON.stringify(args), before);
  // Matrix B's diagnostic still excludes the sub-minimum target from receipts.
  assert.equal(resolveLevels(input({ swings: [support, point('swing_high', 103)] })).reason, 'RR_LOW');
});
test('C: one structural resistance produces exactly TP1 with mandatory receipts', () => {
  const r = resolveLevels(good());
  assert.equal(r.accepted, true);
  assert.equal(r.targets.length, 1);
  assert.equal(r.targets[0].price, 110);
  assert.equal(r.sl.price, 94.5);
  assert.equal(r.sl.anchor_price, 97);
  assert.equal(r.rr.tp1, 10 / 5.5);
  for (const x of [r.reference, r.sl, ...r.targets]) assert.ok(x.reason && x.anchor_id);
  assert.equal(r.reference.timeframe, '5m');
  assert.deepEqual(resolveLevels(good()), r);
});
test('D: LONG targets below entry are impossible', () => {
  assert.equal(resolveLevels(input({ swings: [support, point('swing_high', 99)] })).reason, 'NO_TARGET');
});
test('E: SL at entry is invalid; above-entry zones are filtered', () => {
  assert.equal(resolveLevels(input({ obs: [zone('BULLISH', 102.5, 102.5)], swings: [resistance] })).reason, 'SL_INVALID');
  assert.equal(resolveLevels(input({ obs: [zone('BULLISH', 103, 104)], swings: [resistance] })).reason, 'NO_REFERENCE');
});
test('F: SHORT mirrors A, C, D, E and RR', () => {
  const short = structures => input(structures, { direction: 'SHORT' });
  const ceiling = point('swing_high', 103), floor = point('swing_low', 90);
  assert.equal(resolveLevels(short({ swings: [floor] })).reason, 'NO_REFERENCE');
  const r = resolveLevels(short({ swings: [ceiling, floor] }));
  assert.equal(r.accepted, true); assert.equal(r.sl.price, 105.5);
  assert.deepEqual(r.targets.map(t => t.price), [90]); assert.equal(r.rr.tp1, 10 / 5.5);
  assert.equal(resolveLevels(short({ swings: [ceiling, point('swing_low', 101)] })).reason, 'NO_TARGET');
  assert.equal(resolveLevels(short({ obs: [zone('BEARISH', 97.5, 97.5)], swings: [floor] })).reason, 'SL_INVALID');
  assert.equal(resolveLevels(short({ swings: [point('swing_high', 110), point('swing_low', 94)] })).reason, 'RR_LOW');
});
test('G: future confirmation cannot support or target a signal', () => {
  assert.equal(resolveLevels(input({ obs: [{ ...zone('BULLISH', 96, 98), confirmed_at: 20001 }], swings: [resistance] })).reason, 'NO_REFERENCE');
  assert.equal(resolveLevels(input({ swings: [support, { ...resistance, confirmed_at: 20001 }] })).reason, 'NO_TARGET');
});
test('H: mitigated OB and filled FVG cannot support or target', () => {
  for (const [field, flag, side] of [['obs', 'mitigated', 'BULLISH'], ['fvgs', 'filled', 'BULLISH']]) {
    assert.equal(resolveLevels(input({ [field]: [{ ...zone(side, 96, 98), [flag]: true }], swings: [resistance] })).reason, 'NO_REFERENCE');
    assert.equal(resolveLevels(input({ [field]: [{ ...zone('BEARISH', 109, 110), [flag]: true }], swings: [support] })).reason, 'NO_TARGET');
  }
});
test('I: provisional/invalidated/explicitly unconfirmed pivots cannot be anchors', () => {
  for (const extra of [{ status: 'PROVISIONAL' }, { status: 'INVALIDATED' }, { confirmed: false }]) {
    assert.equal(resolveLevels(input({ swings: [{ ...support, ...extra }, resistance] })).reason, 'NO_REFERENCE');
  }
});
test('J: series metadata prevents cross-symbol/timeframe anchors', () => {
  for (const params of [{ symbol: 'ETHUSDT' }, { timeframe: '15m' }]) assert.equal(resolveLevels({ ...good(), params }).reason, 'SERIES_MISMATCH');
  for (const extra of [{ symbol: 'ETHUSDT' }, { timeframe: '15m' }]) assert.equal(resolveLevels(input({ swings: [{ ...support, ...extra }, resistance] })).reason, 'NO_REFERENCE');
  const r = resolveLevels({ ...good(), htfLevels: { symbol: 'ETHUSDT', timeframe: '1h', swings: [support] } });
  assert.equal(r.reference.score, 1);
  assert.equal(r.reference.timeframe, '5m');
});
test('confluences score overlap + HTF + discount, and closest entry breaks ties', () => {
  const structures = { obs: [zone('BULLISH', 96, 98, 'ob')], fvgs: [zone('BULLISH', 95, 97, 'gap')],
    swings: [support, resistance], pdBoundary: { id: 'pd', confirmed_at: 200, discountBottom: 95, discountTop: 99, premiumBottom: 115, premiumTop: 120 } };
  const r = resolveLevels(input(structures, { htfLevels: { ...meta, timeframe: '1h', swings: [support] } }));
  assert.equal(r.reference.source_id, 'pd');
  assert.equal(r.reference.score, 1 + 3 + 1.5 + .5);
  const tie = resolveLevels(input({ swings: [point('swing_low', 90, 'far'), support, resistance] }));
  assert.equal(tie.reference.source_id, support.id);
});
test('target distance, dedupe, strict spacing and three-target cap mirror exactly', () => {
  for (const d of [1, -1]) {
    const s = d === 1 ? 'swing_low' : 'swing_high', t = d === 1 ? 'swing_high' : 'swing_low';
    const r = resolveLevels(input({ swings: [point(s, 100 - d * 3), ...[10, 11, 12.5, 13, 16, 20].map((v, i) => point(t, 100 + d * v, `target-${i}`))] }, { direction: d === 1 ? 'LONG' : 'SHORT' }));
    assert.deepEqual(r.targets.map(t => t.price), [100 + d * 10, 100 + d * 16, 100 + d * 20]);
    assert.equal(Object.keys(r.rr).length, 3);
  }
});
test('absurd zones, invalid input and tick-buffer gate', () => {
  assert.equal(resolveLevels(input({ obs: [zone('BULLISH', 60, 99)] })).reason, 'NO_REFERENCE');
  assert.equal(resolveLevels({ ...good(), atr14: 0 }).reason, 'INVALID_INPUT');
  assert.equal(resolveLevels({ ...good(), tick: 2 }).sl.buffer, 4);
});

const bar = (time, price = 100) => ({ time, open: price, high: price + 1, low: price - 1, close: price, volume: 1 });
test('builder is prefix-stable; provisional pivots and open/future bars are excluded', () => {
  const candles = [100, 102, 105, 103, 100, 96, 100, 103, 107, 103, 100].map((v, i) => bar(i * 300, v));
  const args = { candles, symbol: 'BTCUSDT', timeframe: '5m', signalTime: 2100, pivotLength: 2 };
  const a = buildStructures(args), b = buildStructures({ ...args, candles: candles.slice(0, 7) });
  assert.deepEqual(a, b);
  assert.ok(a.swings.length > 0);
  assert.ok(a.swings.every(s => s.confirmed_at <= 2100 && s.status === 'CONFIRMED'));
  assert.deepEqual(buildStructures({ ...args, candles: [...candles.slice(0, 7), { ...bar(2100, 500), closed: false }] }), b);
  assert.equal(atr14(Array.from({ length: 14 }, (_, i) => bar(i * 300))), 2);
});

const breakout = () => {
  const rows = Array.from({ length: 45 }, (_, i) => ({ ...bar(1700000000 + i * 300), high: 100.5, low: 99.5 }));
  rows.push({ ...bar(1700013500), open: 100, high: 102.2, low: 99.9, close: 102 });
  rows.push({ ...bar(1700013800), open: 101.6, high: 101.9, low: 100.5, close: 101.4 });
  rows.push({ ...bar(1700014100), open: 101.8, high: 108.2, low: 101.7, close: 107.5 });
  return rows;
};
function scannerFixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ga-level-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const journal = new LabJournal({ dir });
  const alerts = [];
  const scanner = new Scanner({ config: { symbols: ['BTCUSDT'], timeframes: ['5m'], variants: ['A', 'B', 'C'], scanner: { minHistory: 10, warmupBars: 0 } },
    journal, outbox: { enqueue: e => alerts.push(e) }, now: () => 1800000000000,
    fetchWindow: async () => ({ candles: breakout(), gaps: [] }), ...extra });
  return { scanner, journal, alerts };
}
test('scanner rejected trigger journals one META NO_SIGNAL and emits no setup or synthetic hits', async t => {
  const { scanner, journal, alerts } = scannerFixture(t);
  await scanner.pollAll(); await scanner.pollAll();
  assert.equal(journal.events.length, 1);
  const event = journal.events[0];
  assert.equal(event.type, 'META'); assert.equal(event.details.type, 'NO_SIGNAL');
  assert.equal(event.event_id, 'no-signal-BTCUSDT-5m-1700013800');
  assert.equal(event.reason, 'NO_REFERENCE'); assert.equal(alerts.length, 0);
});
test('J scanner HTF cache uses own symbol/higher series, closes and cutoff; 1d has no HTF', async t => {
  const calls = [];
  const { scanner } = scannerFixture(t, { fetchRange: async args => {
    calls.push(args);
    return [bar(args.endTime - 3600, args.symbol === 'BTCUSDT' ? 100 : 200), bar(args.endTime),
      { ...bar(args.endTime + 3600), closed: false }, { ...bar(args.endTime), symbol: 'WRONG' }];
  } });
  const candles = [bar(1800000000 - 300)];
  const a = await scanner.higherStructures('BTCUSDT', '5m', candles);
  assert.equal(a.timeframe, '1h'); assert.equal(a.candles.length, 2);
  assert.ok(a.candles.every(b => b.time + 3600 <= 1800000000));
  assert.equal(await scanner.higherStructures('BTCUSDT', '15m', [bar(1800000000 - 900)]), a);
  const b = await scanner.higherStructures('ETHUSDT', '5m', candles);
  assert.notEqual(a, b); assert.equal(b.symbol, 'ETHUSDT');
  assert.deepEqual(calls.map(c => [c.symbol, c.timeframe]), [['BTCUSDT', '1h'], ['ETHUSDT', '1h']]);
  assert.equal(await scanner.higherStructures('BTCUSDT', '1d', candles), null);
});

test('restart preserves receipts and completes a one-target setup without phantom TP2/TP3', async t => {
  const { scanner, journal } = scannerFixture(t);
  const { accepted, ...receipts } = resolveLevels(good());
  const time = 1700013800;
  journal.append({ type: 'SETUP_CREATED', event_id: 'saved:SETUP_CREATED', setup_id: 'saved',
    symbol: 'BTCUSDT', timeframe: '5m', candle_time: time, side: 'LONG', variant: 'C',
    details: { ...receipts, setup: { signal_time: time, entry_ref: 100, side: 'LONG', trigger_level: 99 } } });
  scanner.fetchWindow = async () => ({ candles: [...breakout().slice(0, -1), { ...bar(time + 300, 111), low: 100 }], gaps: [] });
  await scanner.pollAll(); await scanner.pollAll();
  const saved = journal.events.filter(e => e.setup_id === 'saved');
  assert.deepEqual(saved.map(e => e.type), ['SETUP_CREATED', 'TP1_HIT']);
  assert.equal(saved[1].price, 110); assert.equal(saved[1].details.completed, true);
  assert.deepEqual(saved[1].details.sl, receipts.sl);
});

test('SL takes precedence on ambiguous candles using structural receipt prices', async t => {
  const { scanner, journal } = scannerFixture(t);
  const { accepted, ...receipts } = resolveLevels(good());
  const time = 1700013800;
  journal.append({ type: 'SETUP_CREATED', event_id: 'stop:SETUP_CREATED', setup_id: 'stop',
    symbol: 'BTCUSDT', timeframe: '5m', candle_time: time, side: 'LONG', variant: 'C',
    details: { ...receipts, setup: { signal_time: time, entry_ref: 100, side: 'LONG' } } });
  scanner.fetchWindow = async () => ({ candles: [...breakout().slice(0, -1), { ...bar(time + 300, 111), low: 90 }], gaps: [] });
  await scanner.pollAll();
  const saved = journal.events.filter(e => e.setup_id === 'stop');
  assert.deepEqual(saved.map(e => e.type), ['SETUP_CREATED', 'SL_HIT']);
  assert.equal(saved[1].price, 94.5); assert.equal(saved[1].details.ambiguous, true);
});

test('presenter draws receipt prices/reasons only, never legacy setup SL/TP values', async () => {
  const source = fs.readFileSync(new URL('../public/meme-trader/ga-signal.js', import.meta.url), 'utf8');
  const { GaSignalLayer } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const layer = new GaSignalLayer(), labels = [], coordinates = [];
  layer.chart = { timeScale: () => ({ logicalToCoordinate: n => n * 10 }) };
  layer.series = { priceToCoordinate: p => { coordinates.push(p); return p * 2; } };
  const ctx = new Proxy({ measureText: s => ({ width: s.length * 5 }), fillText: s => labels.push(s) }, {
    get: (o, key) => key in o ? o[key] : () => {}, set: (o, key, value) => { o[key] = value; return true; } });
  const setup = { signal_time: 0, entry_ref: 100, sl: 500, tp1: 600, tp2: 700, tp3: 800 };
  layer.setData({ rows: [bar(0), bar(300)], active: { setup_id: 'x', details: { setup } } });
  const draw = () => layer.draw({ context: ctx, mediaSize: { width: 1600, height: 900 } });
  draw(); assert.deepEqual(labels, []); assert.deepEqual(coordinates, []);
  const { accepted, ...receipts } = resolveLevels(good());
  layer.active.details = { setup, ...receipts };
  draw();
  assert.ok(labels.some(s => s.startsWith('Reference Zone') && s.includes(receipts.reference.reason)));
  assert.ok(labels.some(s => s.includes('SL 94.5000') && s.includes(receipts.sl.reason)));
  assert.ok(labels.some(s => s.includes('Target Point 1 110.00') && s.includes(receipts.targets[0].reason)));
  assert.ok(!coordinates.some(p => p >= 500));
  labels.length = 0;
  delete layer.active.details.sl.reason;
  draw(); assert.ok(!labels.some(s => s.includes('SL ')));
});
