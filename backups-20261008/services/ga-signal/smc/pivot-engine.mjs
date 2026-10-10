// Pure closed-bar engine. Equal highs/lows fail the strict pivot inequality.
export function stableId(...parts) {
  let hash = 0xcbf29ce484222325n;
  for (const char of JSON.stringify(parts)) hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0))) * 0x100000001b3n);
  return hash.toString(16).padStart(16, '0');
}
export class PivotEngine {
  constructor(options = {}) {
    this.N = typeof options === 'number' ? options : options.N ?? 5;
    this.levelIndex = options.levelIndex ?? this.N;
    if (!Number.isInteger(this.N) || this.N < 1) throw new RangeError('N must be a positive integer');
    this.reset();
  }
  reset() { this.bars = []; this.pivots = []; this.pending = new Set(); }
  update(bar) {
    if (bar.closed === false) throw new Error('PivotEngine requires closed bars');
    const last = this.bars.at(-1);
    if (last && bar.time <= last.time) {
      if (bar.time === last.time && ['open', 'high', 'low', 'close'].every(k => bar[k] === last[k])) return [];
      throw new Error('Closed bars are immutable and must arrive in time order');
    }
    const i = this.bars.length, changes = [];
    this.bars.push({ ...bar });
    // 1) Pending candidates age: du N bar ben phai (bay gio la bar thu i - barIndex) -> CONFIRMED.
    //    Confirmed pivot BAT BIEN: khong invalidate, khong doi id/time/price.
    for (const index of [...this.pending]) {
      const pv = this.pivots[index];
      if (i - pv.barIndex >= this.N) {
        const next = Object.freeze({ ...pv, status: 'CONFIRMED', confirmedAt: bar.closedAt ?? bar.time });
        this.pivots[index] = next; this.pending.delete(index); changes.push(next);
      }
    }
    // 2) Candidate moi: bar hien tai vot qua that su max/min cua N bar truoc (strict).
    //    SUPERSEDE cung loai: candidate HIGH moi thay pending HIGH cu (INVALIDATED/SUPERSEDED).
    if (i >= this.N) {
      const prev = this.bars.slice(i - this.N, i);
      const maxPrevHigh = Math.max(...prev.map(b => b.high));
      const minPrevLow = Math.min(...prev.map(b => b.low));
      for (const [type, key, isBetter] of [['PIVOT_HIGH', 'high', bar.high > maxPrevHigh], ['PIVOT_LOW', 'low', bar.low < minPrevLow]]) {
        if (!isBetter) continue;
        // Huy pending cung loai (superseded)
        for (const index of [...this.pending]) {
          const pv = this.pivots[index];
          if (pv.type === type && pv.status === 'PROVISIONAL') {
            this.pivots[index] = Object.freeze({ ...pv, status: 'INVALIDATED', supersededBy: bar.time });
            this.pending.delete(index);
          }
        }
        const candidate = Object.freeze({ type, price: bar[key], time: bar.time, barIndex: i, status: 'PROVISIONAL', confirmedAt: null, event_id: stableId(type, bar.time, bar[key], this.levelIndex) });
        this.pending.add(this.pivots.length); this.pivots.push(candidate); changes.push(candidate);
      }
    }
    return changes;
  }
  setData(candles) { this.reset(); for (const bar of candles) this.update(bar); return this.snapshot(); }
  snapshot() { return this.pivots.slice(); }
}
export function computePivots(candles, N = 5) { return new PivotEngine(N).setData(candles); }
