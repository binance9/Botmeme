'use strict';
const { createHash } = require('node:crypto');
const { createPaperExecution } = require('../core/execution/paper.cjs');

// Keep core settlement, sizing and receipts intact. Only operator orders may
// select a newer execution quote; their approved snapshot reference never moves.
function createManualPaperExecution({ runtime, tradeStore, now = () => new Date(), policy = {} }) {
  let active = null, settle = null;
  const manual = intent => {
    const decision = runtime.get(intent.payload.decisionId);
    return decision?.producer === 'CODEX_1' && ['commander.manual-paper-entry', 'commander.manual-paper-exit'].includes(decision.source);
  };
  function attempt(intent, context) {
    if (intent.payload.mode === 'live' || runtime.executionMode?.() === 'live') return;
    if (runtime.get(intent.payload.decisionId + '/cancelled')) return;
    const state = runtime.snapshot(), clock = now().getTime();
    const jev = state.events.findLast(e => e.type === 'JevVerdict' && e.network === intent.network && e.epoch === intent.epoch && e.payload.candidateId === intent.payload.candidateId);
    if (intent.payload.action === 'BUY' && jev?.payload.action === 'REJECT') {
      const id = 'paper.failure/' + createHash('sha256').update(intent.id).digest('hex');
      if (!runtime.get(id) && !state.events.some(e => e.type === 'TradeResult' && e.payload.intentId === intent.id)) {
        runtime.publish({ ...intent, id, type: 'AIActivityEvent', timestamp: now().toISOString(), producer: 'PAPER_EXECUTION', source: 'commander.manual-paper-entry',
          evidence: [intent.id, jev.id], status: 'FAILED', confidence: 0, evidence_quality: 0, uncertainty: 1, missing_evidence: ['JEV_REJECT'],
          payload: { agent: 'PAPER_EXECUTION', task: intent.id, state: 'FAILED', progress: null, message: 'VETO: Jev verdict REJECT for this candidate.' } });
      }
      return;
    }
    const decision = runtime.get(intent.payload.decisionId);
    const manualExit = decision.source === 'commander.manual-paper-exit' && intent.payload.action === 'SELL';
    const quote = manualExit ? runtime.get(intent.payload.snapshotId) : state.events.filter(e => e.type === 'MarketSnapshot' && e.network === intent.network && e.epoch === intent.epoch && e.payload.token === intent.payload.token &&
      clock - Date.parse(e.payload.observedAt) >= 0 && clock - Date.parse(e.payload.observedAt) <= 900000 &&
      e.evidence.length && !e.missing_evidence.length && ['OBSERVED', 'COMPLETED'].includes(e.status) &&
      e.confidence >= .7 && e.evidence_quality >= .7 && e.uncertainty <= 1 - .7)
      .sort((a, b) => Date.parse(a.payload.observedAt) - Date.parse(b.payload.observedAt) || Date.parse(a.timestamp) - Date.parse(b.timestamp)).at(-1);
    if (!quote) return;
    active = { intent, quote };
    try { settle(intent, context); } finally { active = null; }
  }
  const wrapped = {
    ...runtime,
    get: id => active && id === active.intent.payload.snapshotId ? active.quote : runtime.get(id),
    // The core next-observation consumer must not settle manual intents using
    // an arbitrary arriving quote or revive a cancelled operator request.
    snapshot: () => { const state = runtime.snapshot(); return { ...state, events: state.events.filter(e => e.type !== 'ExecutionIntent' || !manual(e)) }; },
    subscribeDurable(id, type, handle) {
      if (type !== 'ExecutionIntent') return runtime.subscribeDurable(id, type, handle);
      settle = handle;
      const stops = [];
      try {
        stops.push(runtime.subscribeDurable(id, type, (intent, context) => manual(intent) ? attempt(intent, context) : handle(intent, context)));
        for (const trigger of ['SafetyDecision', 'MarketSnapshot']) {
          stops.push(runtime.subscribeDurable('paper.manual.v1.' + trigger, trigger, (event, context) => {
            for (const intent of runtime.snapshot().events.filter(e => e.type === 'ExecutionIntent' && e.network === event.network && e.epoch === event.epoch && manual(e))) {
              if (trigger === 'SafetyDecision' ? intent.payload.candidateId === event.payload.candidateId : intent.payload.token === event.payload.token) attempt(intent, context);
            }
          }));
        }
        return () => stops.forEach(stop => stop());
      } catch (error) { stops.forEach(stop => stop()); throw error; }
    }
  };
  return createPaperExecution({ runtime: wrapped, tradeStore, now, policy });
}
module.exports = { createManualPaperExecution };
