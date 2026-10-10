'use strict';
const { validateEvent, NETWORKS } = require('../../runtime/contracts/index.cjs');
const fail = code => { throw Error('INVALID_PORTFOLIO_' + code); };
const keyOf = (network, token) => JSON.stringify([network, token]);
const finite = value => { if (!Number.isFinite(value)) fail('ARITHMETIC'); return value; };
function projectPortfolio(events, { capitalUsd = 10000, capitalAdjustments = [], activeNetwork = 'SOLANA', now = () => new Date(), maxQuoteAgeMs = 60000 } = {}) {
  if (!Array.isArray(events) || typeof capitalUsd !== 'number' || !Number.isFinite(capitalUsd) || capitalUsd < 0 || !NETWORKS.includes(activeNetwork) || !Number.isSafeInteger(maxQuoteAgeMs) || maxQuoteAgeMs <= 0 || typeof now !== 'function') fail('CONFIG');
  const clock = now();
  if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) fail('CLOCK');
  const positions = new Map(), marks = new Map(), ids = new Set(), intents = new Map(), trades = [];
  let cash = capitalUsd, realizedPnl = 0, closedPositions = 0, wins = 0, peak = capitalUsd, drawdown = 0, historyGap = false;
  function valuation(time) {
    let marketValue = 0, capitalUsed = 0, known = true;
    const rows = [];
    for (const position of positions.values()) {
      if (position.quantity === 0) continue;
      capitalUsed = finite(capitalUsed + position.costBasis);
      const mark = marks.get(position.key), observed = mark && Date.parse(mark.payload.observedAt);
      const valid = mark && mark.evidence.length > 0 && mark.missing_evidence.length === 0 && ['OBSERVED', 'COMPLETED'].includes(mark.status) && mark.evidence_quality > 0 && mark.confidence > 0 && mark.uncertainty < 1 && observed >= position.lastFillAt && time >= observed && time - observed <= maxQuoteAgeMs;
      const value = valid ? finite(mark.payload.price * position.quantity) : null;
      if (value === null) known = false; else marketValue = finite(marketValue + value);
      rows.push({ network: position.network, token: position.token, quantity: position.quantity, costBasis: position.costBasis, averageCost: finite(position.costBasis / position.quantity), markPrice: valid ? mark.payload.price : null, markSnapshotId: valid ? mark.id : null, marketValue: value, unrealizedPnl: value === null ? null : finite(value - position.costBasis), lastFillId: position.lastFillId, cycle: position.cycle });
    }
    return { positions: rows, capitalUsed, unrealizedPnl: known ? finite(marketValue - capitalUsed) : null, equity: known ? finite(cash + marketValue) : null };
  }
  function measure(time) {
    const value = valuation(time).equity;
    // value null here only means a position lacks a fresh mark (known=false);
    // with cash always known the equity curve has no real gap — an incomplete
    // drawdown series must read as 0, never null (null vetoes every entry).
    drawdown = Math.max(drawdown, value === null ? drawdown : (peak = Math.max(peak, value), peak > 0 ? finite((peak - value) / peak) : 0));
  }
  // Replay external cash flows at their journal boundary, never as trading PnL.
  let adjustmentIndex = 0, eventIndex = 0, capitalDelta = 0;
  function adjustCapital() {
    while (adjustmentIndex < capitalAdjustments.length && capitalAdjustments[adjustmentIndex].eventCount <= eventIndex) {
      const row = capitalAdjustments[adjustmentIndex++], delta = row.type === 'deposit' ? row.amountUsd : -row.amountUsd;
      cash = finite(cash + delta); capitalDelta = finite(capitalDelta + delta); peak = Math.max(0, finite(peak + delta));
    }
  }
  for (const raw of events) {
    adjustCapital(); eventIndex++;
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || ids.has(raw.id)) fail('EVENT_IDENTITY');
    ids.add(raw.id);
    if (!['MarketSnapshot', 'TradeResult'].includes(raw.type)) continue;
    const event = validateEvent(raw, { now: () => clock }), p = event.payload, key = keyOf(event.network, p.token), time = Date.parse(event.timestamp);
    if (event.type === 'MarketSnapshot') {
      const previous = marks.get(key);
      // A delayed old observation never overwrites a later observation.
      if (!previous || Date.parse(p.observedAt) >= Date.parse(previous.payload.observedAt)) marks.set(key, event);
      measure(time); continue;
    }
    const identity = JSON.stringify([event.network, event.epoch, event.correlationId, p.token, p.candidateId, p.snapshotId, p.signalIds, p.strategyVersion, p.decisionId, p.riskDecisionId, p.side]);
    if (intents.has(p.intentId) && intents.get(p.intentId) !== identity) fail('INTENT_IDENTITY');
    intents.set(p.intentId, identity);
    let position = positions.get(key), fillRealized = 0, allocatedCostBasis = 0;
    if (position && time < position.lastFillAt) fail('FILL_TIME_ORDER');
    if (p.side === 'BUY') {
      if (p.state !== 'OPEN' || p.exitPrice !== null) fail('BUY_STATE');
      const cost = finite(p.quantity * p.entryPrice + p.fees);
      allocatedCostBasis = cost;
      if (cost > cash) fail('INSUFFICIENT_CASH');
      if (!position || position.quantity === 0) position = { key, network: event.network, token: p.token, quantity: 0, costBasis: 0, cycleRealized: 0, cycle: (position?.cycle ?? 0) + 1 };
      position.quantity = finite(position.quantity + p.quantity); position.costBasis = finite(position.costBasis + cost); cash = finite(cash - cost);
    } else {
      if (p.state !== 'CLOSED' || p.exitPrice === null) fail('SELL_STATE');
      if (!position || p.quantity > position.quantity) fail('OVERSELL');
      const remainder = position.quantity - p.quantity;
      const closes = Math.abs(remainder) <= Number.EPSILON * Math.max(position.quantity, p.quantity) * 8;
      const basis = closes ? position.costBasis : finite(position.costBasis * p.quantity / position.quantity);
      allocatedCostBasis = basis;
      const proceeds = finite(p.quantity * p.exitPrice - p.fees);
      fillRealized = finite(proceeds - basis); realizedPnl = finite(realizedPnl + fillRealized);
      position.cycleRealized = finite(position.cycleRealized + fillRealized); cash = finite(cash + proceeds);
      position.quantity = closes ? 0 : remainder; position.costBasis = closes ? 0 : finite(position.costBasis - basis);
      if (closes) { closedPositions++; if (position.cycleRealized > 0) wins++; }
    }
    position.lastFillAt = time; position.lastFillId = event.id; positions.set(key, position);
    trades.push({ id: event.id, intentId: p.intentId, decisionId: p.decisionId, riskDecisionId: p.riskDecisionId, candidateId: p.candidateId, snapshotId: p.snapshotId, signalIds: [...p.signalIds], strategyVersion: p.strategyVersion, network: event.network, epoch: event.epoch, token: p.token, side: p.side, quantity: p.quantity, entryPrice: p.entryPrice, exitPrice: p.exitPrice, fees: p.fees, timestamp: event.timestamp, realizedPnl: fillRealized, state: p.state, cycleId: JSON.stringify([event.network, p.token, position.cycle]), cycle: position.cycle, allocatedCostBasis, realizedReturn: p.side === 'BUY' ? null : finite(fillRealized / allocatedCostBasis) });
    measure(time);
  }
  adjustCapital();
  const final = valuation(clock.getTime());
  for (const trade of trades) {
    const current = positions.get(keyOf(trade.network, trade.token));
    trade.positionState = current?.cycle === trade.cycle && current.quantity > 0 ? 'OPEN' : 'CLOSED';
  }
  return { activeNetwork, trades, positions: final.positions, performance: { paperCapitalUsd: finite(capitalUsd + capitalDelta + realizedPnl), capitalDelta, totalFills: trades.length, closedPositions, wins, winRate: closedPositions ? wins / closedPositions : null, capitalUsed: final.capitalUsed, cash, realizedPnl, unrealizedPnl: final.unrealizedPnl, equity: final.equity, maxDrawdown: final.equity === null || historyGap ? null : drawdown, valuationHistoryComplete: !historyGap } };
}
module.exports = { projectPortfolio };
