// Shared input contract: seconds, immutable OHLC, strictly increasing closed bars.
export function acceptBar(bars, bar) {
  if (bar.closed === false) return false;
  if (!['time', 'open', 'high', 'low', 'close'].every(k => Number.isFinite(bar[k])) || bar.high < Math.max(bar.open, bar.close, bar.low) || bar.low > Math.min(bar.open, bar.close)) throw new TypeError('Invalid OHLC bar');
  const last = bars.at(-1);
  if (last && bar.time <= last.time) {
    if (bar.time === last.time && ['open', 'high', 'low', 'close'].every(k => bar[k] === last[k])) return false;
    throw new Error('Closed bars are immutable and must arrive in time order');
  }
  bars.push({ ...bar }); return true;
}
export function positiveInteger(n) { if (!Number.isInteger(n) || n < 1) throw new RangeError('Expected positive integer'); return n; }
export class Volatility {
  constructor(N = 200) { this.N = positiveInteger(N); this.count = 0; this.sum = 0; this.atr = 0; this.previous = null; }
  update(bar) {
    const tr = Math.max(bar.high - bar.low, this.previous === null ? 0 : Math.abs(bar.high - this.previous), this.previous === null ? 0 : Math.abs(bar.low - this.previous));
    this.sum += tr; this.count++;
    this.atr = this.count <= this.N ? this.sum / this.count : (this.atr * (this.N - 1) + tr) / this.N;
    this.previous = bar.close; return { atr: this.atr, mean: this.sum / this.count };
  }
}
