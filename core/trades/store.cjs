'use strict';
const { projectPortfolio } = require('../performance/project.cjs');
const { projectCapitalPortfolio } = require('../../runtime/capital-ledger.cjs');
function createTradeStore({ runtime, capitalUsd = 10000, capitalLedger = null, walletFunded = false, fundingAllowed = () => true, now = () => new Date(), maxQuoteAgeMs = 60000 } = {}) {
  if (!runtime || typeof runtime.snapshot !== 'function') throw Error('INVALID_TRADE_STORE_RUNTIME');
  projectPortfolio([], { capitalUsd, now, maxQuoteAgeMs });
  const anchored = runtime.capitalEvents?.() ?? [];
  const legacy = runtime.capitalHistoryGroups?.() ?? [];
  const histories = new Map();
  function project(events, network, epoch, clock, historical = false) {
    const ids = new Set(events.map(e => e.id));
    events = [...anchored.filter(e => !ids.has(e.id)), ...events];
    events = events.filter(e=>e.network===network && !(e.type === 'TradeResult' && e.payload.mode === 'live'));
    // snapshot({throughId}) cuts the journal at the decision, but a valuation
    // published 1-2 seconds AFTER the decision (independent 25s cadence) is
    // still authoritative evidence for it — take the latest valuation visible
    // anywhere in the event map order, not strictly before the cut.
    const quotes = events.filter(e => e.type === 'WalletValuation' && e.network === network && e.epoch === epoch);
    const quote = quotes.findLast(e => Date.parse(e.timestamp) <= clock.getTime()) ?? quotes.at(-1);
    const groups = legacy.map(g => g.filter(e => e.network === network));
    if (!histories.has(network)) histories.set(network, require('../../runtime/capital-ledger.cjs').projectCapitalHistory(groups, capitalUsd, () => clock));
    const history = histories.get(network);
    // An adjustment made AFTER a decision cannot fund that historical decision.
    const capitalAdjustments = (capitalLedger?.entries(network) ?? []).map(e => anchored.length ? { ...e, eventCount: events.filter(x => Date.parse(x.timestamp) < Date.parse(e.at)).length } : e).filter(e => !historical || e.eventCount < events.length);
    const result = projectCapitalPortfolio(events, { legacy, history, walletFunded, capitalUsd, capitalAdjustments, activeNetwork: network, now: () => clock, maxQuoteAgeMs });
    const p = result.performance;
    const withdrawnUsd = network === 'SOLANA' ? (runtime.paperWithdrawals?.() ?? []).filter(e => !historical || Date.parse(e.at) <= clock.getTime()).reduce((sum, e) => sum + e.amountUsd, 0) : 0;
    if (withdrawnUsd) {
      p.capitalDelta -= withdrawnUsd;
      p.paperCapitalUsd = Math.max(0, p.paperCapitalUsd - withdrawnUsd);
      p.cash = Math.max(0, p.cash - withdrawnUsd);
      if (p.equity != null) p.equity = Math.max(0, p.equity - withdrawnUsd);
    }
    const fundingClock = now().getTime();
    // Owner directive: a 25s valuation cadence normally keeps this fresh, but a
    // transient RPC/price outage must not veto every buy for the next minutes.
    // 15 minutes of tolerated staleness before capital evidence counts as stale.
    const fresh = quote && fundingAllowed(quote) && [quote.timestamp, quote.payload.balanceAt, quote.payload.priceAt].every(at => fundingClock >= Date.parse(at) && fundingClock - Date.parse(at) <= 900000);
    p.budgetUsd = walletFunded ? fresh ? Math.max(0, quote.payload.valueUsd + p.capitalDelta + p.realizedPnl) : null : Math.max(0, p.paperCapitalUsd);
    p.fundingId = walletFunded && fresh ? quote.id : null;
    if (walletFunded) {
      p.equity = p.budgetUsd == null || p.equity == null ? null : Math.min(p.equity, p.budgetUsd);
      p.cash = p.budgetUsd == null ? 0 : Math.max(0, Math.min(p.cash, p.budgetUsd - p.capitalUsed));
    }
    return result;
  }
  return { walletFunded, capitalHistory: () => capitalLedger?.entries(runtime.status().network).reverse() ?? [], snapshot({ throughId } = {}) {
    const state = runtime.snapshot();
    if (throughId !== undefined) {
      const index = state.events.findIndex(e => e.id === throughId);
      if (index < 0) throw Error('UNKNOWN_PORTFOLIO_BOUNDARY');
      const boundary = state.events[index];
      return project(state.events.slice(0, index + 1), boundary.network, boundary.epoch, new Date(boundary.timestamp), true);
    }
    return project(state.events, state.network, state.epoch, now());
  } };
}
module.exports = { createTradeStore };
