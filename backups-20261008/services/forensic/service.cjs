'use strict';
const { createHash } = require('node:crypto');
const DEFAULT_POLICY = Object.freeze({ maxSlippageBps: 100, maxSnapshotAgeMs: 60000, minBacktestTrades: 2, minSamples: 40, minFolds: 1, minPaperTrades: 5, maxDrawdown: 0.15 });
function createForensic({ runtime, tradeStore, now = () => new Date(), policy = {} } = {}) {
  if (!runtime || !['get', 'snapshot', 'publish', 'subscribeDurable'].every(k => typeof runtime[k] === 'function') || typeof tradeStore?.snapshot !== 'function' || typeof now !== 'function') throw Error('INVALID_FORENSIC_RUNTIME');
  const p = { ...DEFAULT_POLICY, ...policy };
  if (Object.keys(p).some(k => !Object.hasOwn(DEFAULT_POLICY, k)) || !['maxSlippageBps', 'maxSnapshotAgeMs', 'minBacktestTrades', 'minSamples', 'minFolds', 'minPaperTrades'].every(k => Number.isSafeInteger(p[k]) && p[k] > 0) || p.minPaperTrades < 5 || !Number.isFinite(p.maxDrawdown) || p.maxDrawdown <= 0 || p.maxDrawdown > 1) throw Error('INVALID_FORENSIC_POLICY');
  let running = false, generation = 0, detach = [];
  const reliable = e => e && e.evidence.length > 0 && !e.missing_evidence.length && e.evidence_quality > 0 && e.confidence > 0 && e.uncertainty < 1 && ['COMPLETED', 'OBSERVED', 'PROPOSED'].includes(e.status);
  function emit(input, suffix, type, payload, evidence, missing = []) {
    const id = 'forensic.' + suffix + '/' + createHash('sha256').update(JSON.stringify([input.id, p])).digest('hex');
    if (!runtime.get(id)) runtime.publish({ id, type, timestamp: input.timestamp, producer: 'CODEX_3', source: 'forensic.evidence-check', evidence: [...new Set(evidence)], status: missing.length ? 'CHUA_XAC_MINH' : 'COMPLETED', correlationId: input.correlationId, network: input.network, epoch: input.epoch, confidence: missing.length ? 0 : 1, evidence_quality: missing.length ? 0 : 1, uncertainty: missing.length ? 1 : 0, missing_evidence: missing, payload });
    return id;
  }
  function report(input, category, cause, refs, unresolved = false) {
    const missing = unresolved ? ['Causal explanation is not established by available evidence.'] : [];
    const failureId = emit(input, 'failure.' + (category ?? 'unresolved'), 'FailureReport', { tradeId: input.id, decisionId: input.payload.decisionId, category, summary: cause }, [input.id, ...refs], missing);
    emit(input, 'root.' + (category ?? 'unresolved'), 'RootCauseReport', { failureId, category, cause, recommendations: [unresolved ? 'Collect counterfactual signal, regime, entry and exit evidence before assigning root cause.' : 'Review the cited condition before authorizing further exposure.'] }, [failureId, input.id, ...refs], missing);
  }
  function critique(proposal, trigger, portfolio, all) {
    const q = proposal.payload;
    if (q.lifecycle !== 'CHALLENGER' || !q.backtestId || !q.walkForwardId) return;
    const bt = runtime.get(q.backtestId), wf = runtime.get(q.walkForwardId), idea = bt && runtime.get(bt.payload.proposalId);
    if (!bt || !wf) return; // Runtime trace validation normally prevents this; never invent references.
    const refs = [proposal.id, bt.id, wf.id];
    const paper = portfolio.trades.filter(t => t.network === proposal.network && t.epoch === proposal.epoch && t.strategyVersion === q.strategyVersion && t.state === 'CLOSED' && ['SELL', 'REDUCE'].includes(t.side) && Date.parse(t.timestamp) >= Date.parse(proposal.timestamp) && all.some(e => e.id === t.id));
    const paperIds = paper.slice(-256).map(t => t.id);
    const positions = new Map(); let closedCycles = 0;
    for (const trade of portfolio.trades.filter(t => t.network === proposal.network && t.epoch === proposal.epoch)) {
      const position = positions.get(trade.token) ?? { quantity: 0, versions: new Set() };
      if (trade.side === 'BUY') { position.quantity += trade.quantity; position.versions.add(trade.strategyVersion); }
      else {
        position.quantity -= trade.quantity;
        if (Math.abs(position.quantity) <= Number.EPSILON * Math.max(1, trade.quantity) * 8) {
          if (position.versions.size === 1 && position.versions.has(q.strategyVersion) && paperIds.includes(trade.id)) closedCycles++;
          position.quantity = 0; position.versions.clear();
        }
      }
      positions.set(trade.token, position);
    }
    const snapshots = all.filter(e => e.type === 'MarketSnapshot' && e.network === proposal.network && e.epoch === proposal.epoch && (bt.evidence.includes(e.id) || wf.evidence.includes(e.id)) && reliable(e));
    const train = snapshots.filter(e => bt.evidence.includes(e.id)), holdout = snapshots.filter(e => wf.evidence.includes(e.id));
    const independent = train.length > 0 && holdout.length > 0 && train.every(e => !wf.evidence.includes(e.id)) && Math.max(...train.map(e => Date.parse(e.payload.observedAt))) < Math.min(...holdout.map(e => Date.parse(e.payload.observedAt))) && snapshots.every(e => e.payload.token === snapshots[0].payload.token);
    let verdict = 'SUPPORTED', reason = 'Positive cost-adjusted research evidence; paper evaluation is not yet validated.';
    const identity = bt.type === 'BacktestResult' && wf.type === 'WalkForwardResult' && idea?.type === 'StrategyProposal' && bt.payload.strategyVersion === q.strategyVersion && wf.payload.strategyVersion === q.strategyVersion && idea.payload.strategyVersion === q.strategyVersion && wf.payload.proposalId === idea.id && wf.payload.backtestId === bt.id && proposal.evidence.includes(idea.id) && JSON.stringify(q.parameters) === JSON.stringify(idea.payload.parameters) && JSON.stringify(q.regimes) === JSON.stringify(idea.payload.regimes);
    if (!identity) { verdict = 'REJECTED'; reason = 'Proposal, backtest and walk-forward identity or version mismatch.'; }
    else if (!reliable(proposal) || !reliable(bt) || !reliable(wf) || bt.payload.trades < p.minBacktestTrades || wf.payload.folds < p.minFolds || snapshots.length < p.minSamples || !independent) { verdict = 'CHUA_XAC_MINH'; reason = 'Insufficient reliable disjoint chronological samples, trades or walk-forward folds.'; }
    else if (bt.payload.netPnl <= 0 || bt.payload.expectancy <= 0 || wf.payload.outOfSamplePnl <= 0 || Math.max(bt.payload.maxDrawdown, wf.payload.maxDrawdown) > p.maxDrawdown) { verdict = 'REJECTED'; reason = 'Research edge is non-positive or drawdown exceeds policy.'; }
    else if (trigger.type === 'TradeResult') {
      if (paper.length < p.minPaperTrades || closedCycles < p.minPaperTrades || paper.length > 256) { verdict = 'CHUA_XAC_MINH'; reason = 'Insufficient bounded completed paper position cycles; partial reductions do not establish independent closed cycles.'; }
      else {
        const initialCapital = portfolio.performance.cash + portfolio.performance.capitalUsed - portfolio.performance.realizedPnl;
        let equity = initialCapital, peak = initialCapital, drawdown = 0;
        for (const trade of paper) { equity += trade.realizedPnl; peak = Math.max(peak, equity); drawdown = Math.max(drawdown, (peak - equity) / peak); }
        const pnl = paper.reduce((sum, t) => sum + t.realizedPnl, 0);
        if (!Number.isFinite(initialCapital) || initialCapital <= 0 || portfolio.performance.maxDrawdown === null) { verdict = 'CHUA_XAC_MINH'; reason = 'Paper valuation history is incomplete.'; }
        else if (pnl <= 0 || drawdown > p.maxDrawdown || portfolio.performance.maxDrawdown > p.maxDrawdown) { verdict = 'REJECTED'; reason = 'Computed paper expectancy is non-positive or drawdown exceeds policy.'; }
        else reason = 'Computed closed paper expectancy and drawdown satisfy policy alongside research evidence; commander approval still required.';
      }
    }
    emit(trigger, 'critique.' + createHash('sha256').update(proposal.id).digest('hex').slice(0, 16), 'ProposalCritique', { proposalId: proposal.id, backtestId: bt.id, walkForwardId: wf.id, paperTradeIds: paperIds, verdict, reason }, [...refs, ...paperIds], verdict === 'CHUA_XAC_MINH' ? [reason] : []);
  }
  function handle(input, context, ticket) {
    if (!running || generation !== ticket || context.signal.aborted) throw Error('FORENSIC_STOPPED');
    const state = runtime.snapshot(), index = state.events.findIndex(e => e.id === input.id);
    if (index < 0) throw Error('FORENSIC_INPUT_NOT_PERSISTED');
    const all = state.events.slice(0, index + 1), portfolio = tradeStore.snapshot({ throughId: input.id });
    if (input.type === 'StrategyProposal') {
      const watched = input.payload.lifecycle !== 'CHALLENGER';
      if (!watched) critique(input, input, portfolio, all);
      emit(input, 'activity', 'AIActivityEvent', { agent: 'CODEX_3', task: input.id, state: watched ? 'WAITING' : 'COMPLETED', progress: null, message: watched ? 'One task: critique challenger proposals. Waiting for a challenger. No order and no strategy approval.' : 'One task: critiqued the challenger proposal. No order and no strategy approval.' }, [input.id], watched ? ['No challenger proposal to critique.'] : []);
      return;
    }
    const t = input.payload, row = portfolio.trades.find(e => e.id === input.id);
    if (!row) throw Error('FORENSIC_TRADE_PROJECTION_MISSING');
    const snapshot = runtime.get(t.snapshotId), intent = runtime.get(t.intentId), decision = runtime.get(t.decisionId), regime = decision && runtime.get(decision.payload.regimeId);
    let explained = false;
    const price = t.side === 'BUY' ? t.entryPrice : t.exitPrice;
    const adverseBps = intent && (t.side === 'BUY' ? price / intent.payload.referencePrice - 1 : 1 - price / intent.payload.referencePrice) * 10000;
    if (adverseBps > p.maxSlippageBps) { report(input, 'EXECUTION_FAILURE', 'Observed fill differs adversely from the execution reference beyond slippage policy.', [intent.id]); explained = true; }
    if (snapshot && Date.parse(input.timestamp) - Date.parse(snapshot.payload.observedAt) > p.maxSnapshotAgeMs) { report(input, 'DATA_FAILURE', 'Trade used a market observation older than the configured freshness limit.', [snapshot.id]); explained = true; }
    const proposals = all.filter(e => e.type === 'StrategyProposal' && e.network === input.network && e.epoch === input.epoch && e.payload.strategyVersion === t.strategyVersion && e.payload.lifecycle === 'CHALLENGER');
    const latest = proposals.at(-1);
    if (latest && regime && !latest.payload.regimes.includes(regime.payload.regime)) { report(input, 'MARKET_REGIME_FAILURE', 'Decision regime falls outside the strategy proposal supported regimes.', [latest.id, regime.id, decision.id]); explained = true; }
    if (row.realizedPnl < 0 && !explained) report(input, null, 'Computed position cost basis and fill proceeds establish a loss; its causal origin remains unresolved.', [t.intentId, t.snapshotId], true);
    if (latest && t.state === 'CLOSED') critique(latest, input, portfolio, all);
    emit(input, 'activity', 'AIActivityEvent', { agent: 'CODEX_3', task: input.id, state: 'COMPLETED', progress: null, message: 'One task: inspected this paper fill for slippage, stale data, regime mismatch and loss. No new order.' }, [input.id]);
  }
  return { start() { if (running) return; running = true; const ticket = ++generation; try { for (const type of ['TradeResult', 'StrategyProposal']) detach.push(runtime.subscribeDurable('forensic.v1.' + type, type, (input, context) => handle(input, context, ticket))); } catch (error) { running = false; detach.forEach(f => f()); detach = []; throw error; } }, stop() { running = false; generation++; detach.forEach(f => f()); detach = []; } };
}
module.exports = { createForensic, DEFAULT_POLICY };
