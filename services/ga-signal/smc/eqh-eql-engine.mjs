import { stableId } from './pivot-engine.mjs';
import { acceptBar, positiveInteger, Volatility } from './closed-bars.mjs';
export class EqualHighLowEngine {
  constructor({ eqhEqlLength = 3, threshold = .1, atrLength = 200 } = {}) {
    this.N = positiveInteger(eqhEqlLength); this.atrLength = positiveInteger(atrLength);
    if (!Number.isFinite(threshold) || threshold < 0) throw new RangeError('Invalid EQ threshold');
    this.threshold = threshold; this.reset();
  }
  reset() { this.bars = []; this.events = []; this.previous = {}; this.volatility = new Volatility(this.atrLength); }
  update(bar) {
    if (!acceptBar(this.bars, bar)) return this.snapshot();
    const { atr } = this.volatility.update(bar), i = this.bars.length - 1 - this.N;
    if (i < this.N) return this.snapshot();
    const candidate = this.bars[i], neighbors = this.bars.slice(i - this.N, i).concat(this.bars.slice(i + 1));
    for (const [type, key] of [['EQH', 'high'], ['EQL', 'low']]) {
      if (!neighbors.every(b => type === 'EQH' ? candidate[key] > b[key] : candidate[key] < b[key])) continue;
      const previous = this.previous[type], level = candidate[key], tolerance = this.threshold * atr;
      if (previous && Math.abs(level - previous[key]) < tolerance && !this.events.some(e => e.type === type && Math.abs(e.level - previous[key]) <= tolerance)) {
        this.events.push(Object.freeze({ type, level: previous[key], price: previous[key], timeFrom: previous.time, timeTo: candidate.time, confirmedAt: bar.closedAt ?? bar.time, event_id: stableId(type, previous[key], previous.time) }));
      }
      this.previous[type] = candidate;
    }
    return this.snapshot();
  }
  setData(bars) { this.reset(); for (const b of bars) this.update(b); return this.snapshot(); }
  snapshot() { return this.events.slice(); }
}
export const EQHEQLEngine = EqualHighLowEngine;
export const createEqualHighLowEngine = options => new EqualHighLowEngine(options);
