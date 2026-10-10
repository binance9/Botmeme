'use strict';
const { derived } = require('../../runtime/events/derived.cjs');
function strategyState(events, network, epoch) {
  const versions = new Map();
  for (const event of events) {
    if (event.network !== network || event.epoch !== epoch) continue;
    if (event.type === 'StrategyProposal') {
      const old = versions.get(event.payload.strategyVersion);
      versions.set(event.payload.strategyVersion, { ...old, proposal: event, stage: old?.lifecycle ? old.stage : event.payload.lifecycle });
    }
    if (event.type === 'StrategyLifecycleDecision') {
      const old = versions.get(event.payload.strategyVersion);
      if (old) versions.set(event.payload.strategyVersion, { ...old, stage: event.payload.stage, lifecycle: event });
    }
  }
  return [...versions.values()];
}
function validateLifecycle(event, events) {
  if (event.type !== 'StrategyLifecycleDecision') return;
  const p = event.payload, proposal = events.get(p.proposalId);
  if (!proposal || proposal.type !== 'StrategyProposal' || proposal.payload.lifecycle !== 'CHALLENGER' || proposal.payload.strategyVersion !== p.strategyVersion) throw Error('INVALID_LIFECYCLE_PROPOSAL');
  const state = strategyState([...events.values()], event.network, event.epoch).find(s => s.proposal.payload.strategyVersion === p.strategyVersion);
  if ((state?.lifecycle?.id ?? null) !== p.previousId) throw Error('LIFECYCLE_FORK');
  const allowed = { PAPER_EVALUATION: ['CHALLENGER'], CODEX_3_CRITIQUE: ['PAPER_EVALUATION'], CODEX_1_DECISION: ['CODEX_3_CRITIQUE'], CHAMPION: ['CODEX_1_DECISION'], DISABLED: ['PAPER_EVALUATION', 'CODEX_3_CRITIQUE', 'CODEX_1_DECISION', 'CHAMPION'] };
  if (!allowed[p.stage]?.includes(state?.stage)) throw Error('INVALID_LIFECYCLE_TRANSITION');
  const bt = events.get(proposal.payload.backtestId), wf = events.get(proposal.payload.walkForwardId);
  if (!bt || !wf || bt.payload.strategyVersion !== p.strategyVersion || wf.payload.strategyVersion !== p.strategyVersion || wf.payload.backtestId !== bt.id || bt.status !== 'COMPLETED' || wf.status !== 'COMPLETED') throw Error('UNVERIFIED_LIFECYCLE_EVIDENCE');
  if (p.stage !== 'DISABLED' && (bt.payload.expectancy <= 0 || wf.payload.outOfSamplePnl <= 0)) throw Error('NO_VALIDATED_EDGE');
  if (['CODEX_3_CRITIQUE', 'CODEX_1_DECISION', 'CHAMPION'].includes(p.stage)) {
    const critic = events.get(p.critiqueId);
    if (!critic || critic.payload.verdict !== 'SUPPORTED' || critic.payload.proposalId !== p.proposalId || critic.payload.paperTradeIds.length < 5 || critic.missing_evidence.length) throw Error('PAPER_CRITIQUE_REQUIRED');
  }
}
function transition(runtime, source, proposal, stage, critique = null) {
  const state = strategyState(runtime.snapshot().events, source.network, source.epoch).find(s => s.proposal.payload.strategyVersion === proposal.payload.strategyVersion);
  const event = derived(source, { producer: 'CODEX_1', type: 'StrategyLifecycleDecision', status: 'APPROVED', evidence: [proposal.id, ...(critique ? [critique.id] : [])], variant: proposal.payload.strategyVersion + ':' + stage, missing_evidence: [],
    payload: { strategyVersion: proposal.payload.strategyVersion, proposalId: proposal.id, stage, previousId: state?.lifecycle?.id ?? null, critiqueId: critique?.id ?? null, reason: stage === 'PAPER_EVALUATION' ? 'Cost-adjusted research evidence admits bounded paper evaluation only.' : 'Evidence-backed lifecycle transition; historical version preserved.' } });
  if (runtime.get(event.id)) return runtime.get(event.id);
  runtime.publish(event); return event;
}
module.exports = { strategyState, validateLifecycle, transition };
