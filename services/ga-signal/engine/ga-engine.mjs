// Locked design defaults. Tick has no default; the caller supplies symbol metadata.
export const DEFAULT_PARAMS = Object.freeze({
  emaFast: 20, emaSlow: 50, emaTrend: 200, atrPeriod: 14, adxPeriod: 14,
  adxThreshold: 20, pullbackWindow: 8, rangeWindow: 20, retestWindow: 8,
  slAtrMultiplier: 0.5, breakoutAtrBuffer: 0.05,
  tpMultiples: Object.freeze([1, 2, 3]),
  expiryBars: Object.freeze({ A: 36, B: 36, C: 24 }),
});

// Private equivalents of indicators.mjs keep this entry point import-free.
function indicators(candles, p) {
  const ema = n => {
    let sum = 0, value = null;
    return candles.map((c, i) => {
      if (i < n) sum += c.close;
      if (i === n - 1) value = sum / n;
      else if (i >= n) value += 2 / (n + 1) * (c.close - value);
      return value;
    });
  };
  let atrSum = 0, atrValue = null, trSum = 0, plusSum = 0, minusSum = 0;
  let dxSum = 0, adxValue = null;
  const volatility = [], strength = [], n = p.adxPeriod;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    const tr = prev ? Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)) : c.high - c.low;
    if (i < p.atrPeriod) atrSum += tr;
    if (i === p.atrPeriod - 1) atrValue = atrSum / p.atrPeriod;
    else if (i >= p.atrPeriod) atrValue = (atrValue * (p.atrPeriod - 1) + tr) / p.atrPeriod;
    volatility.push(atrValue);
    if (prev) {
      const up = c.high - prev.high, down = prev.low - c.low;
      const plus = up > 0 && up > down ? up : 0, minus = down > 0 && down > up ? down : 0;
      if (i <= n) { trSum += tr; plusSum += plus; minusSum += minus; }
      else { trSum += tr - trSum / n; plusSum += plus - plusSum / n; minusSum += minus - minusSum / n; }
      if (i >= n) {
        const plusDI = trSum ? 100 * plusSum / trSum : 0, minusDI = trSum ? 100 * minusSum / trSum : 0;
        const total = plusDI + minusDI, dx = total ? 100 * Math.abs(plusDI - minusDI) / total : 0;
        if (i < 2 * n) dxSum += dx;
        if (i === 2 * n - 1) adxValue = dxSum / n;
        else if (i >= 2 * n) adxValue = (adxValue * (n - 1) + dx) / n;
      }
    }
    strength.push(adxValue);
  }
  return { fast: ema(p.emaFast), slow: ema(p.emaSlow), trend: ema(p.emaTrend), volatility, strength };
}

export function runEngine({ candles, symbol, timeframe, variant, params = {} }) {
  if (!['A', 'B', 'C'].includes(variant)) throw new RangeError('variant must be A, B or C');
  if (!Number.isFinite(params.tick) || params.tick <= 0) throw new RangeError('params.tick must be positive');
  const p = { ...DEFAULT_PARAMS, ...params };
  const expiry = typeof p.expiryBars === 'number' ? p.expiryBars : p.expiryBars?.[variant];
  for (const n of [p.emaFast, p.emaSlow, p.emaTrend, p.atrPeriod, p.adxPeriod, p.pullbackWindow, p.rangeWindow, p.retestWindow, expiry]) {
    if (!Number.isInteger(n) || n < 1) throw new RangeError('periods and windows must be positive integers');
  }
  for (const n of [p.adxThreshold, p.slAtrMultiplier, p.breakoutAtrBuffer]) {
    if (!Number.isFinite(n) || n < 0) throw new RangeError('indicator thresholds must be nonnegative');
  }
  if (!Array.isArray(p.tpMultiples) || p.tpMultiples.length !== 3 || p.tpMultiples.some((n, i) => !Number.isFinite(n) || n <= (i ? p.tpMultiples[i - 1] : 0))) {
    throw new RangeError('tpMultiples must contain three increasing positive values');
  }
  // Caller verifies closed candles and handles DATA_GAP/reloads. Never truncate
  // here: a rolling slice would break prefix replay. Validate continuity as well.
  const tf = /^(\d+)([mhdw])$/.exec(timeframe);
  const step = tf ? Number(tf[1]) * ({ m: 60, h: 3600, d: 86400, w: 604800 })[tf[2]] : null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (![c.time, c.open, c.high, c.low, c.close].every(Number.isFinite) || c.low > Math.min(c.open, c.close) || c.high < Math.max(c.open, c.close)) {
      throw new TypeError('invalid candle');
    }
    if (i && c.time <= candles[i - 1].time) throw new RangeError('candle times must increase strictly');
    if (i && step && c.time - candles[i - 1].time !== step) throw new RangeError('DATA_GAP');
  }
  const { fast, slow, trend, volatility, strength } = indicators(candles, p);
  const events = [];
  let active = null, pending = null;
  const trendAt = i => slow[i] === null || trend[i] === null ? 0
    : candles[i].close > slow[i] && slow[i] > trend[i] ? 1
    : candles[i].close < slow[i] && slow[i] < trend[i] ? -1 : 0;
  const qualified = i => variant !== 'B' || (strength[i] !== null && strength[i] >= p.adxThreshold);
  function emit(type, i, price, ambiguous = false) {
    const setup = active.setup, time = candles[i].time;
    events.push({
      setup_id: `GA-${variant}-${symbol}-${timeframe}-${setup.signal_time}`,
      seq: events.length + 1, type, variant, symbol, timeframe, side: setup.side,
      time, candle_time: time, price,
      setup: { ...setup, zone: setup.zone ? { ...setup.zone } : null, reasons: [...setup.reasons] },
      ambiguous,
    });
  }
  function create(i, d, sl, zone, level, reasons) {
    const entry_ref = candles[i].close, r_ref = d * (entry_ref - sl);
    if (!Number.isFinite(r_ref) || r_ref <= 0) return;
    const [tp1, tp2, tp3] = p.tpMultiples.map(r => entry_ref + d * r * r_ref);
    active = { i, d, level, hits: 0, setup: {
      signal_time: candles[i].time, side: d === 1 ? 'LONG' : 'SHORT',
      entry_ref, sl, tp1, tp2, tp3, r_ref, zone, reasons,
    } };
    emit('SETUP_CREATED', i, entry_ref);
  }
  // Warm-up is engine-owned: the first `warmupBars` bars (default 250) calculate indicators only.
  // params.warmup=false disables that head room for callers that pre-warm differently.
  // params.flatStart (seconds) starts setup state FLAT at that candle: earlier bars only warm the
  // indicators (used by the OOS segment so pre-boundary setups cannot leak across the split).
  const start = params.warmup === false ? 0 : (params.warmupBars ?? 250);
  const flatStart = Number.isFinite(params.flatStart) ? params.flatStart : null;
  let flattened = flatStart === null;
  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    if (!flattened) { // bars before flatStart only warm the indicators; state starts flat there
      if (c.time < flatStart) continue;
      flattened = true; active = null; pending = null;
    }
    const direction = trendAt(i);
    if (active) {
      const { d, setup, hits } = active;
      const targets = [setup.tp1, setup.tp2, setup.tp3];
      const stopped = d === 1 ? c.low <= setup.sl : c.high >= setup.sl;
      const reached = price => d === 1 ? c.high >= price : c.low <= price;
      if (stopped) {
        // Only unfilled targets create ambiguity for the remaining position.
        emit('SL_HIT', i, setup.sl, targets.slice(hits).some(reached));
        active = null;
      } else {
        for (let t = hits; t < 3 && reached(targets[t]); t++) {
          emit(`TP${t + 1}_HIT`, i, targets[t]);
          active.hits = t + 1;
        }
        if (active.hits === 3) active = null;
        else {
          const invalid = variant === 'C' ? active.hits === 0 && d * (c.close - active.level) < 0 : direction !== d;
          // A/B timeout applies only before TP1; C timeout is unconditional.
          const timeout = i - active.i >= expiry && (variant === 'C' || active.hits === 0);
          if (invalid || timeout) { emit('EXPIRED', i, c.close); active = null; }
        }
      }
      // No new setup on the same candle as a terminal event; no queued touches
      // or breakouts while occupied. A fresh candidate is required after exit.
      pending = null;
      continue;
    }
    if (volatility[i] === null) continue;
    if (variant === 'C') {
      if (i < p.rangeWindow || volatility[i - 1] == null) continue;
      let hi = -Infinity, lo = Infinity;
      for (let j = i - p.rangeWindow; j < i; j++) { hi = Math.max(hi, candles[j].high); lo = Math.min(lo, candles[j].low); }
      const buffer = Math.max(p.tick, p.breakoutAtrBuffer * volatility[i - 1]);
      const d = c.close > hi + buffer ? 1 : c.close < lo - buffer ? -1 : 0;
      // Replacement precedes retest: this candle cannot retest its own breakout.
      if (d) { pending = { i, d, level: d === 1 ? hi : lo }; continue; }
      if (!pending) continue;
      if (i - pending.i > p.retestWindow || pending.d * (c.close - pending.level) < 0) { pending = null; continue; }
      const q = pending;
      if (q.d === 1 ? c.low <= q.level : c.high >= q.level) {
        pending = null;
        const sl = (q.d === 1 ? c.low : c.high) - q.d * p.slAtrMultiplier * volatility[i];
        create(i, q.d, sl, null, q.level, ['Prior closed range breakout with buffered close', 'Frozen breakout level held', 'First qualifying retest within window']);
      }
      continue;
    }
    if (!direction) { pending = null; continue; }
    if (pending && (pending.d !== direction || i - pending.i > p.pullbackWindow)) pending = null;
    // Confirm the latest prior touch before considering this candle as a touch.
    if (pending && qualified(i) && direction * c.close > pending.extreme + p.tick) {
      const q = pending;
      pending = null;
      const sl = direction === 1 ? Math.min(q.low, q.zone.lo) - p.slAtrMultiplier * volatility[i]
        : Math.max(q.high, q.zone.hi) + p.slAtrMultiplier * volatility[i];
      const reasons = ['EMA trend aligned', 'Candle intersects EMA zone and closes on trend side', 'Latest unused touch', 'Close breaks all prior pullback extremes within window'];
      if (variant === 'B') reasons.push('ADX-qualified at touch and confirmation');
      create(i, direction, sl, q.zone, null, reasons);
      continue;
    }
    if (pending) {
      pending.extreme = Math.max(pending.extreme, direction === 1 ? c.high : -c.low);
      pending.low = Math.min(pending.low, c.low);
      pending.high = Math.max(pending.high, c.high);
    }
    if (fast[i] === null || slow[i] === null) continue;
    const lo = Math.min(fast[i], slow[i]), hi = Math.max(fast[i], slow[i]);
    if (c.low <= hi && c.high >= lo && (direction === 1 ? c.close > lo : c.close < hi)) {
      // An unqualified newer touch also supersedes an older B candidate.
      pending = qualified(i) ? { i, d: direction, zone: { lo, hi, time: c.time },
        extreme: direction === 1 ? c.high : -c.low, low: c.low, high: c.high } : null;
    }
  }
  // OPEN_AT_END is simulator bookkeeping, not a historical engine event.
  return { events };
}
