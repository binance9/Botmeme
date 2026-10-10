'use strict';
const { derived } = require('../../runtime/events/derived.cjs');
const DEFAULTS = Object.freeze({ minSamples: 5, window: 20, maxAgeMs: 60000, historyWindowMs: 1800000, minLiquidityUsd: 2000, minQuality: 0.7, volatility: 0.05, trend: 0.03 });
function normalizePolicy(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !Object.hasOwn(DEFAULTS, k))) throw Error('INVALID_REGIME_POLICY');
  const policy = { ...DEFAULTS, ...input };
  if (Object.keys(DEFAULTS).some(k => !Number.isFinite(policy[k]) || policy[k] <= 0) || !['minSamples', 'window', 'maxAgeMs', 'historyWindowMs'].every(k => Number.isSafeInteger(policy[k])) || policy.minSamples < 2 || policy.window < policy.minSamples || policy.window > 256 || policy.minQuality > 1) throw Error('INVALID_REGIME_POLICY');
  return Object.freeze(policy);
}
function classify(samples, input = {}) {
  const policy = normalizePolicy(input);
  if (!Array.isArray(samples) || !samples.length) return { regime: 'UNKNOWN', reason: 'No observations.', confidence: 0 };
  const latest = samples.at(-1), history = samples.slice(-policy.window);
  if (history.some(e => !e.evidence.length || e.missing_evidence.length || e.confidence < policy.minQuality || e.evidence_quality < policy.minQuality || e.uncertainty > 1 - policy.minQuality || !['OBSERVED', 'COMPLETED'].includes(e.status))) return { regime: 'UNKNOWN', reason: 'Observation quality is insufficient.', confidence: 0 };
  if (Number.isFinite(latest.payload.executableDepthUsd)) {
    if (!(latest.payload.executableDepthUsd > 0)) return { regime: 'LOW_LIQUIDITY', reason: 'No executable size within slippage.', confidence: latest.confidence };
  } else if (latest.payload.liquidityUsd < policy.minLiquidityUsd) return { regime: 'LOW_LIQUIDITY', reason: 'Liquidity below policy.', confidence: latest.confidence };
  if (history.length < policy.minSamples) return { regime: 'UNKNOWN', reason: 'Insufficient chronological observations.', confidence: 0 };
  const changes = history.slice(1).map((e, i) => e.payload.price / history[i].payload.price - 1);
  if (changes.some(v => !Number.isFinite(v))) return { regime: 'UNKNOWN', reason: 'Non-finite price change.', confidence: 0 };
  const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
  const volatility = Math.sqrt(changes.reduce((n, x) => n + (x - mean) ** 2, 0) / changes.length);
  const net = latest.payload.price / history[0].payload.price - 1;
  let regime = 'RANGE';
  if (net < -policy.trend * 2) regime = 'RISK_OFF';
  else if (volatility >= policy.volatility) regime = 'HIGH_VOLATILITY';
  else if (net >= policy.trend) regime = changes.at(-1) > mean * 1.5 ? 'MOMENTUM_EXPANSION' : changes.at(-1) < 0 ? 'MOMENTUM_DECAY' : 'TRENDING';
  return { regime, reason: `Heuristic regime: ${history.length} observations; net=${net.toFixed(6)}, volatility=${volatility.toFixed(6)}. Confidence is input quality, not a profit probability.`, confidence: Math.min(...history.map(e => e.confidence)) };
}
function createRegimeEngine({ runtime, now = () => new Date(), policy: input = {} }) {
  const policy = normalizePolicy(input);
  if (!runtime || !['get', 'snapshot', 'publish', 'subscribeDurable'].every(k => typeof runtime[k] === 'function') || typeof now !== 'function') throw Error('INVALID_REGIME_RUNTIME');
  let detach = null, generation = 0;
  return {
    start() {
      if (detach) return;
      const ticket = ++generation;
      detach = runtime.subscribeDurable('market.regime.v1', 'MarketSnapshot', event => {
        if (ticket !== generation) throw Error('REGIME_STOPPED');
        const id = derived(event, { producer: 'MARKET_DATA', type: 'MarketRegimeState', payload: {} }).id;
        if (runtime.get(id)) return;
        const prior = [];
        for (const e of runtime.snapshot().events) {
          if (e.type === 'MarketSnapshot' && e.network === event.network && e.epoch === event.epoch && e.payload.token === event.payload.token && Date.parse(e.payload.observedAt) <= Date.parse(event.payload.observedAt) && Date.parse(event.payload.observedAt) - Date.parse(e.payload.observedAt) <= policy.historyWindowMs) prior.push(e);
          if (e.id === event.id) break;
        }
        const clock = now();
        if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) throw Error('INVALID_REGIME_CLOCK');
        const age = clock.getTime() - Date.parse(event.payload.observedAt);
        const result = age < 0 || age > policy.maxAgeMs ? { regime: 'UNKNOWN', reason: 'Current observation is stale or future dated.', confidence: 0 } : classify(prior, policy);
        runtime.publish(derived(event, { producer: 'MARKET_DATA', type: 'MarketRegimeState', confidence: result.confidence, uncertainty: result.regime === 'UNKNOWN' ? 1 : 1 - result.confidence,
          status: result.regime === 'UNKNOWN' ? 'CHUA_XAC_MINH' : 'OBSERVED', evidence: prior.slice(-policy.window).map(e => e.id), missing_evidence: result.regime === 'UNKNOWN' ? [result.reason] : [],
          payload: { regime: result.regime, snapshotIds: prior.slice(-policy.window).map(e => e.id), reason: result.reason } }));
      });
    },
    stop() { generation++; detach?.(); detach = null; }
  };
}
module.exports = { classify, createRegimeEngine, DEFAULTS };
