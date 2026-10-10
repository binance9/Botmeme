'use strict';
const { randomUUID } = require('node:crypto');
const { createRiskEngine } = require('../../core/risk/engine.cjs');
const { createStrategyEngine } = require('../../core/strategy/engine.cjs');
const { createSafetyGate } = require('../../core/safety/gate.cjs');
const { createRugCheckReader, createSolanaRpcSafetyReader, createFallbackSafetyReader } = require('../../core/safety/rugcheck.cjs');
const { createManualPaperExecution } = require('../../runtime/manual-paper-execution.cjs');

// Operator entries use the same independent risk -> safety -> intent -> paper
// consumers as the autonomous pipeline. A manual BUY therefore faces the very
// same evidence, freshness and budget discipline; a veto is reported, never
// bypassed. `safetyReaders` is injectable for offline tests.
async function executeManualEntry({ runtime, tradeStore, now = () => new Date(), safetyReaders, waitMs = 5000 }, body) {
  if (!body || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'execute,side,token' || body.execute !== true || body.side !== 'BUY' || typeof body.token !== 'string' || !body.token.trim() || body.token.length > 160) {
    throw Object.assign(Error('INVALID_PAPER_ENTRY_REQUEST'), { status: 400 });
  }
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30000) throw Error('INVALID_MANUAL_WAIT');
  const state = runtime.snapshot();
  const quote = state.events.filter(e => e.type === 'MarketSnapshot' && e.network === state.network && e.epoch === state.epoch && e.payload.token === body.token)
    .sort((a, b) => Date.parse(a.payload.observedAt) - Date.parse(b.payload.observedAt)).at(-1);
  const regime = state.events.findLast(e => e.type === 'MarketRegimeState' && e.network === state.network && e.epoch === state.epoch);
  const candidate = state.events.filter(e => e.type === 'TokenCandidate' && e.network === state.network && e.epoch === state.epoch && e.payload.token === body.token).at(-1);
  if (!quote || !regime || !candidate) return { submitted: false, mode: 'paper', side: 'BUY', status: 'REJECTED', reason: 'ENTRY_MARKET_EVIDENCE_MISSING', fillId: null, intentId: null, quantity: null };
  const correlationId = 'manual-entry/' + randomUUID();
  const scoped = { ...runtime, subscribeDurable: (_id, type, handle) => runtime.subscribe(type, (event, context) => {
    if (event.correlationId === correlationId || _id.startsWith('paper.manual.')) return handle(event, context);
  }) };
  const inputs = { runtime: scoped, tradeStore, now };
  const readers = safetyReaders ?? { SOLANA: createFallbackSafetyReader({ primary: createRugCheckReader({ now }), fallback: createSolanaRpcSafetyReader() }) };
  let screen;
  const controller = new AbortController();
  const gateRuntime = { ...runtime, subscribeDurable: (_id, type, handle) => {
    if (type === 'TokenCandidate') { screen = handle; return () => {}; }
    if (type === 'JevVerdict') return runtime.subscribe(type, (event, context) => {
      if (event.payload.candidateId === candidate.id) return handle(event, context);
    });
    return () => {};
  } };
  const modules = [createRiskEngine(inputs), createStrategyEngine(inputs), createSafetyGate({ runtime: gateRuntime, now, readers }), createManualPaperExecution({ ...inputs, policy: { requireSafetyVerdict: true, maxIntentAgeMs: 900000, maxQuoteAgeMs: 900000 } })];
  const verdict = state.events.findLast(e => e.type === 'SafetyDecision' && e.network === state.network && e.epoch === state.epoch && e.payload.candidateId === candidate.id);
  const decision = {
    id: correlationId, type: 'StrategyDecision', timestamp: now().toISOString(), producer: 'CODEX_1', source: 'commander.manual-paper-entry',
    evidence: [quote.id, regime.id, candidate.id], status: 'APPROVED', correlationId, network: state.network, epoch: state.epoch,
    confidence: quote.confidence, evidence_quality: quote.evidence_quality, uncertainty: quote.uncertainty, missing_evidence: [],
    payload: { candidateId: candidate.id, snapshotId: quote.id, signalIds: [], strategyVersion: 'meme-flow-v1',
      quantEvidenceIds: [], criticReportIds: [], regimeId: regime.id, action: 'BUY', disposition: 'TRADE', reason: 'Operator requested BUY PAPER entry.' }
  };
  try {
    modules.forEach(module => module.start());
    // Screen the persisted identity so all original Jev and safety vetoes apply.
    if (!verdict) screen(candidate, { signal: controller.signal });
    runtime.publish(decision);
    // The safety verdict is an async on-chain read; a single flush can return
    // before it lands. Bounded wait for the terminal TradeResult/failure.
    const deadline = Date.now() + waitMs;
    let fill, risk, failure, intent, safety;
    while (true) {
      const events = runtime.snapshot().events.filter(e => e.correlationId === correlationId);
      fill = events.find(e => e.type === 'TradeResult');
      risk = events.find(e => e.type === 'RiskDecision');
      failure = events.find(e => e.type === 'AIActivityEvent' && e.status === 'FAILED');
      intent = events.find(e => e.type === 'ExecutionIntent');
      safety = runtime.snapshot().events.findLast(e => e.type === 'SafetyDecision' && e.network === state.network && e.epoch === state.epoch && e.payload.candidateId === candidate.id);
      if (fill || risk?.payload.approved === false || failure) break;
      if (Date.now() >= deadline) {
        runtime.publish({ ...decision, id: decision.id + '/cancelled', type: 'AIActivityEvent', timestamp: now().toISOString(), evidence: [decision.id], status: 'FAILED',
          payload: { agent: 'CODEX_1', task: decision.id, state: 'STOPPED', progress: null, message: 'ENTRY_SETTLEMENT_TIMEOUT' } });
        break;
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(0, deadline - Date.now()))));
    }
    return { submitted: true, mode: 'paper', side: 'BUY', decisionId: decision.id,
      status: fill ? 'FILLED' : 'REJECTED',
      fillId: fill?.id ?? null, intentId: intent?.id ?? null, quantity: fill?.payload.quantity ?? null,
      reason: fill ? 'Paper entry filled.' : safety?.payload.approved === false ? safety.payload.reason : failure?.payload.message ?? (risk?.payload.approved === false ? risk.payload.reason : 'ENTRY_SETTLEMENT_TIMEOUT') };
  } finally {
    controller.abort();
    modules.slice().reverse().forEach(module => module.stop());
  }
}
module.exports = { executeManualEntry };
