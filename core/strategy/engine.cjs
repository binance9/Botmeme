'use strict';
const { derived } = require('../../runtime/events/derived.cjs');
const { strategyState } = require('./lifecycle.cjs');
function createStrategyEngine({ runtime, now = () => new Date(), maxAgeMs = 900000 }) {
  // 15-minute approval window: risk decisions inherit the snapshot timestamp,
  // and the funnel (gate queue, JEV, delivery) needs minutes — a 60s bound
  // silently expired every approval before an intent could be created.
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) throw Error('INVALID_STRATEGY_POLICY');
  let running = false, generation = 0, detach = [];
  function features(source) {
    const all = runtime.snapshot().events, index = all.findIndex(e => e.id === source.id), prior = all.slice(0, index);
    const candidate = prior.filter(e => e.type === 'TokenCandidate' && e.network === source.network && e.epoch === source.epoch && e.payload.token === source.payload.token).at(-1);
    if (!candidate) return;
    const eventId = derived(source, { producer: 'STRATEGY_ENGINE', type: 'SignalObservation', payload: {} }).id;
    if (runtime.get(eventId)) return;
    const previous = prior.filter(e => e.type === 'MarketSnapshot' && e.network === source.network && e.epoch === source.epoch && e.payload.token === source.payload.token).at(-1);
    const signals = [{ name: 'price', value: source.payload.price }];
    const change = previous ? source.payload.price / previous.payload.price - 1 : null;
    if (change !== null && Number.isFinite(change)) signals.push({ name: 'price_change_fraction', value: change });
    runtime.publish(derived(source, { producer: 'STRATEGY_ENGINE', type: 'SignalObservation', evidence: [source.id, candidate.id, ...(previous ? [previous.id] : [])], payload: { candidateId: candidate.id, snapshotId: source.id, signals } }));
  }
  function intent(risk) {
    if (!risk.payload.approved) return;
    const decision = runtime.get(risk.payload.decisionId), snapshot = runtime.get(decision.payload.snapshotId);
    const eventId = derived(risk, { producer: 'STRATEGY_ENGINE', type: 'ExecutionIntent', payload: {} }).id;
    if (runtime.get(eventId)) return;
    const clock = now();
    if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) throw Error('INVALID_STRATEGY_CLOCK');
    const age = clock.getTime() - Date.parse(risk.timestamp);
    const state = strategyState(runtime.snapshot().events, risk.network, risk.epoch).find(s => s.proposal.payload.strategyVersion === decision.payload.strategyVersion);
    const memeEntry = decision.payload.strategyVersion === 'meme-flow-v1' && decision.payload.action === 'BUY';
    if (age < 0 || age > maxAgeMs || decision.payload.action === 'BUY' && !memeEntry && !['CHAMPION', 'PAPER_EVALUATION'].includes(state?.stage)) {
      const event = derived(risk, { producer: 'STRATEGY_ENGINE', type: 'AIActivityEvent', status: 'FAILED', missing_evidence: ['Risk approval expired or strategy version is no longer eligible.'],
        payload: { agent: 'STRATEGY_ENGINE', task: risk.id, state: 'FAILED', progress: null, message: 'No intent: approval expired or strategy disabled.' } });
      if (!runtime.get(event.id)) runtime.publish(event);
      return;
    }
    runtime.publish(derived(risk, { producer: 'STRATEGY_ENGINE', type: 'ExecutionIntent', status: 'APPROVED', evidence: [risk.id, decision.id, snapshot.id], missing_evidence: [],
      payload: { mode: runtime.executionMode?.() ?? 'paper', token: snapshot.payload.token, candidateId: decision.payload.candidateId, snapshotId: snapshot.id, signalIds: decision.payload.signalIds, strategyVersion: decision.payload.strategyVersion,
        decisionId: decision.id, riskDecisionId: risk.id, action: decision.payload.action, quantity: risk.payload.quantity, referencePrice: snapshot.payload.price } }));
  }
  return {
    start() {
      if (running) return; running = true; const ticket = ++generation;
      try { for (const [type, handle] of [['MarketSnapshot', features], ['RiskDecision', intent]]) detach.push(runtime.subscribeDurable('strategy.v1.' + type, type, (e, { signal }) => { if (!running || generation !== ticket || signal.aborted) throw Error('STRATEGY_STOPPED'); handle(e); })); }
      catch (error) { running = false; detach.forEach(f => f()); detach = []; throw error; }
    },
    stop() { running = false; generation++; detach.forEach(f => f()); detach = []; }
  };
}
module.exports = { createStrategyEngine };
