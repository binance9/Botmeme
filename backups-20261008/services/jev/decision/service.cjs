'use strict';
// Jev decision service — fast structured verdicts for every TokenCandidate.
// Wraps C:\JEV (TypeSafe System One). One JevVerdict per candidate (deterministic
// derived id => restart-safe dedupe). Degrade: any API failure publishes a
// CHUA_XAC_MINH verdict with NO_ACTION so the pipeline keeps moving on rule-quant.
// Jev is advisory here (REJECT is enforced by the safety gate, not this module)
// and NEVER an acceptance provider (docs/JEV-AUDITOR.md).
const { derived } = require('../../../runtime/events/derived.cjs');
const { evaluateCandidate } = require('./jev-client.cjs');

function createJevDecision({ runtime, now = () => new Date() } = {}) {
  if (!runtime || !['get', 'snapshot', 'publish', 'subscribeDurable'].every(k => typeof runtime[k] === 'function')) throw Error('INVALID_JEV_RUNTIME');
  let running = false, generation = 0, detach = null;
  const queue = [];

  async function handle(candidate) {
    const verdictId = derived(candidate, { producer: 'JEV', type: 'JevVerdict', variant: 'v1' }).id;
    if (runtime.get(verdictId)) return;
    const snapshot = runtime.get(candidate.payload.snapshotId);
    const v = await evaluateCandidate({
      token: candidate.payload.token,
      symbol: candidate.payload.symbol,
      network: candidate.network,
      liquidityUsd: snapshot ? snapshot.payload.liquidityUsd : candidate.payload.liquidityUsd,
      volume24hUsd: snapshot ? snapshot.payload.volume24hUsd : candidate.payload.volume24hUsd,
      priceUsd: snapshot ? snapshot.payload.price : null,
      ageMinutes: snapshot && Number.isSafeInteger(snapshot.payload.poolAgeMs) ? snapshot.payload.poolAgeMs / 60000 : null,
      observedAt: snapshot ? snapshot.payload.observedAt : null
    });
    const ok = v && v.ok;
    runtime.publish(derived(candidate, {
      producer: 'JEV', type: 'JevVerdict', variant: 'v1',
      status: ok ? 'COMPLETED' : 'CHUA_XAC_MINH',
      missing_evidence: ok ? [] : ['Jev verdict unavailable: ' + String(v && v.reason || 'unknown')],
      confidence: ok && typeof v.confidence === 'number' ? v.confidence : 0,
      uncertainty: ok ? 0 : 1,
      payload: {
        candidateId: candidate.id,
        action: ok ? v.action : 'NO_ACTION',
        confidence: ok && typeof v.confidence === 'number' ? v.confidence : null,
        tradableProbability: ok && typeof v.tradableProbability === 'number' ? v.tradableProbability : null,
        momentum: ok && typeof v.momentum === 'number' ? v.momentum : null,
        model: ok ? String(v.model || '').slice(0, 100) || 'unknown' : 'unavailable',
        latencyMs: ok && Number.isSafeInteger(v.latencyMs) && v.latencyMs > 0 ? v.latencyMs : 1,
        violations: ok && Array.isArray(v.guardrail && v.guardrail.violations) ? v.guardrail.violations.map(x => String(x).slice(0, 190)) : [String(v && v.reason || 'unavailable').slice(0, 190)]
      }
    }));
  }

  return {
    start() {
      if (running) return; running = true; const ticket = ++generation;
      // Advisory verdicts must never stall the shared delivery chain: a
      // candidate's model call can take tens of seconds and a sweep publishes
      // hundreds of candidates. Evaluations run detached with a small parallel
      // budget — the gate reads each verdict whenever it lands.
      let evaluating = 0;
      const pump = () => {
        while (evaluating < 3 && queue.length) {
          const job = queue.shift();
          evaluating += 1;
          Promise.resolve().then(job).catch(() => {}).finally(() => { evaluating -= 1; pump(); });
        }
      };
      const schedule = job => { if (queue.length < 256) { queue.push(job); pump(); } };
      try {
        detach = runtime.subscribeDurable('jev.decision.v1.TokenCandidate', 'TokenCandidate', (e, context) => {
          if (!running || ticket !== generation || context.signal.aborted) throw Error('JEV_DECISION_STOPPED');
          schedule(() => handle(e));
          return Promise.resolve();
        });
      } catch (error) { running = false; throw error; }
    },
    stop() { running = false; generation++; queue.length = 0; detach?.(); detach = null; }
  };
}
module.exports = { createJevDecision };
