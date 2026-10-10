'use strict';
// Exit manager — protective exits for open meme-flow positions.
// Master plan step [5]: every open position MUST carry stop-loss / take-profit /
// trailing-stop protection. This module watches each fresh MarketSnapshot and,
// when a protective threshold is hit, publishes a SELL StrategyDecision
// (producer EXIT_MANAGER). The existing independent risk engine still vets the
// exit and paper execution still fills it — nothing here bypasses the veto.
// Only meme-flow-v1 positions are managed; quant strategies keep their own exits.
const { derived } = require('../../runtime/events/derived.cjs');
const { STAGNATION_MINUTES, STAGNATION_MIN_RECENT_VOL_USD } = require('./engine.cjs');

const DEFAULT_POLICY = Object.freeze({ stopDistance: 0.30, takeProfit: 0.15, trailDistance: 0.3, volumeWeakTakeProfit: 0.5, strongVolumeUsd: 1000, stopLossEnabled: true, trailingEnabled: true, volumeExitsEnabled: false, recoverAtMultiple: 2, recoverFraction: 0.5 });
function createExitManager({ runtime, tradeStore, now = () => new Date(), policy = {}, takeProfitMultiple = null } = {}) {
  if (!runtime || !['get', 'snapshot', 'publish', 'subscribeDurable'].every(k => typeof runtime[k] === 'function') || typeof tradeStore?.snapshot !== 'function' || typeof now !== 'function') throw Error('INVALID_EXIT_RUNTIME');
  const p = { ...DEFAULT_POLICY, ...policy };
  if (Object.keys(p).some(k => !Object.hasOwn(DEFAULT_POLICY, k)) || Object.entries(p).some(([key, v]) => key === 'strongVolumeUsd' ? !(typeof v === 'number' && Number.isFinite(v) && v > 0) : key === 'recoverAtMultiple' ? (typeof v !== 'number' || !Number.isFinite(v) || v <= 1) : key === 'stopLossEnabled' || key === 'trailingEnabled' || key === 'volumeExitsEnabled' ? typeof v !== 'boolean' : (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v >= 1))) throw Error('INVALID_EXIT_POLICY');
  let running = false, generation = 0, detach = null;

  function handle(quote) {
    if (quote.type !== 'MarketSnapshot') return;
    const state = runtime.snapshot();
    const index = state.events.findIndex(e => e.id === quote.id);
    if (index < 0) throw Error('EXIT_QUOTE_NOT_PERSISTED');
    const prior = state.events.slice(0, index + 1);
    let portfolio;
    try { portfolio = tradeStore.snapshot({ throughId: quote.id }); } catch { return; }
    for (const trade of portfolio.trades) {
      if (trade.state !== 'OPEN' || trade.positionState !== 'OPEN' || trade.side !== 'BUY' || trade.strategyVersion !== 'meme-flow-v1') continue;
      if (trade.network !== quote.network || trade.epoch !== quote.epoch || trade.token !== quote.payload.token) continue;
      const position = portfolio.positions.find(row => row.network === trade.network && row.token === trade.token);
      if (!position || position.quantity <= 0 || position.cycle !== trade.cycle) continue;
      const entry = position.averageCost;
      const price = quote.payload.price;
      const highs = prior.filter(e => e.type === 'MarketSnapshot' && e.network === trade.network && e.epoch === trade.epoch && e.payload.token === trade.token && e.timestamp >= trade.timestamp);
      const highWater = highs.reduce((max, e) => Math.max(max, e.payload.price), entry);
      // Owner directive (cập nhật) "-30% cắt lỗ, x2 chốt gốc, phần còn lại chốt dần":
      // (1) stop-loss cuts the WHOLE position at -30% from entry;
      // (2) at recoverAtMultiple (x2) a single REDUCE banks recoverFraction (50%) —
      // enough to recover the original capital — guarded by trancheTaken so it
      // can never repeat; (3) only AFTER that tranche does the trailing stop
      // manage the remainder (chốt dần) from the high-water mark. The legacy
      // "ko x10 ko bán" full-exit multiple is retired; takeProfitMultiple stays
      // accepted in the wiring signature for compatibility but no longer exits.
      const profit = price / entry - 1;
      const strongVolume = Number.isFinite(quote.payload.recentVolumeUsd) && quote.payload.recentVolumeUsd >= p.strongVolumeUsd;
      // A requested tranche is not a fill: rejected or failed exits must remain
      // eligible for recovery, and must never turn on the trailing stop.
      const recoveryDecisions = prior.filter(e => e.type === 'StrategyDecision' && e.producer === 'EXIT_MANAGER' && e.payload.action === 'REDUCE' && e.payload.candidateId === trade.candidateId && e.network === trade.network && e.epoch === trade.epoch && e.timestamp >= trade.timestamp);
      const recoveryIds = new Set(recoveryDecisions.map(e => e.id));
      const trancheTaken = portfolio.trades.some(fill => ['SELL', 'REDUCE'].includes(fill.side) && fill.state === 'CLOSED' && fill.quantity > 0 && fill.network === trade.network && fill.token === trade.token && fill.cycle === trade.cycle && recoveryIds.has(fill.decisionId));
      // Keep pending orders separate from successful recovery. Risk/execution
      // failures release this guard; the execution intent age bounds stale work.
      const tranchePending = recoveryDecisions.some(decision => {
        const intentAgeLimit = runtime.executionMode?.() === 'live' ? 180000 : 900000;
        if (Date.parse(quote.payload.observedAt) - Date.parse(decision.timestamp) > intentAgeLimit) return false;
        const risk = prior.find(e => e.type === 'RiskDecision' && e.payload.decisionId === decision.id);
        if (risk?.payload.approved === false) return false;
        const intent = prior.find(e => e.type === 'ExecutionIntent' && e.payload.decisionId === decision.id);
        return !prior.some(e => e.type === 'AIActivityEvent' && e.status === 'FAILED' && e.payload.state === 'FAILED' && ((intent && ['PAPER_EXECUTION', 'LIVE_EXECUTION'].includes(e.producer) && e.payload.task === intent.id) || (risk && e.producer === 'STRATEGY_ENGINE' && e.payload.task === risk.id)));
      });
      const stagnant = trade.positionState === 'OPEN' &&
        Date.parse(quote.payload.observedAt) - Date.parse(trade.timestamp) >= STAGNATION_MINUTES * 60000 &&
        Number.isFinite(quote.payload.recentVolumeUsd) && quote.payload.recentVolumeUsd < STAGNATION_MIN_RECENT_VOL_USD;
      let reason = null, action = 'SELL';
      if (!trancheTaken && !tranchePending && price >= entry * p.recoverAtMultiple) { action = 'REDUCE'; reason = 'RECOVER_ORIGINAL: price ' + price + ' >= entry ' + entry + ' * ' + p.recoverAtMultiple + '; banking ' + Math.round(p.recoverFraction * 100) + '% to recover the original capital, riding the rest.'; }
      else if (p.stopLossEnabled && price <= entry * (1 - p.stopDistance)) reason = 'STOP_LOSS: price ' + price + ' <= entry ' + entry + ' * (1-' + p.stopDistance + ').';
      else if (p.trailingEnabled && trancheTaken && highWater > entry && price <= highWater * (1 - p.trailDistance)) reason = 'TRAILING_STOP: price ' + price + ' <= high-water ' + highWater + ' * (1-' + p.trailDistance + ').';
      else if (p.volumeExitsEnabled && !strongVolume && profit >= p.volumeWeakTakeProfit) reason = 'VOLUME_WEAK_TP: recent volume ' + (quote.payload.recentVolumeUsd ?? 0) + ' USD/5m is below ' + p.strongVolumeUsd + '; banking +' + Math.round(profit * 100) + '%.';
      else if (p.volumeExitsEnabled && strongVolume && profit >= p.volumeWeakTakeProfit && !trancheTaken && !tranchePending) { action = 'REDUCE'; reason = 'VOLUME_WAVE: volume ' + quote.payload.recentVolumeUsd + ' USD/5m still strong; banking half at +' + Math.round(profit * 100) + '% and riding the rest.'; }
      if (stagnant) { action = 'SELL'; reason = 'STAGNANT: new entry with no volume for ' + STAGNATION_MINUTES + 'm — rotating to next token'; }
      if (!reason) continue;
      if (runtime.executionMode?.() === 'live') action = 'SELL';
      // Trace contract: regimeId must reference a real MarketRegimeState. Regime
      // states exist after the first completed scan; if none is visible yet the
      // exit is re-evaluated on the next snapshot (seconds away, not a stall).
      const regime = prior.findLast(e => e.type === 'MarketRegimeState' && e.network === quote.network && e.epoch === quote.epoch);
      if (!regime) continue;
      const eventId = derived(quote, { producer: 'EXIT_MANAGER', type: 'StrategyDecision', variant: 'exit/' + trade.id }).id;
      if (runtime.get(eventId)) continue;
      runtime.publish(derived(quote, {
        producer: 'EXIT_MANAGER', type: 'StrategyDecision', variant: 'exit/' + trade.id,
        status: 'APPROVED', evidence: [quote.id, regime.id], missing_evidence: [],
        confidence: quote.confidence, uncertainty: quote.uncertainty,
        payload: {
          candidateId: trade.candidateId, snapshotId: quote.id, signalIds: [],
          strategyVersion: trade.strategyVersion, quantEvidenceIds: [], criticReportIds: [],
          regimeId: regime.id, action, disposition: 'EXIT', reason
        }
      }));
    }
  }

  return {
    start() {
      if (running) return; running = true; const ticket = ++generation;
      try {
        detach = runtime.subscribeDurable('exit.manager.v1.MarketSnapshot', 'MarketSnapshot', (e, context) => {
          if (!running || ticket !== generation || context.signal.aborted) throw Error('EXIT_MANAGER_STOPPED');
          handle(e);
        });
      } catch (error) { running = false; throw error; }
    },
    stop() { running = false; generation++; detach?.(); detach = null; }
  };
}
module.exports = { createExitManager, DEFAULT_POLICY, STAGNATION_MINUTES, STAGNATION_MIN_RECENT_VOL_USD };
