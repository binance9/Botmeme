'use strict';
const { createHash } = require('node:crypto');
const DEFAULT_POLICY = Object.freeze({ slippageBps: 10, feeBps: 10, maxIntentAgeMs: 60000, maxQuoteAgeMs: 60000, minQuality: 0.7, requireSafetyVerdict: false });
function createPaperExecution({ runtime, tradeStore, now = () => new Date(), policy = {} } = {}) {
  if (!runtime || !['get', 'snapshot', 'publish', 'subscribeDurable'].every(k => typeof runtime[k] === 'function') || typeof tradeStore?.snapshot !== 'function' || typeof now !== 'function') throw Error('INVALID_PAPER_RUNTIME');
  const p = { ...DEFAULT_POLICY, ...policy };
  if (typeof p.requireSafetyVerdict !== 'boolean') throw Error('INVALID_PAPER_POLICY');
  if (Object.keys(p).some(k => !Object.hasOwn(DEFAULT_POLICY, k)) || !['slippageBps', 'feeBps'].every(k => Number.isFinite(p[k]) && p[k] >= 0 && p[k] <= 1000) || !['maxIntentAgeMs', 'maxQuoteAgeMs'].every(k => Number.isSafeInteger(p[k]) && p[k] > 0 && p[k] <= 3600000) || !Number.isFinite(p.minQuality) || p.minQuality < 0.5 || p.minQuality > 1) throw Error('INVALID_PAPER_POLICY');
  let running = false, generation = 0, detach = null;
  const id = (intent, suffix) => 'paper.' + suffix + '/' + createHash('sha256').update(intent.id).digest('hex');
  function envelope(intent, quote, eventId, type, payload, status, missing = []) {
    return { id: eventId, type, timestamp: quote.timestamp, producer: 'PAPER_EXECUTION', source: 'paper.next-observation', evidence: [intent.id, quote.id, intent.payload.riskDecisionId], status, correlationId: intent.correlationId, network: intent.network, epoch: intent.epoch, confidence: missing.length ? 0 : quote.confidence, evidence_quality: missing.length ? 0 : quote.evidence_quality, uncertainty: missing.length ? 1 : quote.uncertainty, missing_evidence: missing, payload };
  }
  function fail(intent, quote, message) {
    const eventId = id(intent, 'failure');
    if (!runtime.get(eventId)) runtime.publish(envelope(intent, quote, eventId, 'AIActivityEvent', { agent: 'PAPER_EXECUTION', task: intent.id, state: 'FAILED', progress: null, message }, 'FAILED', [message]));
  }
  function commit(intent, quote, limits) {
    if (intent.payload.mode === 'live' || runtime.executionMode?.() === 'live') return;
    if (runtime.get(id(intent, 'fill')) || runtime.get(id(intent, 'failure')) || runtime.snapshot().events.some(e => e.type === 'TradeResult' && e.payload.intentId === intent.id)) return;
    const ip = intent.payload, risk = runtime.get(ip.riskDecisionId), clock = now();
    const decision = runtime.get(ip.decisionId);
    const manual = decision?.producer === 'CODEX_1' && ['commander.manual-paper-entry', 'commander.manual-paper-exit'].includes(decision.source);
    const manualExit = manual && decision.source === 'commander.manual-paper-exit' && ip.action === 'SELL';
    if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) throw Error('INVALID_PAPER_CLOCK');
    const age = limits.immediate ? clock.getTime() - Date.parse(intent.timestamp) : Date.parse(quote.timestamp) - Date.parse(intent.timestamp);
    const quoteAge = clock.getTime() - Date.parse(quote.payload.observedAt);
    const reliable = quote.evidence.length && !quote.missing_evidence.length && ['OBSERVED', 'COMPLETED'].includes(quote.status) && quote.confidence >= p.minQuality && quote.evidence_quality >= p.minQuality && quote.uncertainty <= 1 - p.minQuality;
    if (age < 0 || age > limits.intentMs || clock.getTime() - Date.parse(intent.timestamp) > limits.intentMs || quoteAge < 0 || !manualExit && quoteAge > limits.quoteMs || !reliable) { fail(intent, quote, 'Intent expired or next quote is stale, future-dated or unreliable.'); return; }
    if (!risk || !risk.payload.approved || risk.payload.decisionId !== ip.decisionId || risk.network !== intent.network || risk.epoch !== intent.epoch || ip.quantity > risk.payload.quantity) { fail(intent, quote, 'Risk approval is missing or inconsistent.'); return; }
    if (clock.getTime() - Date.parse(risk.timestamp) > limits.intentMs) { fail(intent, quote, 'Risk approval expired before execution.'); return; }
    if (ip.action === 'BUY' && p.requireSafetyVerdict) {
      const safety = runtime.snapshot().events.filter(e => e.type === 'SafetyDecision' && e.network === intent.network && e.epoch === intent.epoch && e.payload.candidateId === ip.candidateId).at(-1);
      if (!safety) return; // verdict still queued — stay retryable on the next quote; the gate lands within minutes
      if (!safety.payload.approved) { fail(intent, quote, 'Safety verdict missing or rejected for this candidate.'); return; }
    }
    const lifecycle = runtime.snapshot().events.filter(e => e.type === 'StrategyLifecycleDecision' && e.network === intent.network && e.epoch === intent.epoch && e.payload.strategyVersion === ip.strategyVersion).at(-1);
    if (ip.action === 'BUY' && lifecycle?.payload.stage === 'DISABLED') { fail(intent, quote, 'Strategy was disabled after approval; new exposure is forbidden.'); return; }
    const portfolio = tradeStore.snapshot(), position = portfolio.positions.find(row => row.network === intent.network && row.token === ip.token);
    if (!manual && portfolio.trades.some(row => Date.parse(row.timestamp) > Date.parse(quote.timestamp))) { fail(intent, quote, 'Source quote predates a committed fill; retrospective execution is forbidden.'); return; }
    const fillPrice = quote.payload.price * (1 + (ip.action === 'BUY' ? 1 : -1) * p.slippageBps / 10000);
    let quantity = ip.quantity;
    if (ip.action === 'BUY') {
      const unitCost = fillPrice * (1 + p.feeBps / 10000);
      const budget = Math.min(portfolio.performance.cash, risk.payload.maxExposureUsd);
      quantity = Math.min(quantity, budget / unitCost);
      if (quantity * fillPrice + quantity * fillPrice * p.feeBps / 10000 > budget) quantity *= 1 - 4 * Number.EPSILON;
    } else if (!position || quantity > position.quantity) { fail(intent, quote, 'Exit quantity exceeds the authoritative open position.'); return; }
    const fees = quantity * fillPrice * p.feeBps / 10000;
    if (![fillPrice, quantity, fees].every(Number.isFinite) || fillPrice <= 0 || quantity <= 0 || fees < 0) { fail(intent, quote, 'No finite quantity fits approved capital and exposure constraints.'); return; }
    const realizedPnl = ip.action === 'BUY' ? 0 : quantity * fillPrice - fees - position.costBasis * quantity / position.quantity;
    if (!Number.isFinite(realizedPnl)) { fail(intent, quote, 'Computed fill result is not finite.'); return; }
    const stamped = limits.immediate ? { ...quote, timestamp: clock.toISOString() } : quote;
    runtime.publish(envelope(intent, stamped, id(intent, 'fill'), 'TradeResult', { mode: 'paper', intentId: intent.id, token: ip.token, candidateId: ip.candidateId, snapshotId: ip.snapshotId, signalIds: ip.signalIds, strategyVersion: ip.strategyVersion, decisionId: ip.decisionId, riskDecisionId: ip.riskDecisionId, side: ip.action, quantity, entryPrice: ip.action === 'BUY' ? fillPrice : position.averageCost, exitPrice: ip.action === 'BUY' ? null : fillPrice, realizedPnl, fees, slippageBps: p.slippageBps, state: ip.action === 'BUY' ? 'OPEN' : 'CLOSED' }, 'COMPLETED'));
  }
  function handle(quote, context, ticket) {
    if (!running || ticket !== generation || context.signal.aborted) throw Error('PAPER_EXECUTION_STOPPED');
    const state = runtime.snapshot(), index = state.events.findIndex(e => e.id === quote.id);
    if (index < 0) throw Error('PAPER_QUOTE_NOT_PERSISTED');
    const intents = state.events.slice(0, index).filter(e => e.type === 'ExecutionIntent' && e.network === quote.network && e.epoch === quote.epoch && e.payload.token === quote.payload.token && Date.parse(e.timestamp) < Date.parse(quote.timestamp) && Date.parse(e.timestamp) < Date.parse(quote.payload.observedAt));
    for (const intent of intents) commit(intent, quote, { intentMs: p.maxIntentAgeMs, quoteMs: p.maxQuoteAgeMs });
  }
  function settleMeme(intent, context, ticket) {
    if (!running || ticket !== generation || context.signal.aborted) throw Error('PAPER_EXECUTION_STOPPED');
    if (intent.payload.strategyVersion !== 'meme-flow-v1') return;
    if (intent.payload.action !== 'BUY' && intent.payload.action !== 'SELL' && intent.payload.action !== 'REDUCE') return;
    const quote = runtime.get(intent.payload.snapshotId);
    if (!quote || quote.type !== 'MarketSnapshot' || quote.network !== intent.network || quote.epoch !== intent.epoch || quote.payload.token !== intent.payload.token) return;
    // The 5-minute scan will not produce a second print before a 60-second intent
    // expires. Meme entries AND protective exits settle on the triggering quote
    // itself: an exit that waited for the next scan would always be too late.
    // 15-minute tolerance matches the commander/risk quote-freshness windows.
    commit(intent, quote, { immediate: true, intentMs: 900000, quoteMs: 900000 });
  }
  return { start() { if (running) return; running = true; const ticket = ++generation; const stops = []; try { stops.push(runtime.subscribeDurable('paper.v1.MarketSnapshot', 'MarketSnapshot', (e, context) => handle(e, context, ticket))); stops.push(runtime.subscribeDurable('paper.v1.ExecutionIntent', 'ExecutionIntent', (e, context) => settleMeme(e, context, ticket))); detach = () => stops.forEach(stop => stop()); } catch (error) { running = false; stops.forEach(stop => stop()); throw error; } }, stop() { running = false; generation++; detach?.(); detach = null; } };
}
module.exports = { createPaperExecution, DEFAULT_POLICY };
