// Pure structural receipts. All prices are anchors; RR is a final gate only.
import { stableId } from './smc/pivot-engine.mjs';
import { StructureEngine } from './smc/structure-engine.mjs';
import { OrderBlockEngine } from './smc/order-block-engine.mjs';
import { FVGEngine } from './smc/fvg-engine.mjs';
import { EqualHighLowEngine } from './smc/eqh-eql-engine.mjs';
import fs from 'node:fs';

// Slow-build profiler: transient multi-second freezes traced to this function's
// callers (ETHUSDT/PAXG 5m·1d). Names the symbol+timeframe+duration when a single
// structure build exceeds 800ms so the superlinear engine can be identified.
const structTrace = (symbol, timeframe, started, bars) => {
  const took = Date.now() - started;
  if (took <= 800) return;
  try { fs.appendFileSync('C:\\Botmeme\\runtime\\ga-struct.log', `${new Date().toISOString()} ${symbol} ${timeframe} ${took}ms bars=${bars}\n`); } catch { }
};
import { computePremiumDiscount } from './smc/premium-discount.mjs';

export const HIGHER_TIMEFRAME = Object.freeze({ '5m': '1h', '15m': '1h', '1h': '4h', '4h': '1d' });
export const timeframeSeconds = tf => Number.parseInt(tf) * ({ m: 60, h: 3600, d: 86400 }[tf.at(-1)] ?? NaN);
export const candleClose = (bar, timeframe) => Math.max(bar.time + timeframeSeconds(timeframe), bar.closedAt ?? 0, bar.close_time ?? 0);

// Build from a prefix ending at the signal close, never from the eventual replay tail.
export function buildStructures({ candles, symbol, timeframe, signalTime, pivotLength = 5 }) {
  const t0 = Date.now();
  const bars = candles.filter(b => b.closed !== false && candleClose(b, timeframe) <= signalTime)
    .map(b => ({ ...b, closed: true, closedAt: candleClose(b, timeframe) }));
  const engine = new StructureEngine({ N: pivotLength });
  const ob = new OrderBlockEngine(), fvg = new FVGEngine(), eq = new EqualHighLowEngine();
  const obTimes = new Map();
  for (const b of bars) {
    const state = engine.update(b);
    for (const item of ob.update(b, state.events)) if (!obTimes.has(item.event_id)) obTimes.set(item.event_id, b.closedAt);
    fvg.update(b); eq.update(b);
  }
  const state = engine.snapshot();
  const meta = { symbol, timeframe, status: 'CONFIRMED' };
  const swings = state.pivots.filter(p => p.status === 'CONFIRMED').map(p => ({ ...meta,
    kind: p.type === 'PIVOT_LOW' ? 'swing_low' : 'swing_high', price: p.price, time: p.time,
    id: p.event_id, confirmed_at: p.confirmedAt }));
  if (state.weak?.status === 'CONFIRMED') swings.push({ ...meta,
    kind: state.trend === 'BULLISH' ? 'swing_high' : 'swing_low', price: state.weak.price,
    time: state.weak.time, id: stableId('weak', symbol, timeframe, state.weak.time, state.weak.price),
    confirmed_at: bars.at(-1).closedAt });
  const pd = computePremiumDiscount(state);
  const pdBoundary = pd ? { ...meta, id: pd.event_id, confirmed_at: bars.at(-1).closedAt,
    premiumTop: pd.premium.top, premiumBottom: pd.premium.bottom,
    discountTop: pd.discount.top, discountBottom: pd.discount.bottom } : null;
  // Only complete prior UTC periods wholly covered by this window are anchors.
  const prevDWM = [];
  const periodStart = (time, granularity) => {
    const d = new Date(time * 1000); d.setUTCHours(0, 0, 0, 0);
    if (granularity === 'W') d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
    if (granularity === 'M') d.setUTCDate(1);
    return d.getTime() / 1000;
  };
  for (const granularity of ['D', 'W', 'M']) {
    const end = periodStart(signalTime, granularity), start = periodStart(end - 1, granularity);
    const rows = bars.filter(b => b.time >= start && b.closedAt <= end);
    if (!rows.length || rows[0].time !== start || rows.at(-1).closedAt !== end ||
      rows.some((b, i) => i && b.time !== rows[i - 1].closedAt)) continue;
    for (const kind of ['high', 'low']) prevDWM.push({ ...meta, granularity, kind,
      price: (kind === 'high' ? Math.max : Math.min)(...rows.map(b => b[kind])),
      id: `${symbol}-${timeframe}-${granularity}-${start}-${kind}`, confirmed_at: end });
  }
  structTrace(symbol, timeframe, t0, bars.length);
  return { symbol, timeframe, signal_time: signalTime, swings, pdBoundary, prevDWM,
    obs: ob.snapshot().map(o => ({ ...meta, side: o.bias, top: o.barHigh, bottom: o.barLow,
      time: o.barTime, id: o.event_id, mitigated: o.mitigated, confirmed_at: obTimes.get(o.event_id) })),
    fvgs: fvg.snapshot().map(g => ({ ...meta, ...g, id: g.event_id, filled: g.mitigated,
      confirmed_at: bars.find(b => b.time === g.time).closedAt })),
    eqhEql: eq.snapshot().map(e => ({ ...meta, kind: e.type, price: e.price, time: e.timeTo,
      id: e.event_id, confirmed_at: e.confirmedAt })) };
}

export function atr14(candles) {
  if (candles.length < 14) return null;
  let value = 0, sum = 0;
  candles.forEach((c, i) => {
    const prev = candles[i - 1]?.close ?? c.close;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
    if (i < 14) { sum += tr; value = sum / 14; }
    else value = (value * 13 + tr) / 14;
  });
  return value;
}

export function resolveLevels({ direction, entry, atr14: atr, tick, structures = {}, htfLevels = {}, params = {} }) {
  const reject = reason => ({ accepted: false, reason });
  if (!['LONG', 'SHORT'].includes(direction) || ![entry, atr, tick].every(Number.isFinite) || atr <= 0 || tick <= 0) return reject('INVALID_INPUT');
  const d = direction === 'LONG' ? 1 : -1;
  const symbol = params.symbol ?? structures.symbol, timeframe = params.timeframe ?? structures.timeframe;
  const signalTime = params.signalTime ?? params.signal_time ?? structures.signal_time;
  if (!Number.isFinite(signalTime)) return reject('INVALID_INPUT');
  if ((structures.symbol && symbol !== structures.symbol) || (structures.timeframe && timeframe !== structures.timeframe)) return reject('SERIES_MISMATCH');
  const valid = (x, tf) => x && x.id && x.status !== 'PROVISIONAL' && x.status !== 'INVALIDATED' &&
    x.confirmed !== false && (!x.status || x.status === 'CONFIRMED') && !x.mitigated && !x.filled &&
    (!x.symbol || x.symbol === symbol) && (!x.timeframe || x.timeframe === tf) &&
    Number.isFinite(x.confirmed_at ?? x.confirmedAt ?? x.time) && (x.confirmed_at ?? x.confirmedAt ?? x.time) <= signalTime;
  const candidates = (s, tf) => {
    const out = [];
    const add = (x, type, side, bottom, top = bottom) => {
      if (!valid(x, tf) || ![bottom, top].every(Number.isFinite) || bottom > top) return;
      out.push({ ...x, source_type: type, source_id: x.id, timeframe: tf, side, bottom, top,
        confirmed_at: x.confirmed_at ?? x.confirmedAt ?? x.time });
    };
    for (const x of s.swings ?? []) add(x, x.kind, x.kind === 'swing_low' ? 1 : -1, x.price - .1 * atr, x.price + .1 * atr);
    for (const [items, type] of [[s.obs, 'OB'], [s.fvgs, 'FVG']]) for (const x of items ?? []) {
      const side = String(x.side).toUpperCase();
      if (['BULLISH', 'LONG', 'BEARISH', 'SHORT'].includes(side)) add(x, type, ['BULLISH', 'LONG'].includes(side) ? 1 : -1, x.bottom, x.top);
    }
    for (const x of s.eqhEql ?? []) add(x, x.kind, x.kind === 'EQL' ? 1 : -1, x.price - .1 * atr, x.price + .1 * atr);
    for (const x of s.prevDWM ?? []) add(x, `prev_${x.granularity}_${x.kind}`, x.kind === 'low' ? 1 : -1, x.price, x.price);
    const pd = s.pdBoundary;
    if (pd) {
      add(pd, 'discount', 1, pd.discountBottom, pd.discountTop ?? pd.discountBottom);
      add(pd, 'premium', -1, pd.premiumBottom ?? pd.premiumTop, pd.premiumTop);
    }
    return out;
  };
  const all = candidates(structures, timeframe);
  const htf = htfLevels.symbol === symbol && htfLevels.timeframe === HIGHER_TIMEFRAME[timeframe]
    ? candidates(htfLevels, htfLevels.timeframe) : [];
  const overlaps = (a, b) => a.bottom <= b.top && b.bottom <= a.top;
  const refs = all.filter(x => x.side === d && x.top - x.bottom <= 3 * atr &&
    (d === 1 ? x.top <= entry + .25 * atr : x.bottom >= entry - .25 * atr));
  const score = x => {
    const confluences = refs.filter(y => y !== x && overlaps(x, y)).map(y => ({ source_id: y.source_id, weight: 1 }));
    for (const y of htf.filter(y => overlaps(x, y))) confluences.push({ source_id: y.source_id, timeframe: y.timeframe, weight: 1.5 });
    const pd = structures.pdBoundary;
    if (pd && valid(pd, timeframe) && (d === 1 ? x.top <= pd.discountTop : x.bottom >= pd.premiumBottom)) confluences.push({ source_id: pd.id, reason: d === 1 ? 'discount-side' : 'premium-side', weight: .5 });
    return { ...x, score: 1 + confluences.reduce((n, c) => n + c.weight, 0), confluences };
  };
  refs.sort((a, b) => score(b).score - score(a).score || Math.abs(entry - (d === 1 ? a.top : a.bottom)) - Math.abs(entry - (d === 1 ? b.top : b.bottom)) || a.source_id.localeCompare(b.source_id));
  if (!refs.length) return reject('NO_REFERENCE');
  const chosen = score(refs[0]), edge = d === 1 ? chosen.bottom : chosen.top;
  const anchors = [{ price: chosen.price ?? edge, id: chosen.source_id, reason: chosen.source_type }];
  for (const x of all.filter(x => x.source_type === (d === 1 ? 'swing_low' : 'swing_high'))) {
    if (d * (x.price - edge) >= 0 && d * (x.price - edge) <= atr) anchors.push({ price: x.price, id: x.source_id, reason: 'confirmed ' + x.source_type });
  }
  anchors.sort((a, b) => d * (a.price - b.price));
  const anchor = anchors[0], buffer = Math.max(2 * tick, .25 * atr);
  const sl = { price: anchor.price - d * buffer, reason: `${d === 1 ? 'below' : 'above'} ${chosen.source_type} ${timeframe ?? ''}${anchors.length > 1 ? ' + confirmed swing' : ''}`,
    anchor_id: anchor.id, anchor_price: anchor.price, buffer };
  if (d * (entry - sl.price) <= 0) return reject('SL_INVALID');
  const resistance = all.filter(x => x.side === -d).map(x => ({ ...score(x),
    targetPrice: x.price ?? (d === 1 ? x.top : x.bottom) })).filter(x => d * (x.targetPrice - entry) > 0)
    .sort((a, b) => b.score - a.score || d * (a.targetPrice - b.targetPrice) || a.source_id.localeCompare(b.source_id));
  const deduped = [];
  for (const x of resistance) if (!deduped.some(y => Math.abs(x.targetPrice - y.targetPrice) < .25 * atr)) deduped.push(x);
  deduped.sort((a, b) => d * (a.targetPrice - b.targetPrice));
  const targets = [];
  for (const x of deduped) {
    if (!targets.length ? d * (x.targetPrice - entry) < Math.max(.5 * atr, 3 * tick) : d * (x.targetPrice - targets.at(-1).price) <= .25 * atr) continue;
    targets.push({ level: targets.length + 1, price: x.targetPrice, reason: `${x.source_type} ${timeframe ?? ''}`, anchor_id: x.source_id, anchor_price: x.targetPrice });
    if (targets.length === 3) break;
  }
  if (!targets.length) {
    // Matrix B's specific diagnostic: a real but too-close resistance also fails RR.
    // It remains excluded and is never emitted or moved to satisfy either gate.
    if (deduped.length && d * (deduped[0].targetPrice - entry) / (d * (entry - sl.price)) < 1) return reject('RR_LOW');
    return reject('NO_TARGET');
  }
  const rr = Object.fromEntries(targets.map(t => [`tp${t.level}`, d * (t.price - entry) / (d * (entry - sl.price))]));
  if (rr.tp1 < 1) return reject('RR_LOW');
  const reference = { source_type: chosen.source_type, source_id: chosen.source_id, timeframe,
    top: chosen.top, bottom: chosen.bottom, price: (chosen.top + chosen.bottom) / 2,
    confirmed_at: chosen.confirmed_at, score: chosen.score, confluences: chosen.confluences,
    reason: `${chosen.source_type} ${timeframe ?? ''}`, anchor_id: chosen.source_id };
  return { accepted: true, reference, sl, targets, rr };
}
