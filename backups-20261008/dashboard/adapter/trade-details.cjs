'use strict';
function createTradeDetails(events, trades, discoveries, clock) {
  const byId = new Map(events.map(e => [e.id, e])), cycles = new Map(), births = new Map();
  const key = t => JSON.stringify([t.network, t.token]);
  for (const e of events) {
    const p = e.payload;
    if (e.type !== 'MarketSnapshot' || !Number.isFinite(p.poolAgeMs) || p.poolAgeMs < 0) continue;
    const at = Date.parse(p.observedAt) - p.poolAgeMs;
    if (Number.isFinite(at) && !births.has(key({ network:e.network, token:p.token }))) births.set(key({ network:e.network, token:p.token }), new Date(at).toISOString());
  }
  for (const row of discoveries) if (Number.isFinite(Date.parse(row.createdAt))) births.set(key(row), new Date(row.createdAt).toISOString());
  for (const t of trades) { const rows = cycles.get(t.cycleId) || []; rows.push(t); cycles.set(t.cycleId, rows); }
  return t => {
    const cycle = cycles.get(t.cycleId) || [t];
    const entry = cycle.find(r => r.side === 'BUY');
    const exit = t.side === 'BUY' ? t.positionState === 'CLOSED' ? cycle.findLast(r => r.side !== 'BUY') : null : t;
    const decision = exit && byId.get(exit.decisionId);
    const enteredAt = entry?.timestamp ?? null, exitedAt = exit?.timestamp ?? null;
    const result = { tokenCreatedAt:births.get(key(t)) ?? null, enteredAt, exitedAt,
      holdingMs:enteredAt ? Math.max(0, (exitedAt ? Date.parse(exitedAt) : clock.getTime()) - Date.parse(enteredAt)) : null,
      closeReason:decision?.type === 'StrategyDecision' && decision.network === t.network ? decision.payload.reason : null };
    result.closeReasonCode = !result.closeReason ? null : decision.source === 'commander.manual-paper-exit' ? 'MANUAL' : /^RECOVER_ORIGINAL\b/.test(result.closeReason) ? 'RECOVER_ORIGINAL x2' : /^TRAILING(?:_STOP)?\b/.test(result.closeReason) ? 'TRAILING' : result.closeReason.match(/^(STOP_LOSS|TAKE_PROFIT)\b/)?.[1] ?? null;
    const sells = cycle.filter(r => r.side !== 'BUY'), buys = cycle.filter(r => r.side === 'BUY');
    const sold = sells.reduce((s,r)=>s+r.quantity,0), bought = buys.reduce((s,r)=>s+r.quantity,0);
    const bankedBasis = sells.reduce((s,r)=>s+r.allocatedCostBasis,0);
    result.bankedPnlUsd = sells.reduce((s,r)=>s+r.realizedPnl,0);
    result.bankedPnlPct = bankedBasis > 0 ? result.bankedPnlUsd / bankedBasis * 100 : 0;
    result.remainingQuantity = Math.max(0, bought - sold);
    result.soldPct = bought > 0 ? sold / bought * 100 : 0;
    result.sellBadge = sold > 0 ? t.positionState === 'OPEN' ? `ĐÃ BÁN 1 PHẦN (${result.soldPct.toFixed(1)}%)` : 'ĐÃ BÁN' : null;
    if (t.side === 'BUY' && exit) {
      const sells = cycle.filter(r => r.side !== 'BUY');
      result.exitPriceUsd = sells.reduce((s,r) => s+r.exitPrice*r.quantity,0) / sells.reduce((s,r)=>s+r.quantity,0);
      result.pnlUsd = sells.reduce((s,r)=>s+r.realizedPnl,0);
      const basis = sells.reduce((s,r)=>s+r.allocatedCostBasis,0);
      result.pnlPct = basis > 0 ? result.pnlUsd / basis * 100 : null;
    }
    return result;
  };
}
module.exports = { createTradeDetails };
