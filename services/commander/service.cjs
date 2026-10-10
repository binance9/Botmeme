'use strict';
const { derived } = require('../../runtime/events/derived.cjs');
const { strategyState, transition } = require('../../core/strategy/lifecycle.cjs');
const { buildWorld } = require('./world.cjs');
const { plan, DEFAULT_POLICY } = require('./decision.cjs');
const { createHash } = require('node:crypto');
const BATCH_LIMIT = 20;
function createCommander({ runtime, tradeStore, now = () => new Date(), policy = {} }) {
  const limits = Object.freeze({ ...DEFAULT_POLICY, ...policy });
  if (Object.keys(limits).some(k => !Object.hasOwn(DEFAULT_POLICY, k) || !Number.isFinite(limits[k]) || limits[k] <= 0) || limits.minConfidence > 1 || limits.minEvidenceQuality > 1 || limits.maxExposureFraction > 1 || limits.maxDrawdown > 1 || !Number.isInteger(limits.maxPositions)) throw Error('INVALID_COMMANDER_POLICY');
  let running = false, generation = 0, detach = [];
  function handle(source, { signal }, ticket) {
    if (!running || ticket !== generation || signal.aborted) throw Error('COMMANDER_STOPPED');
    const activity = derived(source, { producer: 'CODEX_1', type: 'AIActivityEvent', payload: {} }).id;
    if (runtime.get(activity)) return;
    if (source.type === 'ProposalCritique') {
      const proposal = runtime.get(source.payload.proposalId);
      const states = strategyState(runtime.snapshot().events, source.network, source.epoch);
      const current = states.find(s => s.proposal.payload.strategyVersion === proposal.payload.strategyVersion);
      if (source.payload.verdict === 'SUPPORTED' && !source.missing_evidence.length) {
        if (current?.stage === 'CHALLENGER') transition(runtime, source, proposal, 'PAPER_EVALUATION', source);
        if (current?.stage === 'PAPER_EVALUATION' && source.payload.paperTradeIds.length >= 5) {
          transition(runtime, source, proposal, 'CODEX_3_CRITIQUE', source);
          transition(runtime, source, proposal, 'CODEX_1_DECISION', source);
          for (const previous of states.filter(s => s.stage === 'CHAMPION' && s.proposal.payload.strategyVersion !== proposal.payload.strategyVersion)) transition(runtime, source, previous.proposal, 'DISABLED', source);
          transition(runtime, source, proposal, 'CHAMPION', source);
        }
      } else if (source.payload.verdict === 'REJECTED' && current?.lifecycle && current.stage !== 'DISABLED') transition(runtime, source, proposal, 'DISABLED', source);
    }
    const world = buildWorld(runtime, tradeStore, source.id), clock = now();
    if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) throw Error('INVALID_COMMANDER_CLOCK');
    let decided = 0, unresolved = 0, changed = 0;
    const waitingReasons = new Set();
    const byId = new Map(world.candidates.map(c => [c.id, c]));
    const byToken = new Map(world.candidates.map(c => [c.payload.token, c]));
    const visible = new Map(world.local.map(e => [e.id, e]));
    const work = source.type === 'ProposalCritique' ? [] : source.type === 'SignalObservation' ? world.signals.filter(s => s.id === source.id) : world.signals;
    for (const observation of work) {
      const original = visible.get(observation.payload.candidateId);
      const candidate = byId.get(observation.payload.candidateId) ?? byToken.get(original?.payload.token);
      if (!candidate) continue;
      const hasRegime = world.regimes.some(e => e.payload.snapshotIds.includes(observation.payload.snapshotId));
      const key = 'commander.' + createHash('sha256').update(JSON.stringify([observation.network, observation.epoch, observation.id, observation.payload.snapshotId, hasRegime ? 'ready' : 'pending'])).digest('hex');
      if (runtime.hasCheckpoint(key)) continue;
      if (changed >= BATCH_LIMIT) break;
      const decisionId = derived(observation, { producer: 'CODEX_1', type: 'StrategyDecision', payload: {}, variant: key }).id;
      if (runtime.get(decisionId)) { runtime.checkpoint(key); continue; }
      const result = plan(world, candidate, observation, clock, limits);
      if (!result) { unresolved++; runtime.checkpoint(key); changed++; continue; }
      const selected = result.selected;
      // WAIT/HOLD verdicts stay in the activity feed only: publishing one
      // StrategyDecision per observation per token flooded the journal (1.6k
      // NO_ACTION records/hour) and delayed the actionable BUY/SELL path.
      // plan may describe a provisional regime while classification is pending.
      // That placeholder is not persisted evidence and cannot back a decision.
      if (result.action === 'NO_ACTION' || !hasRegime) {
        runtime.checkpoint(key); changed++;
        if (!hasRegime) { unresolved++; waitingReasons.add('Regime evidence missing for signal snapshot.'); }
        if (result.action === 'NO_ACTION') waitingReasons.add(result.reason);
        continue;
      }
      const evidence = [candidate.id, observation.id, observation.payload.snapshotId, result.regime.id, ...(selected ? [selected.proposal.id, selected.backtest.id, selected.walk.id, selected.critic.id] : [])];
      // Approved resolution (nhiệm vụ 4): when the signal referenced an earlier
      // candidate of the same token, cite BOTH candidates so the trace guard
      // (runtime/state/trace.cjs) can verify the substitution end-to-end.
      if (original && original.id !== candidate.id) evidence.push(original.id);
      const action = result.action, missing = action === 'NO_ACTION' ? [result.reason] : [];
      const flow = result.confidenceBasis === 'flow';
      const confidence = Math.min(...(flow ? [candidate.confidence, observation.confidence] : [candidate.confidence, observation.confidence, result.regime.confidence, ...(selected ? [selected.backtest.confidence, selected.walk.confidence, selected.critic.confidence] : [])]));
      const uncertainty = flow ? Math.max(candidate.uncertainty, observation.uncertainty) : Math.max(candidate.uncertainty, observation.uncertainty, result.regime.uncertainty, ...(selected ? [selected.backtest.uncertainty, selected.walk.uncertainty, selected.critic.uncertainty] : []));
      let published;
      try { published = runtime.publish(derived(observation, { producer: 'CODEX_1', type: 'StrategyDecision', variant: key, timestamp: source.timestamp, status: missing.length ? 'CHUA_XAC_MINH' : 'APPROVED', evidence, missing_evidence: missing,
        confidence, uncertainty,
        payload: { candidateId: candidate.id, snapshotId: observation.payload.snapshotId, signalIds: [observation.id], strategyVersion: result.version,
          quantEvidenceIds: selected ? [selected.backtest.id, selected.walk.id] : [], criticReportIds: selected ? [selected.critic.id] : [], regimeId: result.regime.id, action, disposition: result.disposition, reason: result.reason } })); }
      catch (error) { if (error.retryable !== false) throw error; published = { rejected: true }; }
      runtime.checkpoint(key); changed++;
      if (!published?.rejected) decided++;
    }
    if (!changed) return;
    runtime.publish(derived(source, { producer: 'CODEX_1', type: 'AIActivityEvent', status: unresolved ? 'CHUA_XAC_MINH' : 'COMPLETED', missing_evidence: unresolved ? ['Regime evidence missing for pending candidates.'] : [],
      payload: { agent: 'CODEX_1', task: source.id, state: unresolved ? 'WAITING' : 'COMPLETED', progress: null, message: `Compared ${changed} candidates; journaled ${decided} decisions; ${unresolved} awaiting evidence. Objective: preserve capital and require cost-adjusted edge.${waitingReasons.size ? ' Waiting: ' + [...waitingReasons].join(' ') : ''}` } }));
  }
  return {
    start() {
      if (running) return; running = true; const ticket = ++generation;
      try { for (const type of ['SignalObservation', 'ProposalCritique', 'MarketRegimeState', 'RootCauseReport', 'TradeResult']) detach.push(runtime.subscribeDurable('commander.v1.' + type, type, (e, context) => handle(e, context, ticket))); }
      catch (error) { running = false; detach.forEach(f => f()); detach = []; throw error; }
    },
    stop() { running = false; generation++; detach.forEach(f => f()); detach = []; },
    world() { const events = runtime.snapshot().events; return events.length ? buildWorld(runtime, tradeStore, events.at(-1).id) : null; }
  };
}
module.exports = { createCommander };
