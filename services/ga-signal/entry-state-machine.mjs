// Offline-only diagnostic mirror of resolveLevels; parity is checked during replay.
import { HIGHER_TIMEFRAME } from './level-engine.mjs';

export const POLICIES = Object.freeze(['BASELINE', 'TRIAL-004', 'SHADOW-RR08', 'SHADOW-FAR']);
const freezeTree = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
};

// Explicit named categories outrank the generic "not tied to BOS" rule.
// Swing influence is measured from the origin pivot to the broken structure level.
export function significance(level, atr, timeframe) {
  if (level.timeframe === HIGHER_TIMEFRAME[timeframe] || /^prev_/.test(level.source_type)) return 'EXTERNAL';
  if (['EQH', 'EQL', 'premium', 'discount'].includes(level.source_type)) return 'SIGNIFICANT';
  if (['OB', 'FVG'].includes(level.source_type)) return level.top - level.bottom >= .5 * atr ? 'SIGNIFICANT' : 'INTERNAL';
  return level.structure_event && level.influence_range >= 1.5 * atr ? 'SIGNIFICANT' : 'INTERNAL';
}

export function targetInventory({ structures, htfLevels = {}, direction, atr14: atr, params }) {
  const d = direction === 'LONG' ? 1 : -1, all = [];
  const add = (x, type, side, price, tf) => {
    const confirmed = x.confirmed_at ?? x.confirmedAt;
    if (!x.id || x.mitigated || x.filled || x.confirmed === false ||
        (x.status && x.status !== 'CONFIRMED') || !Number.isFinite(confirmed) || confirmed > params.signalTime ||
        (x.symbol && x.symbol !== params.symbol) || (x.timeframe && x.timeframe !== tf) || !Number.isFinite(price)) return;
    if (side !== -d) return;
    const item = { ...x, price, source_type: type, timeframe: tf, confirmed_at: confirmed,
      anchor_id: x.id, anchor_price: price, reason: `${type} ${tf}` };
    if (item.structure_event && (!Number.isFinite(item.structure_confirmed_at) || item.structure_confirmed_at > params.signalTime)) delete item.structure_event;
    item.significance = significance(item, atr, params.timeframe);
    all.push(item);
  };
  const collect = (s, tf) => {
    for (const x of s.swings ?? []) add(x, x.kind, x.kind === 'swing_low' ? 1 : -1, x.price, tf);
    for (const [xs, type] of [[s.obs, 'OB'], [s.fvgs, 'FVG']]) for (const x of xs ?? []) {
      const side = String(x.side).toUpperCase();
      if (!['BULLISH', 'LONG', 'BEARISH', 'SHORT'].includes(side)) continue;
      add(x, type, ['BULLISH', 'LONG'].includes(side) ? 1 : -1, d === 1 ? x.top : x.bottom, tf);
    }
    for (const x of s.eqhEql ?? []) add(x, x.kind, x.kind === 'EQL' ? 1 : -1, x.price, tf);
    for (const x of s.prevDWM ?? []) add(x, `prev_${x.granularity}_${x.kind}`, x.kind === 'low' ? 1 : -1, x.price, tf);
    if (s.pdBoundary) {
      add(s.pdBoundary, 'premium', -1, s.pdBoundary.premiumTop, tf);
      add(s.pdBoundary, 'discount', 1, s.pdBoundary.discountBottom, tf);
    }
  };
  collect(structures, params.timeframe);
  if (htfLevels.symbol === params.symbol && htfLevels.timeframe === HIGHER_TIMEFRAME[params.timeframe]) collect(htfLevels, htfLevels.timeframe);
  return all.sort((a, b) => d * (a.price - b.price) || a.anchor_id.localeCompare(b.anchor_id));
}

export function armSetup(input) {
  const scan = inspectLevels(input);
  if (!scan.reference || !scan.sl || ['SL_INVALID', 'INVALID_INPUT', 'SERIES_MISMATCH'].includes(scan.reason)) return { state: 'IDLE', reason: scan.reason, accepted: false };
  const d = input.direction === 'LONG' ? 1 : -1;
  const inventory = targetInventory(input), targets = [];
  for (const t of inventory.filter(t => t.significance !== 'INTERNAL')) {
    if (d * (t.price - input.entry) < Math.max(.5 * input.atr14, 3 * input.tick) ||
        (targets.length && d * (t.price - targets.at(-1).price) <= .25 * input.atr14)) continue;
    targets.push({ ...t, level: targets.length + 1 });
    if (targets.length === 3) break;
  }
  return freezeTree(structuredClone({ state: 'ARMED', direction: input.direction, symbol: input.params.symbol,
    timeframe: input.params.timeframe, reference: scan.reference, sl: scan.sl, targets, inventory,
    armed_at: input.params.signalTime, armed_price: input.entry, atr: input.atr14, tick: input.tick,
    elapsed_bars: 0, last_closed_at: input.params.signalTime, retested_at: null }));
}

export function targetCandidateReceipt(target, rr) {
  return { price: target.price, source_type: target.source_type, timeframe: target.timeframe,
    anchor_id: target.anchor_id, confirmed_at: target.confirmed_at, significance: target.significance,
    structure_event: target.structure_event ?? null, structure_confirmed_at: target.structure_confirmed_at ?? null,
    influence_range: target.influence_range ?? null, top: target.top ?? null, bottom: target.bottom ?? null, rr };
}

export function entryReceipt(setup, entry, policy = 'TRIAL-004') {
  if (!POLICIES.slice(1).includes(policy)) throw new RangeError('Unknown trial policy');
  const d = setup.direction === 'LONG' ? 1 : -1, risk = d * (entry - setup.sl.price);
  const rrOf = t => d * (t.price - entry) / risk;
  let targets = setup.targets.map(t => ({ ...t }));
  let skipped_nearest = null;
  if (policy === 'SHADOW-FAR' && targets.length > 1 && rrOf(targets[0]) < 1 && rrOf(targets[1]) >= 1) {
    skipped_nearest = targets.shift();
    targets = targets.map((t, i) => ({ ...t, level: i + 1 }));
  }
  const internal = setup.inventory.filter(t => t.significance === 'INTERNAL' && d * (t.price - entry) > 0 &&
    targets.length && d * (targets[0].price - t.price) > 0);
  const nearby = internal[0];
  const rr = Object.fromEntries(targets.map(t => [`tp${t.level}`, rrOf(t)]));
  const receipt = { entry, reference: setup.reference, sl: setup.sl, targets, rr, risk,
    rr_gross: rr.tp1 ?? null, rr_net_of_internal: nearby ? Math.min(rr.tp1, rrOf(nearby)) : rr.tp1 ?? null,
    nearby_obstacle: nearby ? { price: nearby.price, type: nearby.source_type,
      distance_atr: Math.abs(nearby.price - entry) / setup.atr, confirmed_at: nearby.confirmed_at } : null,
    // All eligible significant/external price candidates remain auditable, including
    // farther alternatives and a shadow-skipped nearest level. Internal risk stays
    // in nearby_obstacle; levels behind entry are not target candidates.
    tp_candidates: setup.inventory.filter(t => t.significance !== 'INTERNAL' && d * (t.price-entry) > 0)
      .map(t => targetCandidateReceipt(t, rrOf(t))), skipped_nearest,
    armed_at: setup.armed_at, armed_price: setup.armed_price, atr: setup.atr, policy };
  const reason = risk <= 0 ? 'SL_INVALID' : !targets.length || d * (targets[0].price - entry) < Math.max(.5 * setup.atr, 3 * setup.tick)
    ? 'NO_TARGET' : rr.tp1 < (policy === 'SHADOW-RR08' ? .8 : 1) ? 'RR_LOW' : null;
  return { ...receipt, accepted: !reason, reason };
}

// Pure reducer. One slot per symbol/timeframe/direction; callers route variants to the same slot.
// Retest requires the extremum IN the zone (a wick through its far edge is not a retest).
// After a retest, confirmation still requires a touching candle to close on the trend side.
export function transition(state = { state: 'IDLE' }, { trigger, candle, closed_at, policy = 'TRIAL-004', retestTimeoutBars = 24 } = {}) {
  if (!Number.isInteger(retestTimeoutBars) || retestTimeoutBars < 1) throw new RangeError('Invalid timeout');
  const active = ['ARMED', 'RETESTED'].includes(state.state);
  if (trigger) {
    if (active) return { ...state, event: 'TRIGGER_WHILE_ARMED' };
    const next = armSetup(trigger);
    return { ...next, event: next.state === 'ARMED' ? 'ARMED' : next.reason };
  }
  if (!active || !candle || candle.closed === false) return { ...state };
  if (!Number.isFinite(closed_at)) throw new TypeError('Explicit closed_at is required');
  if (closed_at <= state.last_closed_at) return { ...state };
  // Frozen arm-time structures can be shared by successive immutable states.
  const next = { ...state, elapsed_bars: state.elapsed_bars + 1, last_closed_at: closed_at, event: null };
  const long = state.direction === 'LONG';
  if (long ? candle.close < state.sl.price : candle.close > state.sl.price) return { ...next, state: 'INVALIDATED', event: 'INVALIDATED' };
  const extreme = long ? candle.low : candle.high;
  const touched = extreme >= state.reference.bottom && extreme <= state.reference.top;
  if (touched) {
    next.state = 'RETESTED'; next.retested_at ??= closed_at; next.event = 'RETESTED';
    if (long ? candle.close > state.reference.top : candle.close < state.reference.bottom) {
      return { ...next, state: 'CONFIRMED', event: 'CONFIRMED', confirmed_at: closed_at,
        receipt: entryReceipt(next, candle.close, policy) };
    }
  }
  if (!next.retested_at && next.elapsed_bars >= retestTimeoutBars) return { ...next, state: 'EXPIRED', event: 'EXPIRED' };
  return next;
}

export function inspectLevels({ direction, entry, atr14: atr, tick, structures = {}, htfLevels = {}, params = {} }) {
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
  // Interval counts preserve the exact overlap score without allocating every
  // candidate's confluence list during sort. Only the chosen receipt needs that list.
  const boundaries = xs => ({ starts: xs.map(x=>x.bottom).sort((a,b)=>a-b), ends: xs.map(x=>x.top).sort((a,b)=>a-b) });
  const refBounds=boundaries(refs), htfBounds=boundaries(htf), refSet=new Set(refs);
  const bound = (xs,value,inclusive) => { let lo=0,hi=xs.length; while(lo<hi) { const mid=(lo+hi)>>>1;
    if(inclusive ? xs[mid]<=value : xs[mid]<value)lo=mid+1;else hi=mid; } return lo; };
  const countOverlap = (bounds,x) => bound(bounds.starts,x.top,true)-bound(bounds.ends,x.bottom,false);
  const score = (x, details = false) => {
    const pd = structures.pdBoundary;
    const pdBonus = pd && valid(pd,timeframe) && (d===1 ? x.top<=pd.discountTop : x.bottom>=pd.premiumBottom) ? .5 : 0;
    if(!details) return { ...x, score:1+countOverlap(refBounds,x)-(refSet.has(x)?1:0)+1.5*countOverlap(htfBounds,x)+pdBonus };
    const confluences = refs.filter(y => y !== x && overlaps(x, y)).map(y => ({ source_id: y.source_id, weight: 1 }));
    for (const y of htf.filter(y => overlaps(x, y))) confluences.push({ source_id: y.source_id, timeframe: y.timeframe, weight: 1.5 });
    if (pd && valid(pd, timeframe) && (d === 1 ? x.top <= pd.discountTop : x.bottom >= pd.premiumBottom)) confluences.push({ source_id: pd.id, reason: d === 1 ? 'discount-side' : 'premium-side', weight: .5 });
    return { ...x, score: 1 + confluences.reduce((n, c) => n + c.weight, 0), confluences };
  };
  refs.sort((a, b) => score(b).score - score(a).score || Math.abs(entry - (d === 1 ? a.top : a.bottom)) - Math.abs(entry - (d === 1 ? b.top : b.bottom)) || a.source_id.localeCompare(b.source_id));
  if (!refs.length) return reject('NO_REFERENCE');
  const chosen = score(refs[0],true), edge = d === 1 ? chosen.bottom : chosen.top;
  const anchors = [{ price: chosen.price ?? edge, id: chosen.source_id, reason: chosen.source_type }];
  for (const x of all.filter(x => x.source_type === (d === 1 ? 'swing_low' : 'swing_high'))) {
    if (d * (x.price - edge) >= 0 && d * (x.price - edge) <= atr) anchors.push({ price: x.price, id: x.source_id, reason: 'confirmed ' + x.source_type });
  }
  anchors.sort((a, b) => d * (a.price - b.price));
  const anchor = anchors[0], buffer = Math.max(2 * tick, .25 * atr);
  const sl = { price: anchor.price - d * buffer, reason: `${d === 1 ? 'below' : 'above'} ${chosen.source_type} ${timeframe ?? ''}${anchors.length > 1 ? ' + confirmed swing' : ''}`,
    anchor_id: anchor.id, anchor_price: anchor.price, buffer };
  if (d * (entry - sl.price) <= 0) return { ...reject('SL_INVALID'), reference: chosen, sl };
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
  const reference = { ...chosen, price: (chosen.top + chosen.bottom) / 2, anchor_id: chosen.source_id,
    reason: `${chosen.source_type} ${timeframe ?? ''}` };
  const risk = d * (entry - sl.price);
  const tp_candidates = resistance.map(x => ({ ...x, price: x.targetPrice, rr: d * (x.targetPrice - entry) / risk, anchor_id: x.source_id }));
  const nearest_obstacle = [...tp_candidates].sort((a,b) => d * (a.price-b.price))[0] ?? null;
  const diagnostics = { reference, sl, targets, risk, tp_candidates, nearest_obstacle,
    distance_trigger_zone_atr: Math.max(reference.bottom-entry, entry-reference.top, 0) / atr };
  if (!targets.length) {
    // Matrix B's specific diagnostic: a real but too-close resistance also fails RR.
    // It remains excluded and is never emitted or moved to satisfy either gate.
    if (deduped.length && d * (deduped[0].targetPrice - entry) / (d * (entry - sl.price)) < 1) return { ...reject('RR_LOW'), ...diagnostics };
    return { ...reject('NO_TARGET'), ...diagnostics };
  }
  const rr = Object.fromEntries(targets.map(t => [`tp${t.level}`, d * (t.price - entry) / (d * (entry - sl.price))]));
  if (rr.tp1 < 1) return { ...reject('RR_LOW'), ...diagnostics, rr };
  return { accepted: true, ...diagnostics, rr };

}
