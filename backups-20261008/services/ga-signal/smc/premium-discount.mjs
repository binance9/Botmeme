import { stableId } from './pivot-engine.mjs';
export function computePremiumDiscount(state) {
  const { strong, weak } = state ?? {};
  if (strong?.status !== 'CONFIRMED' || weak?.status !== 'CONFIRMED') return null;
  const top = Math.max(strong.price, weak.price), bottom = Math.min(strong.price, weak.price), range = top - bottom;
  if (!Number.isFinite(range) || range <= 0) return null;
  return Object.freeze({ premium: Object.freeze({ top, bottom: top - range * .05 }), equilibrium: Object.freeze({ top: bottom + range * .525, bottom: bottom + range * .475 }), discount: Object.freeze({ top: bottom + range * .05, bottom }), timeFrom: Math.min(strong.time, weak.time), event_id: stableId('PD', strong.time, strong.price, weak.time, weak.price) });
}
export class PremiumDiscountEngine {
  constructor() { this.reset(); }
  reset() { this.value = null; }
  update(state) { const value = computePremiumDiscount(state); if (value) this.value = value; return this.snapshot(); }
  setData(states) { this.reset(); for (const state of states) this.update(state); return this.snapshot(); }
  snapshot() { return this.value; }
}
