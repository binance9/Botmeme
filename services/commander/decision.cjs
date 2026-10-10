'use strict';
const { DEFAULTS: regimePolicy } = require('../../core/market-data/regime.cjs');
const { memeEntryReason } = require('../../core/risk/engine.cjs');
const DEFAULT_POLICY = Object.freeze({ minConfidence: 0.65, minEvidenceQuality: 0.7, maxAgeMs: 180000, maxDrawdown: 0.6, maxExposureFraction: 0.95, maxPositions: 60, stopLossFraction: 0.08, takeProfitFraction: 0.15 });
function discoveryQuality(world, data, candidate) {
  const newest = Date.parse(data.payload.observedAt);
  // A REAL_VOLUME candidate carries verified fast volume proof, which is the
  // whole point of the first-minutes window — the five-sample history cannot
  // exist there yet, so it does not block the entry.
  // Lenh chu 2026-10-02: on-chain candidates da qua prefilter (mint/freeze revoke, top10 <= 30%)
  // duoc fast-track nhu REAL_VOLUME — 'test nhanh ok la mua ngay'.
  const fastTrack = (candidate?.payload?.anomalies || []).includes('REAL_VOLUME') || (candidate?.payload?.anomalies || []).includes('ONCHAIN_CREATE');
  const covered = world.local.filter(event => {
    if (event.type !== 'MarketSnapshot' || event.payload.token !== data.payload.token) return false;
    if (!event.evidence.length || event.missing_evidence.length || event.confidence < regimePolicy.minQuality || event.evidence_quality < regimePolicy.minQuality) return false;
    const time = Date.parse(event.payload.observedAt);
    return Number.isFinite(time) && newest - time >= 0 && newest - time <= regimePolicy.historyWindowMs;
  });
  if (covered.length < regimePolicy.minSamples && !fastTrack) return 'Insufficient chronological observations.';
  if (Number.isFinite(data.payload.executableDepthUsd)) {
    if ((data.missing_evidence || []).includes('UNSUPPORTED_HOOK')) return 'UNSUPPORTED_HOOK.';
    if (!(data.payload.executableDepthUsd > 0)) return 'No executable size within slippage.';
    return null;
  }
  // REAL_VOLUME candidates skip the liquidity floor: verified traded volume is
  // the entry ticket for fresh pools whose reserve is not yet tracked.
  if (!((candidate?.payload?.anomalies || []).includes('REAL_VOLUME')) && !(data.payload.liquidityUsd >= regimePolicy.minLiquidityUsd)) return 'Liquidity below policy.';
  return null;
}
function plan(world, candidate, signal, now, policy = DEFAULT_POLICY) {
  const data = world.history.find(e => e.id === signal.payload.snapshotId);
  let regime = world.regimes.filter(e => e.payload.snapshotIds.includes(data.id)).at(-1);
  // The regime engine often trails the first snapshot of a fresh pool. An
  // unclassified (UNKNOWN) regime is recorded as an unblocked WAIT instead of a
  // silent null, so REAL_VOLUME candidates stay actionable on the same tick.
  if (!regime) regime = { id: 'regime-pending-' + data.id, type: 'MarketRegimeState', timestamp: data.timestamp, network: data.network, epoch: data.epoch, confidence: 0, evidence_quality: data.evidence_quality, missing_evidence: ['Regime classification pending.'], uncertainty: 1, status: 'CHUA_XAC_MINH', payload: { regime: 'UNKNOWN', snapshotIds: [data.id], reason: 'Classification pending.' } };
  if ((data.missing_evidence || []).includes('UNSUPPORTED_HOOK')) return answer('NO_ACTION', 'WAIT', 'UNSUPPORTED_HOOK.');
  const complete = e => e && !e.missing_evidence.length && e.evidence.length > 0 && e.confidence >= policy.minConfidence && e.evidence_quality >= policy.minEvidenceQuality && e.uncertainty <= 1 - policy.minConfidence && ['OBSERVED', 'COMPLETED', 'APPROVED', 'PROPOSED'].includes(e.status);
  const options = world.strategies.filter(s => ['CHAMPION', 'PAPER_EVALUATION'].includes(s.stage) && s.proposal.payload.regimes.includes(regime.payload.regime));
  const ranked = options.map(s => ({ ...s, backtest: world.history.find(e => e.id === s.proposal.payload.backtestId), walk: world.history.find(e => e.id === s.proposal.payload.walkForwardId), critic: world.critiques.filter(e => e.payload.proposalId === s.proposal.id).at(-1) }))
    .filter(s => complete(s.backtest) && complete(s.walk) && complete(s.critic) && s.critic.payload.verdict === 'SUPPORTED').sort((a, b) => (b.stage === 'CHAMPION') - (a.stage === 'CHAMPION') || b.backtest.payload.expectancy - a.backtest.payload.expectancy);
  const selected = ranked[0], version = selected?.proposal.payload.strategyVersion ?? 'unassigned';
  const answer = (action, disposition, reason) => ({ action, disposition, reason, regime, selected, version });
  const age = now.getTime() - Date.parse(data.payload.observedAt);
  const poolAge = data.payload.poolAgeMs;
  // 15-minute quote freshness for pool-aged tokens: the funnel (gate queue, JEV
  // verdicts, delivery backlog) needs minutes, and the 10x-hold strategy is not
  // latency-sensitive. Quote-less paths keep the 180s bound.
  const quoteLimit = Number.isSafeInteger(poolAge) && poolAge >= 0 ? 900000 : policy.maxAgeMs;
  if (age < 0 || age > quoteLimit || !complete(data) || !complete(candidate) || !complete(signal)) return answer('NO_ACTION', 'WAIT', 'Market evidence stale, incomplete or low confidence.');
  const position = world.portfolio.positions.find(p => p.network === world.network && p.token === candidate.payload.token);
  let qualified = false;
  if (!position && candidate.payload.anomalies.includes('TOKEN_DISCOVERY')) {
    const missing = discoveryQuality(world, data, candidate);
    if (missing) return answer('NO_ACTION', 'WAIT', missing);
    const entryReason = memeEntryReason(data.payload);
    if (entryReason) return answer('NO_ACTION', 'WAIT', entryReason);
    qualified = true;
  }
  if (position) {
    const returnFraction = data.payload.price / position.averageCost - 1;
    const entry = world.portfolio.trades.filter(t => t.network === world.network && t.token === candidate.payload.token && t.side === 'BUY').at(-1);
    if(entry?.strategyVersion==='meme-flow-v1')return {...answer('HOLD','WATCH','Meme position exits are owned by EXIT_MANAGER with the selected take-profit multiple and protective stops.'),version:entry.strategyVersion};
    const positionStrategy = world.strategies.find(s => s.proposal.payload.strategyVersion === entry?.strategyVersion);
    const horizon = positionStrategy?.proposal.payload.parameters.find(p => p.name === 'horizon')?.value;
    const observations = world.local.filter(e => e.type === 'MarketSnapshot' && e.payload.token === candidate.payload.token && e.timestamp > entry?.timestamp).length;
    const peak = world.local.filter(e => e.type === 'MarketSnapshot' && e.payload.token === candidate.payload.token && Date.parse(e.timestamp) >= Date.parse(entry?.timestamp || data.timestamp)).reduce((max, event) => Math.max(max, event.payload.price), position.averageCost);
    const giveback = peak / position.averageCost - 1 - returnFraction;
    if (returnFraction <= -policy.stopLossFraction) return { ...answer('SELL', 'EXIT', 'Position reached the configured stop.'), version: entry?.strategyVersion ?? version };
    if (peak > position.averageCost && giveback >= policy.stopLossFraction) return { ...answer('SELL', 'EXIT', 'Trailing stop gave back the configured stop distance.'), version: entry?.strategyVersion ?? version };
    if (['RISK_OFF', 'MOMENTUM_DECAY'].includes(regime.payload.regime) || Number.isInteger(horizon) && observations >= horizon - 1) return { ...answer('SELL', 'EXIT', 'Position exit threshold, holding horizon or adverse regime reached.'), version: entry?.strategyVersion ?? version };
    if (returnFraction >= policy.takeProfitFraction) return { ...answer('REDUCE', 'REDUCE_RISK', 'Reduce exposure after favorable move.'), version: entry?.strategyVersion ?? version };
    return answer('HOLD', 'WATCH', 'Existing paper position remains within configured limits.');
  }
  // UNKNOWN simply means the pool is too new for a classified regime — a
  // REAL_VOLUME candidate is explicitly admitted through that window; genuinely
  // adverse regimes (RISK_OFF, HIGH_VOLATILITY, LOW_LIQUIDITY, MOMENTUM_DECAY)
  // still block unless the entry is the qualified fast-volume path.
  const adverse = ['RISK_OFF', 'HIGH_VOLATILITY', 'LOW_LIQUIDITY', 'MOMENTUM_DECAY'].includes(regime.payload.regime);
  const regimeOk = complete(regime) || qualified && regime.payload.regime === 'UNKNOWN';
  if (!regimeOk || adverse && !qualified) return answer('NO_ACTION', 'WAIT', 'Regime uncertainty or adverse market blocks new exposure.');
  const performance = world.portfolio.performance;
  if (performance.equity === null || performance.maxDrawdown === null || performance.maxDrawdown >= policy.maxDrawdown || world.portfolio.positions.length >= policy.maxPositions || performance.capitalUsed >= performance.equity * policy.maxExposureFraction) return answer('NO_ACTION', 'REDUCE_RISK', 'Capital, valuation, drawdown or concentration constraint blocks entry.');
  if (qualified) return { action: 'BUY', disposition: 'TRADE', reason: 'Qualified paper entry after the configured history and liquidity checks. Risk engine retains size, position, and hourly vetoes.', regime, selected: null, version: 'meme-flow-v1', confidenceBasis: 'flow' };
  if (!selected) return answer('NO_ACTION', 'WATCH', 'No eligible version with quant and critic evidence; research remains pending.');
  const stronger = world.candidates.some(c => c.id !== candidate.id && c.payload.rank < candidate.payload.rank && complete(c));
  if (stronger) return answer('NO_ACTION', 'WATCH', 'Higher-ranked research candidates take priority under the risk budget.');
  const threshold = selected.proposal.payload.parameters.find(p => p.name === 'threshold')?.value;
  const momentum = signal.payload.signals.find(s => s.name === 'price_change_fraction')?.value;
  if (!Number.isFinite(momentum) || !Number.isFinite(threshold) || momentum < threshold) return answer('NO_ACTION', 'WATCH', 'Current momentum does not satisfy the researched version.');
  return answer('BUY', 'TRADE', 'Fresh signal, eligible regime, positive cost-adjusted research and independent critique support bounded paper entry; risk engine retains veto.');
}
module.exports = { plan, DEFAULT_POLICY };
