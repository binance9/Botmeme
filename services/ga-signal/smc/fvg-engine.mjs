import { stableId } from './pivot-engine.mjs';
import { acceptBar } from './closed-bars.mjs';
export class FVGEngine {
  constructor({ autoThreshold = true } = {}) { this.autoThreshold = autoThreshold; this.reset(); }
  reset() { this.bars = []; this.history = []; this.bodySum = 0; }
  update(bar) {
    if (!acceptBar(this.bars, bar)) return this.snapshot();
    // Cumulative absolute body percentage / barCount * 2 (same units as body/open*100).
    this.bodySum += bar.open === 0 ? 0 : Math.abs((bar.close - bar.open) / bar.open * 100);
    this.history = this.history.map(g => !g.mitigated && (g.side === 'BULLISH' ? bar.low < g.bottom : bar.high > g.top) ? Object.freeze({ ...g, mitigated: true }) : g);
    if (this.bars.length >= 3) {
      const a = this.bars.at(-3), middle = this.bars.at(-2);
      const body = middle.open === 0 ? 0 : Math.abs((middle.close - middle.open) / middle.open * 100);
      const threshold = this.autoThreshold ? this.bodySum / this.bars.length * 2 : -1;
      if (body > threshold) {
        const side = bar.low > a.high ? 'BULLISH' : bar.high < a.low ? 'BEARISH' : null;
        if (side) this.history.push(Object.freeze({ side, top: side === 'BULLISH' ? bar.low : a.low, bottom: side === 'BULLISH' ? a.high : bar.high, time: bar.time, mitigated: false, event_id: stableId('FVG', side, bar.time) }));
      }
    }
    return this.snapshot();
  }
  setData(bars) { this.reset(); for (const b of bars) this.update(b); return this.snapshot(); }
  snapshot() { return this.history.filter(g => !g.mitigated); }
}
export const createFVGEngine = options => new FVGEngine(options);
