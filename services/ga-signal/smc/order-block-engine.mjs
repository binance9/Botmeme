import { stableId } from './pivot-engine.mjs';
import { acceptBar, positiveInteger, Volatility } from './closed-bars.mjs';
export class OrderBlockEngine {
  constructor({ filter = 'ATR', atrLength = 200, mitigation = 'HighLow', maxOrderBlocks = 5 } = {}) {
    if (!['ATR', 'cumMean'].includes(filter) || !['Close', 'HighLow'].includes(mitigation)) throw new RangeError('Invalid OB filter or mitigation');
    this.filter = filter; this.atrLength = positiveInteger(atrLength); this.mitigation = mitigation; this.maxOrderBlocks = positiveInteger(maxOrderBlocks); this.reset();
  }
  reset() { this.bars = []; this.parsed = []; this.history = []; this.seen = new Set(); this.volatility = new Volatility(this.atrLength); }
  update(bar, events = []) {
    if (!acceptBar(this.bars, bar)) return this.snapshot();
    const v = this.volatility.update(bar), measure = this.filter === 'ATR' ? v.atr : v.mean;
    // Wide candles have their parsed extremes inverted, matching the OB volatility filter.
    const wide = bar.high - bar.low >= 2 * measure;
    this.parsed.push({ high: wide ? bar.low : bar.high, low: wide ? bar.high : bar.low, time: bar.time });
    this.history = this.history.map(ob => !ob.mitigated && (ob.bias === 'BULLISH' ? (this.mitigation === 'Close' ? bar.close : bar.low) < ob.barLow : (this.mitigation === 'Close' ? bar.close : bar.high) > ob.barHigh) ? Object.freeze({ ...ob, mitigated: true }) : ob);
    for (const e of events) {
      if (e.status !== 'CONFIRMED' || e.time !== bar.time || !['BULLISH', 'BEARISH'].includes(e.side) || (e.confirmedAt != null && e.confirmedAt > (bar.closedAt ?? bar.time))) continue;
      const level = e.level ?? 'SWING', key = stableId(level, e.event_id ?? [e.type, e.side, e.pivotTime, e.time]);
      if (this.seen.has(key)) continue;
      const start = e.pivotBarIndex ?? this.bars.findIndex(b => b.time === e.pivotTime), end = this.bars.length - 1;
      if (!Number.isInteger(start) || start < 0 || start >= end) continue;
      let selected = this.parsed[start];
      for (let i = start + 1; i < end; i++) if (e.side === 'BULLISH' ? this.parsed[i].low < selected.low : this.parsed[i].high > selected.high) selected = this.parsed[i];
      this.seen.add(key);
      this.history.push(Object.freeze({ bias: e.side, barHigh: selected.high, barLow: selected.low, barTime: selected.time, level, mitigated: false, event_id: stableId('OB', key) }));
    }
    return this.snapshot();
  }
  setData(bars, events = []) { this.reset(); for (const b of bars) this.update(b, events); return this.snapshot(); }
  snapshot({ internal = true } = {}) { return this.history.filter(ob => !ob.mitigated && (internal || ob.level !== 'INTERNAL')).slice(-this.maxOrderBlocks); }
}
export const createOrderBlockEngine = options => new OrderBlockEngine(options);
