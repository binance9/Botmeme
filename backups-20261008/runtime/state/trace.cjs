'use strict';
const { validateLifecycle } = require('../../core/strategy/lifecycle.cjs');
const REFERENCES = Object.freeze({
  snapshotId: ['MarketSnapshot'], candidateId: ['TokenCandidate'],
  signalIds: ['SignalObservation'], quantEvidenceIds: ['BacktestResult', 'WalkForwardResult'],
  criticReportIds: ['RootCauseReport', 'ProposalCritique'], regimeId: ['MarketRegimeState'],
  proposalId: ['StrategyProposal'], backtestId: ['BacktestResult'], walkForwardId: ['WalkForwardResult'],
  decisionId: ['StrategyDecision'], riskDecisionId: ['RiskDecision'],
  intentId: ['ExecutionIntent'], tradeId: ['TradeResult'], failureId: ['FailureReport'],
  snapshotIds: ['MarketSnapshot'], paperTradeIds: ['TradeResult'], critiqueId: ['ProposalCritique'], previousId: ['StrategyLifecycleDecision']
});
function validateTrace(event, events) {
  const decision = event.type === 'StrategyDecision' ? event : events.get(event.payload.decisionId);
  const manualExit = decision?.producer === 'CODEX_1' && decision.source === 'commander.manual-paper-exit' && decision.payload.action === 'SELL';
  for (const [field, types] of Object.entries(REFERENCES)) {
    const value = event.payload[field];
    if (value == null) continue;
    for (const id of Array.isArray(value) ? value : [value]) {
      const parent = events.get(id);
      // Manual exits may cite the committed BUY as their entry-basis valuation.
      // The durable reference remains a TradeResult, never a fake market quote.
      const entryBasis = manualExit && ['snapshotId', 'regimeId'].includes(field) && parent?.type === 'TradeResult' && parent.payload.mode === 'paper' && parent.payload.side === 'BUY' && parent.payload.candidateId === decision.payload.candidateId && decision.evidence.includes(parent.id);
      if (!parent || !types.includes(parent.type) && !entryBasis) throw Error('MISSING_OR_INVALID_TRACE:' + field);
      if (parent.network !== event.network || parent.epoch !== event.epoch) throw Error('CROSS_NETWORK_TRACE:' + field);
      if (Date.parse(parent.timestamp) > Date.parse(event.timestamp)) throw Error('FUTURE_TRACE:' + field);
    }
  }
  const payload = event.payload;
  validateLifecycle(event, events);
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  if (['TokenCandidate', 'SignalObservation', 'StrategyDecision'].includes(event.type)) {
    const snapshot = events.get(payload.snapshotId);
    if (event.type === 'TokenCandidate' && payload.token !== snapshot.payload.token) throw Error('CANDIDATE_TOKEN_MISMATCH');
    if (payload.candidateId) {
      const candidate = events.get(payload.candidateId);
      if (candidate.payload.token !== snapshot.payload.token) throw Error('CANDIDATE_SNAPSHOT_MISMATCH');
    }
  }
  if (event.type === 'StrategyDecision') {
    for (const id of payload.signalIds) {
      const signal = events.get(id);
      if (signal.payload.snapshotId !== payload.snapshotId) throw Error('DECISION_SIGNAL_MISMATCH');
      if (signal.payload.candidateId !== payload.candidateId) {
        // Approved resolution (nhiệm vụ 4): a re-screened token gets a fresh
        // TokenCandidate event, so the commander may carry an older signal onto
        // the token's CURRENT candidate — only for CODEX_1, only the same
        // token/network/epoch, and the decision evidence must cite signal +
        // original + current candidate so the audit trail stays complete.
        const original = events.get(signal.payload.candidateId), current = events.get(payload.candidateId);
        if (event.producer !== 'CODEX_1' || !original || !current || original.type !== 'TokenCandidate' || current.type !== 'TokenCandidate' ||
          original.network !== event.network || original.epoch !== event.epoch || current.network !== event.network || current.epoch !== event.epoch ||
          original.payload.token !== current.payload.token ||
          ![signal.id, original.id, current.id].every(ref => event.evidence.includes(ref))) throw Error('DECISION_SIGNAL_MISMATCH');
      }
    }
  }
  if (event.type === 'ExecutionIntent') {
    const risk = events.get(payload.riskDecisionId), decision = events.get(payload.decisionId);
    if (!risk.payload.approved || risk.payload.decisionId !== decision.id || payload.quantity > risk.payload.quantity || payload.action !== decision.payload.action) throw Error('RISK_VETO_OR_DECISION_MISMATCH');
    for (const key of ['candidateId', 'snapshotId', 'strategyVersion']) if (payload[key] !== decision.payload[key]) throw Error('INTENT_TRACE_MISMATCH');
    if (!same(payload.signalIds, decision.payload.signalIds) || payload.token !== events.get(payload.snapshotId).payload.token) throw Error('INTENT_TRACE_MISMATCH');
    if (event.correlationId !== decision.correlationId || risk.correlationId !== decision.correlationId) throw Error('INTENT_CORRELATION_MISMATCH');
  }
  if (event.type === 'TradeResult') {
    const intent = events.get(payload.intentId);
    for (const key of ['token', 'candidateId', 'snapshotId', 'strategyVersion', 'decisionId', 'riskDecisionId']) if (payload[key] !== intent.payload[key]) throw Error('TRADE_TRACE_MISMATCH');
    if (!same(payload.signalIds, intent.payload.signalIds) || payload.side !== intent.payload.action || event.correlationId !== intent.correlationId) throw Error('TRADE_TRACE_MISMATCH');
    const filled = [...events.values()].filter(e => e.type === 'TradeResult' && e.payload.intentId === intent.id).reduce((sum, e) => sum + e.payload.quantity, 0);
    // Exact-in live swaps can receive more tokens than the indicative quote.
    // Their executor enforces the approved USD spend before signing.
    if (!Number.isFinite(filled + payload.quantity) || payload.mode !== 'live' && filled + payload.quantity > intent.payload.quantity || payload.mode === 'live' && filled > 0) throw Error('TRADE_EXCEEDS_INTENT');
  }
}
module.exports = { validateTrace, REFERENCES };
