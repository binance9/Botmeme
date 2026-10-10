'use strict';
const { createHash } = require('node:crypto');
const { derived } = require('../../runtime/events/derived.cjs');
const { sizeOrder } = require('../market-data/providers/v4-depth.cjs');
const { economicViability } = require('./viability.cjs');
const { DEFAULTS: regimePolicy } = require('../market-data/regime.cjs');
const ENTRY_MIN_VOL_USD = 1000;
const MIN_FRESH_ORDER_USD = 0.5;
const MAX_CAP_HARD_USD = 10000000;
const ENTRY_BAND = Object.freeze([10000, 20000]);
const STAGNATION_MINUTES = 30, STAGNATION_MIN_RECENT_VOL_USD = 200;
function entryBand(ageMs) {
  if (!Number.isSafeInteger(ageMs) || ageMs < 0) return null;
  return ENTRY_BAND;
}
function memeEntryReason({ poolAgeMs, marketCapUsd, realVolumeUsd, volume24hUsd, recentVolumeUsd }) {
  if (!Number.isSafeInteger(poolAgeMs) || poolAgeMs < 0) return 'Pool age missing or invalid.';
  const band = entryBand(poolAgeMs);
  const [min, max] = band;
  if (!Number.isFinite(marketCapUsd) || marketCapUsd < min || marketCapUsd > max) return `Cap outside the $${min}-$${max} entry band.`;
  const volume = recentVolumeUsd ?? realVolumeUsd ?? volume24hUsd;
  if (!Number.isFinite(volume) || volume < ENTRY_MIN_VOL_USD) return 'Insufficient volume force for entry.';
  return null;
}
// Conservative paper-research limits, not calibrated profitability claims.
// Owner directive (mới nhất): mục tiêu ≥20 lệnh/giờ với chiến lược giữ tới x10 —
// vị thế nhỏ hơn (4%) và trần vị thế cao hơn để dòng lệnh không nghẽn.
const DEFAULT_POLICY = Object.freeze({ minConfidence: .6, minQuality: .7, maxAgeMs: 60000, perTradeRisk: .01, stopDistance: .05, positionFraction: .085, maxExposureFraction: .95, maxPositions: 60, maxDrawdown: .6, liquidityFraction: .005, minLiquidityUsd: 200, feeBps: 10, slippageBps: 10, paperEvaluationFraction: .01, lossCount: 3, cooldownMs: 1800000, maxOrdersPerHour: 100, minOrderUsd: .5 });
function createRiskEngine({ runtime, tradeStore, now = () => new Date(), policy = {} } = {}) {
  if (!runtime || !['get', 'snapshot', 'publish', 'subscribeDurable'].every(k => typeof runtime[k] === 'function') || typeof tradeStore?.snapshot !== 'function' || typeof now !== 'function') throw Error('INVALID_RISK_RUNTIME');
  const { manualExitMaxQuoteAgeMs = 900000, minFreshOrderUsd = MIN_FRESH_ORDER_USD, ...riskPolicy } = policy;
  if (!Number.isFinite(minFreshOrderUsd) || minFreshOrderUsd <= 0) throw Error('INVALID_RISK_POLICY');
  if (!Number.isSafeInteger(manualExitMaxQuoteAgeMs) || manualExitMaxQuoteAgeMs < 1) throw Error('INVALID_RISK_POLICY');
  const p = { ...DEFAULT_POLICY, ...riskPolicy };
  if (Object.keys(p).some(k => !Object.hasOwn(DEFAULT_POLICY, k)) || Object.values(p).some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0) || ['maxAgeMs', 'maxPositions', 'lossCount', 'cooldownMs', 'maxOrdersPerHour'].some(k => !Number.isSafeInteger(p[k]) || p[k] < 1) || ['minConfidence', 'minQuality', 'perTradeRisk', 'stopDistance', 'positionFraction', 'maxExposureFraction', 'maxDrawdown', 'liquidityFraction', 'paperEvaluationFraction'].some(k => p[k] <= 0 || p[k] > 1) || p.feeBps > 1000 || p.slippageBps > 1000 || p.maxOrdersPerHour > 100 || p.minOrderUsd <= 0) throw Error('INVALID_RISK_POLICY');
  let running = false, generation = 0, detach;
  const acceptable = e => e && ['OBSERVED', 'COMPLETED', 'APPROVED', 'PROPOSED'].includes(e.status) && e.evidence.length > 0 && e.missing_evidence.length === 0 && e.confidence >= p.minConfidence && e.evidence_quality >= p.minQuality && e.uncertainty <= 1 - p.minConfidence;
  function handle(decision, { signal }, ticket) {
    if (!running || generation !== ticket || signal.aborted) throw Error('RISK_STOPPED');
    const clock = now(); if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) throw Error('INVALID_RISK_CLOCK');
    const action = decision.payload.action;
    if (!['BUY', 'SELL', 'REDUCE'].includes(action)) return;
    const identity = manualExitMaxQuoteAgeMs === 900000 ? [decision.id, p] : [decision.id, p, manualExitMaxQuoteAgeMs];
    if (minFreshOrderUsd !== MIN_FRESH_ORDER_USD) identity.push({ minFreshOrderUsd });
    const id = 'risk/' + createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    if (runtime.get(id)) return;
    // Derived decisions inherit their source timestamp, so a decision re-delivered
    // from an older session (crash backlog) carries an old stamp while the journal
    // has moved on. Its quotes are long stale — a fresh scan re-derives a fresh
    // decision — so aged decisions are dropped instead of veto-polluting the feed.
    if (clock.getTime() - Date.parse(decision.timestamp) > 300000) return;
    const all = runtime.snapshot().events, index = all.findIndex(e => e.id === decision.id);
    if (index < 0) throw Error('RISK_DECISION_NOT_PERSISTED');
    const prior = all.slice(0, index + 1), visible = new Map(prior.map(e => [e.id, e]));
    const snapshot = visible.get(decision.payload.snapshotId), regime = visible.get(decision.payload.regimeId);
    const refs = [decision.id];
    const finish = (reason, quantity = 0, maxExposureUsd = 0) => runtime.publish({ id, type: 'RiskDecision', timestamp: decision.timestamp, producer: 'RISK_ENGINE', source: 'risk.independent-veto', evidence: refs, status: quantity > 0 ? 'APPROVED' : 'REJECTED', correlationId: decision.correlationId, network: decision.network, epoch: decision.epoch, confidence: quantity > 0 ? Math.min(decision.confidence, snapshot.confidence) : 0, evidence_quality: quantity > 0 ? Math.min(decision.evidence_quality, snapshot.evidence_quality) : 0, missing_evidence: [], uncertainty: quantity > 0 ? Math.max(decision.uncertainty, snapshot.uncertainty) : 1, payload: { decisionId: decision.id, approved: quantity > 0, quantity, maxExposureUsd, reason } });
    if (snapshot?.missing_evidence.includes('UNSUPPORTED_HOOK')) return finish('VETO: UNSUPPORTED_HOOK.');
    const age = snapshot && clock.getTime() - Date.parse(snapshot.payload.observedAt);
    const poolAge = snapshot?.payload.poolAgeMs;
    // 15-minute freshness for pool-aged quotes (see commander decision note).
    const manualExit = decision.producer === 'CODEX_1' && ['commander.manual-paper-exit', 'commander.manual-live-sell'].includes(decision.source) && action === 'SELL';
    const quoteLimit = manualExit ? manualExitMaxQuoteAgeMs : Number.isSafeInteger(poolAge) && poolAge >= 0 ? 900000 : p.maxAgeMs;
    if (!snapshot || snapshot.type !== 'MarketSnapshot' || snapshot.network !== decision.network || snapshot.epoch !== decision.epoch || age < 0 || age > quoteLimit || snapshot.missing_evidence.length || !snapshot.evidence.length || !['OBSERVED', 'COMPLETED'].includes(snapshot.status)) return finish('VETO: price evidence missing, stale or unreliable.');
    refs.push(snapshot.id);
    if (!decision.evidence.length || decision.missing_evidence.length) return finish('VETO: decision evidence incomplete.');
    let portfolio; try { portfolio = tradeStore.snapshot({ throughId: decision.id }); } catch { return finish('VETO: authoritative portfolio unavailable.'); }
    if (tradeStore.walletFunded && !portfolio.performance.fundingId) return finish('VETO: wallet capital evidence missing or stale.');
    if (portfolio.performance.fundingId) refs.push(portfolio.performance.fundingId);
    const token = snapshot.payload.token, position = portfolio.positions.find(row => row.network === decision.network && row.token === token);
    // Prior approvals reserve capital/positions until the corresponding fill is
    // present at this decision boundary. Later fills are never read as PnL.
    const fills = new Set(portfolio.trades.map(row => row.decisionId));
    const terminalRisks = new Set();
    for (const failure of prior) {
      if (failure.type === 'AIActivityEvent' && failure.producer === 'STRATEGY_ENGINE' && failure.source === 'strategy_engine.service' && failure.status === 'FAILED' && failure.payload.agent === 'STRATEGY_ENGINE' && failure.payload.state === 'FAILED' && failure.missing_evidence.length > 0) {
        const approval = visible.get(failure.payload.task);
        if (approval?.type === 'RiskDecision' && approval.payload.approved && failure.id === derived(approval, { producer: 'STRATEGY_ENGINE', type: 'AIActivityEvent', payload: {} }).id && failure.network === approval.network && failure.epoch === approval.epoch && failure.correlationId === approval.correlationId && failure.timestamp === approval.timestamp && failure.evidence.length === 1 && failure.evidence[0] === approval.id && !all.some(e => ['ExecutionIntent', 'TradeResult'].includes(e.type) && e.payload.riskDecisionId === approval.id)) terminalRisks.add(approval.id);
      }
      if (failure.type !== 'AIActivityEvent' || failure.producer !== 'PAPER_EXECUTION' || failure.source !== 'paper.next-observation' || failure.status !== 'FAILED' || failure.payload.agent !== 'PAPER_EXECUTION' || failure.payload.state !== 'FAILED') continue;
      const intent = visible.get(failure.payload.task);
      if (!intent || intent.type !== 'ExecutionIntent' || failure.id !== 'paper.failure/' + createHash('sha256').update(intent.id).digest('hex') || failure.network !== intent.network || failure.epoch !== intent.epoch || failure.correlationId !== intent.correlationId || failure.timestamp < intent.timestamp || !failure.evidence.includes(intent.id) || !failure.evidence.includes(intent.payload.riskDecisionId)) continue;
      const quote = failure.evidence.map(ref => visible.get(ref)).find(e => e?.type === 'MarketSnapshot' && e.network === intent.network && e.epoch === intent.epoch && e.payload.token === intent.payload.token && e.timestamp === failure.timestamp && e.timestamp > intent.timestamp);
      if (quote) terminalRisks.add(intent.payload.riskDecisionId);
    }
    const reservations = all.filter(e => e.type === 'RiskDecision' && e.network === decision.network && e.epoch === decision.epoch && e.payload.approved && !fills.has(e.payload.decisionId) && !terminalRisks.has(e.id) && clock.getTime() - Date.parse(e.timestamp) <= p.maxAgeMs).map(e => ({ risk: e, decision: runtime.get(e.payload.decisionId) })).filter(x => x.decision && x.decision.id !== decision.id);
    const sameToken = d => runtime.get(d.payload.snapshotId)?.payload.token === token && d.network === decision.network;
    if (action !== 'BUY') {
      const reserved = reservations.filter(x => x.decision.payload.action !== 'BUY' && sameToken(x.decision)).reduce((sum, x) => sum + x.risk.payload.quantity, 0);
      if (!position || position.quantity <= reserved) return finish('VETO: no unreserved position to reduce.');
      const fraction = manualExit && decision.source === 'commander.manual-live-sell' ? (decision.payload.sellPercent ?? 100) / 100 : action === 'REDUCE' ? .5 : 1;
      const quantity = Math.min(position.quantity - reserved, position.quantity * fraction);
      return finish('Risk-reducing paper exit approved.', quantity, quantity * snapshot.payload.price);
    }
    if (decision.payload.strategyVersion !== 'meme-flow-v1' && snapshot.payload.marketCapUsd > MAX_CAP_HARD_USD) return finish('Cap above the $10M hard ceiling — not a meme.');
    if (!acceptable(decision) || !acceptable(snapshot)) return finish('VETO: insufficient confidence or evidence quality.');
    const meme = decision.payload.strategyVersion === 'meme-flow-v1';
    let evaluationCap = Infinity;
    if (meme) {
      const candidate = visible.get(decision.payload.candidateId);
      const entryReason = memeEntryReason(snapshot.payload);
      // Shared entry policy also screens commander and discovery paths.
      if (!candidate || candidate.type !== 'TokenCandidate' || !candidate.payload.anomalies.includes('TOKEN_DISCOVERY')) return finish('VETO: missing token discovery evidence.');
      if (entryReason) return finish('VETO: ' + entryReason);
      const history = prior.filter(event => event.type === 'MarketSnapshot' && event.network === decision.network && event.epoch === decision.epoch && event.payload.token === token);
      if (history.length < regimePolicy.minSamples && !(candidate.payload.anomalies || []).includes('REAL_VOLUME')) return finish('VETO: insufficient chronological history.');
      refs.push(candidate.id);
    } else {
      if (!acceptable(regime) || clock.getTime() - Date.parse(regime.timestamp) > p.maxAgeMs || !['TRENDING', 'MOMENTUM_EXPANSION'].includes(regime.payload.regime)) return finish('VETO: unknown, stale or adverse market regime.');
      refs.push(regime.id);
      const version = decision.payload.strategyVersion;
      const lifecycle = prior.filter(e => e.type === 'StrategyLifecycleDecision' && e.network === decision.network && e.epoch === decision.epoch && e.payload.strategyVersion === version).at(-1);
      if (!lifecycle || !['PAPER_EVALUATION', 'CHAMPION'].includes(lifecycle.payload.stage)) return finish('VETO: strategy lifecycle not eligible.');
      const proposal = visible.get(lifecycle.payload.proposalId);
      const bt = decision.payload.quantEvidenceIds.map(ref => visible.get(ref)).find(e => e?.type === 'BacktestResult' && e.payload.strategyVersion === version);
      const wf = decision.payload.quantEvidenceIds.map(ref => visible.get(ref)).find(e => e?.type === 'WalkForwardResult' && e.payload.strategyVersion === version);
      const critic = decision.payload.criticReportIds.map(ref => visible.get(ref)).find(e => e?.type === 'ProposalCritique' && e.payload.proposalId === proposal?.id && e.payload.verdict === 'SUPPORTED');
      const latestCritic = prior.filter(e => e.type === 'ProposalCritique' && e.network === decision.network && e.epoch === decision.epoch && e.payload.proposalId === proposal?.id).at(-1);
      if (!latestCritic || latestCritic.payload.verdict !== 'SUPPORTED' || !acceptable(latestCritic)) return finish('VETO: latest critique does not support the proposal.');
      if (!proposal || proposal.payload.strategyVersion !== version || !proposal.payload.regimes.includes(regime.payload.regime) || !bt || !wf || !critic || ![bt, wf, critic].every(acceptable) || bt.status !== 'COMPLETED' || wf.status !== 'COMPLETED' || proposal.payload.backtestId !== bt.id || proposal.payload.walkForwardId !== wf.id || bt.payload.netPnl <= 0 || bt.payload.expectancy <= 0 || bt.payload.trades < 2 || wf.payload.outOfSamplePnl <= 0 || wf.payload.backtestId !== bt.id || critic.payload.backtestId !== bt.id || critic.payload.walkForwardId !== wf.id) return finish('VETO: linked quant/critic evidence absent or weak.');
      refs.push(lifecycle.id, proposal.id, bt.id, wf.id, critic.id);
      evaluationCap = lifecycle.payload.stage === 'PAPER_EVALUATION' ? null : Infinity;
    }
    const perf = portfolio.performance;
    if (!Number.isFinite(perf.equity) || perf.equity <= 0 || !Number.isFinite(perf.maxDrawdown) || perf.maxDrawdown >= p.maxDrawdown) return finish('VETO: valuation or drawdown limit.');
    const depthUsd = snapshot.payload.executableDepthUsd;
    const sized = Number.isFinite(depthUsd);
    const freshEntry = meme;
    if (sized) { if (!(depthUsd > 0) && !freshEntry) return finish('VETO: no executable size within slippage.'); }
    else if (!freshEntry && snapshot.payload.liquidityUsd < p.minLiquidityUsd) return finish('VETO: insufficient liquidity.');
    const hourAgo = clock.getTime() - 3600000;
    if (portfolio.trades.filter(row => row.network === decision.network && Date.parse(row.timestamp) >= hourAgo).length >= p.maxOrdersPerHour) return finish('VETO: hourly order limit.');
    const buys = reservations.filter(x => x.decision.payload.action === 'BUY'), reservedCash = buys.reduce((sum, x) => sum + x.risk.payload.maxExposureUsd * (1 + p.feeBps / 10000) * (1 + p.slippageBps / 10000), 0);
    const reservedExposure = buys.reduce((sum, x) => sum + x.risk.payload.maxExposureUsd, 0);
    const identities = new Set(portfolio.positions.map(row => JSON.stringify([row.network, row.token])));
    for (const x of buys) identities.add(JSON.stringify([x.decision.network, runtime.get(x.decision.payload.snapshotId)?.payload.token]));
    if (!identities.has(JSON.stringify([decision.network, token])) && identities.size >= p.maxPositions) return finish('VETO: position count limit.');
    const concentration = (position?.costBasis ?? 0) + buys.filter(x => sameToken(x.decision)).reduce((sum, x) => sum + x.risk.payload.maxExposureUsd, 0);
    const fee = p.feeBps / 10000, slip = p.slippageBps / 10000;
    const lossPerReferenceDollar = (1 + slip) * (1 + fee) - (1 - p.stopDistance) * (1 - slip) * (1 - fee);
    const budget = Math.min(tradeStore.maxEntryUsd?.() ?? Infinity, (perf.cash - reservedCash) / ((1 + p.feeBps / 10000) * (1 + p.slippageBps / 10000)), perf.equity * p.perTradeRisk / lossPerReferenceDollar, perf.equity * p.positionFraction - concentration, perf.equity * p.maxExposureFraction - perf.capitalUsed - reservedExposure, evaluationCap === null ? perf.equity * p.paperEvaluationFraction : evaluationCap);
    if (!Number.isFinite(budget) || budget <= 0) return finish('VETO: capital, concentration or exposure budget exhausted.');
    // Live Solana orders below the rent+fee floor cannot clear execution: the ATA
    // rent and priority fee exceed the size, so every attempt dies as
    // LIVE_RESERVE_OR_FEE_BUFFER. Veto here with the real reason instead.
    if (runtime.executionMode?.() === 'live' && budget < p.minOrderUsd) return finish('VETO: entry budget $' + budget.toFixed(2) + ' is below the minimum executable order $' + p.minOrderUsd.toFixed(2) + ' — wallet cash is exhausted or locked in positions without fresh marks.');
    const fit = sized ? sizeOrder({ plannedOrderUsd: budget, executableDepthUsd: depthUsd, slippageBps: p.slippageBps }) : null;
    let notional = fit ? fit.allowedUsd : freshEntry ? budget : Math.min(budget, snapshot.payload.liquidityUsd * p.liquidityFraction);
    // Legacy feeds omit mint precision; use six decimal places until supplied.
    const scale = 10 ** (snapshot.payload.tokenDecimals ?? 6);
    const fillPrice = snapshot.payload.price * (1 + slip);
    const size = usd => Math.floor(usd / fillPrice * scale) / scale;
    let quantity = notional / snapshot.payload.price;
    const viable = usd => economicViability({ plannedOrderUsd: budget, actualOrderUsd: usd, feeBps: p.feeBps, slippageBps: p.slippageBps, priceImpactBps: snapshot.payload.priceImpactBps, gasUsd: snapshot.payload.gasUsd, stopDistance: p.stopDistance });
    let viability = viable(notional), floorApplied = false;
    if (freshEntry && (size(notional) <= 0 || viability.state !== 'ELIGIBLE')) {
      // A test buy may exceed measured depth, but never its financial limits.
      notional = Math.min(minFreshOrderUsd, budget, perf.equity * p.positionFraction * 2);
      quantity = size(notional);
      floorApplied = true;
    }
    if (runtime.executionMode?.() === 'live' && !floorApplied && notional < p.minOrderUsd) {
      // Depth-based sizing may legally allow a dust order; on live Solana it still
      // has to clear the rent+fee floor or execution will reject it downstream.
      notional = Math.min(budget, p.minOrderUsd);
      quantity = size(notional);
      floorApplied = true;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) return finish(floorApplied
      ? 'VETO: fresh-window floor rounds below one token unit at the fill price within available risk limits.'
      : 'VETO: sizing below a positive quantity. ' + (fit?.reason ?? 'Liquidity sizing produced no tradable order.'));
    if (floorApplied) notional = quantity * fillPrice;
    viability = viable(notional);
    if (viability.state !== 'ELIGIBLE') return finish('VETO: sizing viability failed' + (floorApplied ? ' after fresh-window floor' : '') + ': ' + viability.reason);
    finish(floorApplied ? 'Sizing below viable minimum on thin pool; fresh-window floor applied. ' + viability.reason : viability.reason, quantity, notional);
  }
  return { start() { if (running) return; running = true; const ticket = ++generation; try { detach = runtime.subscribeDurable('risk.engine.v1', 'StrategyDecision', (e, context) => handle(e, context, ticket)); } catch (error) { running = false; throw error; } }, stop() { running = false; generation++; detach?.(); detach = null; } };
}
module.exports = { createRiskEngine, DEFAULT_POLICY, MIN_FRESH_ORDER_USD, MAX_CAP_HARD_USD, ENTRY_BAND, ENTRY_MIN_VOL_USD, STAGNATION_MINUTES, STAGNATION_MIN_RECENT_VOL_USD, entryBand, memeEntryReason };
