import { PivotEngine, stableId } from './pivot-engine.mjs';
export class StructureEngine {
  constructor({ N = 5, mode = 'close', breakMode = mode, levelIndex = N } = {}) {
    if (!['close', 'wick'].includes(breakMode)) throw new RangeError('Supported break modes: close, wick');
    this.options = { N, levelIndex }; this.breakMode = breakMode; this.reset();
  }
  reset() {
    this.pivotEngine = new PivotEngine(this.options); this.events = []; this.trend = 'UNKNOWN';
    this.high = this.low = this.strong = this.weak = null; this.broken = new Set(); this.live = []; this.last = null;
  }
  breaks(bar, live = false) {
    const output = [], previousTrend = this.trend;
    for (const [pivot, side] of [[this.high, 'BULLISH'], [this.low, 'BEARISH']]) {
      if (!pivot || this.broken.has(pivot.event_id)) continue;
      const up = side === 'BULLISH', wick = live || this.breakMode === 'wick';
      const price = wick ? (up ? bar.high : bar.low) : bar.close;
      if (!(up ? (wick ? price >= pivot.price : price > pivot.price) : (wick ? price <= pivot.price : price < pivot.price))) continue;
      const type = previousTrend !== 'UNKNOWN' && previousTrend !== side ? 'CHOCH' : 'BOS';
      output.push(Object.freeze({ type, side, price: pivot.price, pivotTime: pivot.time, time: bar.time,
        status: live ? 'PROVISIONAL' : 'CONFIRMED', confirmedAt: live ? null : bar.closedAt ?? bar.time,
        event_id: stableId(type, side, pivot.event_id, bar.time) }));
      // A closed outside bar in wick mode uses high then low as deterministic order.
      if (!live) { this.broken.add(pivot.event_id); this.trend = side; }
    }
    return output;
  }
  update(bar, { closed = bar.closed !== false } = {}) {
    if (this.last && bar.time <= this.last.time) {
      if (bar.time === this.last.time && ['open', 'high', 'low', 'close'].every(k => bar[k] === this.last[k])) return this.snapshot();
      throw new Error('Cannot revise a confirmed bar');
    }
    if (!closed) { this.live = this.breaks(bar, true); return this.snapshot(); }
    const changes = this.pivotEngine.update(bar);
    for (const p of changes) if (p.status === 'CONFIRMED') {
      if (p.type === 'PIVOT_HIGH') this.high = p; else this.low = p;
    }
    this.events.push(...this.breaks(bar)); this.live = []; this.last = { ...bar };
    const anchor = this.trend === 'BULLISH' ? this.low : this.trend === 'BEARISH' ? this.high : null;
    if (anchor) {
      const up = this.trend === 'BULLISH', key = up ? 'high' : 'low';
      const rows = this.strong?.event_id !== anchor.event_id || this.anchorTrend !== this.trend ? this.pivotEngine.bars.slice(anchor.barIndex) : [bar];
      if (rows.length > 1 || !this.weak || this.anchorTrend !== this.trend || this.strong?.event_id !== anchor.event_id) this.weak = null;
      for (const row of rows) if (!this.weak || (up ? row[key] > this.weak.price : row[key] < this.weak.price)) this.weak = Object.freeze({ time: row.time, price: row[key], status: 'CONFIRMED' });
      this.strong = anchor; this.anchorTrend = this.trend;
    }
    return this.snapshot();
  }
  setData(candles, liveBar = null) { this.reset(); for (const bar of candles) this.update(bar); if (liveBar) this.update(liveBar, { closed: false }); return this.snapshot(); }
  snapshot() { return { trend: this.trend, high: this.high, low: this.low, strong: this.strong, weak: this.weak, pivots: this.pivotEngine.snapshot(), events: [...this.events, ...this.live] }; }
}
export function computeStructure(candles, options = {}, liveBar = null) { return new StructureEngine(options).setData(candles, liveBar); }
