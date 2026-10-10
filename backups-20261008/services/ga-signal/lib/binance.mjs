// LAB Binance SPOT REST client — closure-verified candles with gap detection.
// Same public endpoints as the verified production feed (GA-TRADE-CHART js/market/binance-public-provider.mjs:3,6).
const BASE = 'https://api.binance.com/api/v3/klines';
const STEP_SECONDS = Object.freeze({ '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 });

export const stepOf = timeframe => {
  const step = STEP_SECONDS[timeframe];
  if (!step) throw new RangeError(`Unsupported timeframe: ${timeframe}`);
  return step;
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function requestKlines({ symbol, timeframe, limit = 1000, endTime }) {
  const params = new URLSearchParams({ symbol, interval: timeframe, limit: String(Math.min(1000, limit)) });
  if (endTime != null) params.set('endTime', String(endTime));
  for (let attempt = 0; attempt < 5; attempt++) {
    let response;
    try { response = await fetch(`${BASE}?${params}`); }
    catch { await sleep(2000 * (attempt + 1)); continue; }
    if (response.status === 429 || response.status === 418) { await sleep(30000); continue; }
    if (!response.ok) throw new Error(`Binance HTTP ${response.status}`);
    return response.json();
  }
  throw new Error(`Binance unreachable: ${symbol} ${timeframe}`);
}

// Returns { rows, closedCount } — rows keep [openTimeMs, o,h,l,c,v, closeTimeMs, ...] raw,
// filtered to candles whose close time has fully passed `nowMs` (explicit closure verification).
export async function fetchRawCandles({ symbol, timeframe, limit = 600, nowMs = Date.now() }) {
  const raw = await requestKlines({ symbol, timeframe, limit, endTime: nowMs - 1 });
  if (!Array.isArray(raw)) throw new Error('Binance: non-array payload');
  const rows = raw.filter(row => Number(row[6]) + 1 <= nowMs);
  return { rows, closedCount: rows.length };
}

// Normalized closed candle + closure metadata; throws on malformed rows.
export function toCandle(row) {
  const [openTime, o, h, l, c, v, closeTime] = row;
  const candle = { time: openTime / 1000, open: Number(o), high: Number(h), low: Number(l), close: Number(c), volume: Number(v) };
  for (const value of [candle.open, candle.high, candle.low, candle.close, candle.volume]) if (!Number.isFinite(value)) throw new TypeError('Malformed kline');
  if (!(candle.high >= Math.max(candle.open, candle.close)) || !(candle.low <= Math.min(candle.open, candle.close))) throw new RangeError('Invalid OHLC');
  return { ...candle, close_time: closeTime / 1000 };
}

// Fetch the last `window` CLOSED candles with gap detection over contiguous steps.
// Returns { candles, gaps: [{from,to}] } sorted oldest-first.
export async function fetchClosedWindow({ symbol, timeframe, window = 600, nowMs = Date.now() }) {
  const step = stepOf(timeframe);
  const { rows } = await fetchRawCandles({ symbol, timeframe, limit: window, nowMs });
  const candles = rows.map(toCandle);
  const gaps = [];
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i].time - candles[i - 1].time;
    if (delta !== step) gaps.push({ from: candles[i - 1].time, to: candles[i].time, missing: delta / step - 1 });
  }
  return { candles, gaps };
}

// Fetch closed candles in [startTime, endTime] (up to 3 paginated requests) for checkpoint catch-up.
export async function fetchRange({ symbol, timeframe, startTime, endTime, nowMs = Date.now() }) {
  const step = stepOf(timeframe);
  const candles = new Map();
  let from = startTime;
  for (let page = 0; page < 3 && from <= endTime; page++) {
    const raw = await requestKlines({ symbol, timeframe, limit: 1000, startTime: from * 1000, endTime: Math.min(endTime, nowMs / 1000 - step) * 1000 });
    if (!Array.isArray(raw) || !raw.length) break;
    for (const row of raw) {
      if (Number(row[6]) + 1 > nowMs) continue; // closure verification
      const candle = toCandle(row);
      candles.set(candle.time, candle);
    }
    const last = Math.max(...[...candles.keys()]);
    if (last + step <= from) break;
    from = last + step;
  }
  return [...candles.values()].sort((a, b) => a.time - b.time);
}
