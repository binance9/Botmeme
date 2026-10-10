'use strict';
const { randomUUID } = require('node:crypto');
const { createRiskEngine } = require('../../core/risk/engine.cjs');
const { createStrategyEngine } = require('../../core/strategy/engine.cjs');
const { createManualPaperExecution: createPaperExecution } = require('../../runtime/manual-paper-execution.cjs');

// Operator exits use the same independent risk -> intent -> paper consumers.
// Filtered, non-replaying subscriptions allow an exit while scanning is stopped,
// without restarting acquisition or replaying unrelated BUY decisions.
async function executeManualExit({ runtime, tradeStore, now = () => new Date() }, body) {
  if (!body || Object.keys(body).sort().join(',') !== 'execute,percent,side,tradeId' || body.execute !== true || body.side !== 'SELL' || body.percent !== 100 || typeof body.tradeId !== 'string') {
    throw Object.assign(Error('INVALID_PAPER_EXIT_REQUEST'), { status: 400 });
  }
  const state = runtime.snapshot(), portfolio = tradeStore.snapshot();
  const trade = portfolio.trades.find(t => t.id === body.tradeId && t.side === 'BUY' && t.positionState === 'OPEN');
  if (!trade) throw Error('OPEN_POSITION_NOT_FOUND');
  if (trade.network !== state.network || trade.epoch !== state.epoch) throw Error('POSITION_SESSION_MISMATCH');
  if (trade.strategyVersion !== 'meme-flow-v1') throw Error('MANUAL_EXIT_REQUIRES_MEME_POSITION');
  const marketQuote = state.events.filter(e => e.type === 'MarketSnapshot' && e.network === state.network && e.epoch === state.epoch && e.payload.token === trade.token && Date.parse(e.payload.observedAt) <= now().getTime())
    .sort((a, b) => Date.parse(a.payload.observedAt) - Date.parse(b.payload.observedAt) || Date.parse(a.timestamp) - Date.parse(b.timestamp)).at(-1);
  const regime = state.events.findLast(e => e.type === 'MarketRegimeState' && e.network === state.network && e.epoch === state.epoch);
  const position = portfolio.positions.find(p => p.network === trade.network && p.token === trade.token);
  // A scoped valuation of the committed entry, never a fabricated market observation.
  const quote = marketQuote ?? { ...runtime.get(trade.id), type: 'MarketSnapshot', status: 'OBSERVED', confidence: 1, evidence_quality: 1, uncertainty: 0, missing_evidence: [], evidence: [trade.id],
    payload: { token: trade.token, price: position?.averageCost ?? trade.entryPrice, observedAt: now().toISOString() } };
  const quoteAgeMs = now().getTime() - Date.parse(quote.payload.observedAt);
  const note = !marketQuote ? 'no market quote; settled at entry basis' : quoteAgeMs > 900000 ? 'stale quote accepted, quoteAgeMs=' + quoteAgeMs : 'quoteAgeMs=' + quoteAgeMs;
  const correlationId = 'manual-exit/' + randomUUID();
  const scoped = { ...runtime,
    get: id => !marketQuote && id === quote.id ? quote : runtime.get(id),
    snapshot: () => { const current = runtime.snapshot(); return marketQuote ? current : { ...current, events: current.events.map(e => e.id === quote.id ? quote : e) }; },
    subscribeDurable: (_id, type, handle) => runtime.subscribe(type, (event, context) => {
    if (event.correlationId === correlationId || _id.startsWith('paper.manual.')) return handle(event, context);
  }) };
  const inputs = { runtime: scoped, tradeStore, now };
  const modules = [createRiskEngine({ ...inputs, policy: { manualExitMaxQuoteAgeMs: Number.MAX_SAFE_INTEGER } }), createStrategyEngine(inputs), createPaperExecution({ ...inputs, policy: { requireSafetyVerdict: true, maxIntentAgeMs: 900000, maxQuoteAgeMs: 900000 } })];
  const decision = {
    id: correlationId, type: 'StrategyDecision', timestamp: now().toISOString(), producer: 'CODEX_1', source: 'commander.manual-paper-exit',
    evidence: [...new Set([trade.id, quote.id, ...(regime ? [regime.id] : [])])], status: 'APPROVED', correlationId, network: state.network, epoch: state.epoch,
    confidence: quote.confidence, evidence_quality: quote.evidence_quality, uncertainty: quote.uncertainty, missing_evidence: [],
    payload: { candidateId: trade.candidateId, snapshotId: quote.id, signalIds: [], strategyVersion: trade.strategyVersion,
      quantEvidenceIds: [], criticReportIds: [], regimeId: regime?.id ?? trade.id, action: 'SELL', disposition: 'EXIT', reason: 'Operator requested SELL 100% of the remaining PAPER position; ' + note }
  };
  try {
    modules.forEach(module => module.start());
    runtime.publish(decision);
    await runtime.flush();
    const events = runtime.snapshot().events.filter(e => e.correlationId === correlationId);
    const fill = events.find(e => e.type === 'TradeResult');
    const risk = events.find(e => e.type === 'RiskDecision');
    const failure = events.find(e => e.type === 'AIActivityEvent' && e.status === 'FAILED');
    const intent = events.find(e => e.type === 'ExecutionIntent');
    return { submitted: true, mode: 'paper', side: 'SELL', percent: 100, decisionId: decision.id,
      status: fill ? 'FILLED' : risk?.payload.approved === false || failure ? 'REJECTED' : 'PENDING',
      fillId: fill?.id ?? null, intentId: intent?.id ?? null, quantity: fill?.payload.quantity ?? null,
      reason: failure?.payload.message ?? risk?.payload.reason ?? 'Awaiting pipeline receipt.' };
  } finally { modules.slice().reverse().forEach(module => module.stop()); }
}
module.exports = { executeManualExit };
