// SMA seeds; Wilder ATR includes the first candle's high-low.
function period(n) {
  if (!Number.isInteger(n) || n < 1) throw new RangeError('period must be a positive integer');
}

export function ema(values, n) {
  period(n);
  const out = Array(values.length).fill(null), alpha = 2 / (n + 1);
  let sum = 0, value = null;
  for (let i = 0; i < values.length; i++) {
    if (i < n) sum += values[i];
    if (i === n - 1) value = sum / n;
    else if (i >= n) value += alpha * (values[i] - value);
    out[i] = value;
  }
  return out;
}

function trueRange(c, prev) {
  return prev ? Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)) : c.high - c.low;
}

export function atr(candles, n) {
  period(n);
  const out = Array(candles.length).fill(null);
  let sum = 0, value = null;
  for (let i = 0; i < candles.length; i++) {
    const tr = trueRange(candles[i], candles[i - 1]);
    if (i < n) sum += tr;
    if (i === n - 1) value = sum / n;
    else if (i >= n) value = (value * (n - 1) + tr) / n;
    out[i] = value;
  }
  return out;
}

export function adx(candles, n) {
  period(n);
  const out = candles.map(() => ({ adx: null, plusDI: null, minusDI: null }));
  // DM needs a preceding candle: first DI at n, first ADX at 2*n-1.
  let trSum = 0, plusSum = 0, minusSum = 0, dxSum = 0, value = null;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    const up = c.high - prev.high, down = prev.low - c.low;
    const plus = up > 0 && up > down ? up : 0;
    const minus = down > 0 && down > up ? down : 0;
    const tr = trueRange(c, prev);
    if (i <= n) { trSum += tr; plusSum += plus; minusSum += minus; }
    else {
      trSum += tr - trSum / n;
      plusSum += plus - plusSum / n;
      minusSum += minus - minusSum / n;
    }
    if (i < n) continue;
    const plusDI = trSum ? 100 * plusSum / trSum : 0;
    const minusDI = trSum ? 100 * minusSum / trSum : 0;
    const total = plusDI + minusDI;
    const dx = total ? 100 * Math.abs(plusDI - minusDI) / total : 0;
    if (i < 2 * n) dxSum += dx;
    if (i === 2 * n - 1) value = dxSum / n;
    else if (i >= 2 * n) value = (value * (n - 1) + dx) / n;
    out[i] = { adx: value, plusDI, minusDI };
  }
  return out;
}
