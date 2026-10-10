'use strict';
const { createHash } = require('node:crypto');
const { DEFAULTS: regimePolicy } = require('../../core/market-data/regime.cjs');
const { memeEntryReason } = require('../../core/risk/engine.cjs');
// Heuristic research thresholds only. A candidate is never an order or proof of edge.
const DEFAULT_POLICY = Object.freeze({ maxAgeMs: 60000, minLiquidityUsd: 500, minQuality: 0.7, momentumThreshold: 0.05, volumeLiquidityThreshold: 1, minRealVolumeUsd: 200, minRecentTxs: 2 });
function createHunter({ runtime, now = () => new Date(), policy = DEFAULT_POLICY } = {}) {
  if (!runtime || !['snapshot', 'get', 'publish', 'subscribeDurable'].every(key => typeof runtime[key] === 'function') || typeof now !== 'function') throw Error('INVALID_HUNTER_RUNTIME');
  const keys = Object.keys(DEFAULT_POLICY);
  if (!policy || Object.keys(policy).length !== keys.length || keys.some(key => !Object.hasOwn(policy, key) || typeof policy[key] !== 'number' || !Number.isFinite(policy[key])) || !Number.isSafeInteger(policy.maxAgeMs) || policy.maxAgeMs <= 0 || policy.minLiquidityUsd < 0 || policy.minQuality < 0 || policy.minQuality > 1 || policy.momentumThreshold <= 0 || policy.volumeLiquidityThreshold <= 0 || policy.minRealVolumeUsd < 0 || policy.minRecentTxs < 1) throw Error('INVALID_HUNTER_POLICY');
  const limits = Object.freeze({ ...policy });
  let running = false, generation = 0, detach = null;
  const reliable = event => event.evidence.length > 0 && event.missing_evidence.length === 0 && event.evidence_quality >= limits.minQuality && event.confidence >= limits.minQuality && event.uncertainty <= 1 - limits.minQuality && ['OBSERVED', 'COMPLETED'].includes(event.status);
  const liquid = event => event.payload.liquidityUsd > 0 && event.payload.liquidityUsd >= limits.minLiquidityUsd;
  const fresh = (event, clock) => {
    const age = clock - Date.parse(event.payload.observedAt);
    const poolAge = event.payload.poolAgeMs;
    // A minutes-old meme is still a new pool. The last print does not have to be under a minute.
    const limit = Number.isSafeInteger(poolAge) && poolAge >= 0 && poolAge <= 300000 ? 300000 : limits.maxAgeMs;
    return age >= 0 && age <= limit;
  };
  function handle(input, { signal }, ticket) {
    if (!running || generation !== ticket || signal.aborted) throw Error('HUNTER_STOPPED');
    const events = runtime.snapshot().events;
    const local = events.filter(event => event.network === input.network && event.epoch === input.epoch);
    // Decisions belong to the token, including decisions citing an older candidate.
    if (local.some(event => event.type === 'StrategyDecision' && runtime.get(event.payload.candidateId)?.payload.token === input.payload.token)) return;
    const refreshCandidate = local.findLast(event => event.type === 'TokenCandidate' && event.payload.token === input.payload.token && Date.parse(event.timestamp) <= Date.parse(input.timestamp));
    if (refreshCandidate && refreshCandidate.payload.snapshotId !== input.id) {
      if (!runtime.get(input.id)) throw Error('HUNTER_SOURCE_NOT_PERSISTED');
      const clock = now();
      if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) throw Error('INVALID_HUNTER_CLOCK');
      if (!reliable(input) || !fresh(input, clock.getTime())) return;
      // Existing producers may already have signalled this quote. Preserve those IDs.
      if (local.some(event => event.type === 'SignalObservation' && event.payload.snapshotId === input.id)) return;
      const id = 'jev.signal/' + createHash('sha256').update(JSON.stringify([input.network, input.epoch, refreshCandidate.id, input.id])).digest('hex');
      if (runtime.get(id)) return;
      const signals = [{ name: 'price', value: input.payload.price }, { name: 'volume_24h_usd', value: input.payload.volume24hUsd }];
      if (Number.isFinite(input.payload.recentVolumeUsd)) signals.push({ name: 'real_volume_5m_usd', value: input.payload.recentVolumeUsd }, { name: 'recent_txs_5m', value: input.payload.recentTxs5m });
      if (input.payload.liquidityUsd > 0) {
        const ratio = input.payload.volume24hUsd / input.payload.liquidityUsd;
        if (Number.isFinite(ratio)) signals.push({ name: 'volume_liquidity_ratio', value: ratio });
      }
      const previous = events.slice(0, events.findIndex(event => event.id === input.id)).findLast(event => event.type === 'MarketSnapshot' && event.network === input.network && event.epoch === input.epoch && event.payload.token === input.payload.token);
      if (previous && reliable(previous) && liquid(previous) && fresh(previous, Date.parse(input.payload.observedAt))) {
        const momentum = (input.payload.price - previous.payload.price) / previous.payload.price;
        if (Number.isFinite(momentum)) signals.push({ name: 'price_change_fraction', value: momentum });
      }
      runtime.publish({ id, type: 'SignalObservation', timestamp: input.timestamp, producer: 'JEV', source: 'jev.hunter', evidence: [input.id], status: 'OBSERVED', correlationId: input.correlationId, network: input.network, epoch: input.epoch, confidence: input.confidence, evidence_quality: input.evidence_quality, missing_evidence: [...input.missing_evidence], uncertainty: input.uncertainty,
        payload: { candidateId: refreshCandidate.id, snapshotId: input.id, signals } });
      return;
    }
    const suffix = createHash('sha256').update(JSON.stringify([input.network, input.epoch, input.id])).digest('hex');
    const ids = { candidate: 'jev.candidate/' + suffix, signal: 'jev.signal/' + suffix, activity: 'jev.activity/' + suffix };
    if (runtime.get(ids.activity)) return;
    const prior = [];
    let found = false;
    for (const event of runtime.snapshot().events) {
      if (event.id === input.id) { found = true; break; }
      if (event.type === 'MarketSnapshot' && event.network === input.network && event.epoch === input.epoch) prior.push(event);
    }
    if (!found) throw Error('HUNTER_SOURCE_NOT_PERSISTED');
    const persisted = runtime.get(ids.candidate);
    const clock = now();
    if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) throw Error('INVALID_HUNTER_CLOCK');
    const sourceTime = Date.parse(input.payload.observedAt);
    const history = prior.filter(event => event.payload.token === input.payload.token);
    const previous = history.at(-1);
    const ratio = input.payload.liquidityUsd > 0 ? input.payload.volume24hUsd / input.payload.liquidityUsd : null;
    const momentum = previous && reliable(previous) && liquid(previous) && fresh(previous, sourceTime) ? (input.payload.price - previous.payload.price) / previous.payload.price : null;
    const anomalies = [];
    if (!history.some(event => reliable(event) && liquid(event) && Date.parse(event.payload.observedAt) <= sourceTime)) anomalies.push('TOKEN_DISCOVERY');
    if (momentum !== null && Number.isFinite(momentum) && Math.abs(momentum) >= limits.momentumThreshold) anomalies.push('MOMENTUM_CHANGE');
    const fastNow = ratio !== null && Number.isFinite(ratio) && ratio >= limits.volumeLiquidityThreshold && input.payload.volume24hUsd >= 1000;
    const previousRatio = previous && previous.payload.liquidityUsd > 0 ? previous.payload.volume24hUsd / previous.payload.liquidityUsd : null;
    const previousFast = previousRatio !== null && Number.isFinite(previousRatio) && previousRatio >= limits.volumeLiquidityThreshold && previous.payload.volume24hUsd >= 1000;
    const volumeDied = previous && !previousFast && !(input.payload.volume24hUsd > previous.payload.volume24hUsd);
    if (fastNow && !volumeDied) anomalies.push('VOLUME_LIQUIDITY');
    // Real traded volume in the trailing five-minute window from several
    // distinct transactions — the "strong genuine volume" path for new pools.
    // Owner directive (mới nhất): vol24h > $200 là đủ — mua khi có volume,
    // không đợi chứng minh giao dịch sâu.
    const realVolumeNow = input.payload.volume24hUsd >= limits.minRealVolumeUsd || memeEntryReason(input.payload) === null;
    if (realVolumeNow) anomalies.push('REAL_VOLUME');
    const envelope = (id, type, payload, status = 'OBSERVED') => ({ id, type, timestamp: input.timestamp, producer: 'JEV', source: 'jev.hunter', evidence: [input.id], status, correlationId: input.correlationId, network: input.network, epoch: input.epoch, confidence: input.confidence, evidence_quality: input.evidence_quality, missing_evidence: [...input.missing_evidence], uncertainty: input.uncertainty, payload });
    // REAL_VOLUME (verified turnover ≥ minRealVolumeUsd) admits a candidate even
    // from a live pool-price quote — the wallet-vol filter already proved trade
    // activity, waiting for a trades-page poll would only miss the entry.
    if (realVolumeNow) {
      const stage0 = 'ELIGIBLE ';
      let candidate = runtime.get(ids.candidate);
      if (!candidate) {
        const higher = (() => { let n = 0; for (const event of prior) if (event.payload.token !== input.payload.token && Number.isFinite(event.payload.volume24hUsd / event.payload.liquidityUsd) && event.payload.volume24hUsd / event.payload.liquidityUsd > (input.payload.liquidityUsd > 0 ? input.payload.volume24hUsd / input.payload.liquidityUsd : Infinity)) n++; return n; })();
        candidate = envelope(ids.candidate, 'TokenCandidate', { token: input.payload.token, symbol: input.payload.token.slice(0, 32), snapshotId: input.id, liquidityUsd: input.payload.liquidityUsd, volume24hUsd: input.payload.volume24hUsd, rank: higher + 1, anomalies: [...anomalies, 'TOKEN_DISCOVERY'] });
        runtime.publish(candidate);
      }
      if (!runtime.get(ids.signal)) {
        const signals = [{ name: 'price', value: input.payload.price }];
        if (Number.isFinite(input.payload.volume24hUsd)) signals.push({ name: 'volume_24h_usd', value: input.payload.volume24hUsd });
        runtime.publish(envelope(ids.signal, 'SignalObservation', { candidateId: candidate.id, snapshotId: input.id, signals }));
      }
      runtime.publish(envelope(ids.activity, 'AIActivityEvent', { agent: 'JEV', task: input.id, state: 'COMPLETED', progress: null, message: stage0 + 'Research candidate (real 24h volume) observed; no trade authorized.' }, 'COMPLETED'));
      return;
    }
    if (typeof input.source === 'string' && input.source.includes('#pool-price')) {
      runtime.publish(envelope(ids.activity, 'AIActivityEvent', { agent: 'JEV', task: input.id, state: 'WAITING', progress: null, message: 'WATCHING live pool price; real volume is not eligible yet (need $' + limits.minRealVolumeUsd + '/5m from ' + limits.minRecentTxs + '+ wallets).' }, 'OBSERVED'));
      return;
    }
    if (input.missing_evidence.includes('UNSUPPORTED_HOOK')) {
      runtime.publish(envelope(ids.activity, 'AIActivityEvent', { agent: 'JEV', task: input.id, state: 'WAITING', progress: null, message: 'UNSUPPORTED_HOOK.' }, 'OBSERVED'));
      return;
    }
    const quoted = Number.isFinite(input.payload.executableDepthUsd);
    const watched = quoted || Number.isSafeInteger(input.payload.poolAgeMs);
    if (watched && reliable(input) && fresh(input, clock.getTime()) && (quoted || liquid(input))) {
      const newest = Date.parse(input.payload.observedAt);
      const covered = [...history, input].filter(event => {
        if (!reliable(event) || (quoted ? !(event.payload.executableDepthUsd > 0) : !liquid(event))) return false;
        const time = Date.parse(event.payload.observedAt);
        return Number.isFinite(time) && newest - time >= 0 && newest - time <= regimePolicy.historyWindowMs;
      }).length;
      const deepEnough = quoted ? input.payload.executableDepthUsd > 0 : input.payload.liquidityUsd >= (realVolumeNow ? limits.minLiquidityUsd : regimePolicy.minLiquidityUsd);
      // Genuine fast volume (>= minRealVolumeUsd from minRecentTxs+ wallets in
      // 5 minutes) does not wait for the five-snapshot history: that history
      // cannot exist in the pool's first minutes, which is exactly the window.
      if (!deepEnough || covered < regimePolicy.minSamples && !realVolumeNow) {
        const message = quoted && !(input.payload.executableDepthUsd > 0) ? 'WAIT: no executable size within slippage.' : `WATCHING ${covered}/${regimePolicy.minSamples}; ${quoted ? 'executable depth or history is still short.' : 'liquidity or history is still short.'}`;
        runtime.publish(envelope(ids.activity, 'AIActivityEvent', { agent: 'JEV', task: input.id, state: 'WAITING', progress: null, message }, 'OBSERVED'));
        return;
      }
      if (!anomalies.includes('TOKEN_DISCOVERY')) anomalies.push('TOKEN_DISCOVERY');
    }
    const depthOk = quoted && input.payload.executableDepthUsd > 0 && anomalies.includes('TOKEN_DISCOVERY');
    const eligible = persisted || reliable(input) && fresh(input, clock.getTime()) && (depthOk || liquid(input) && anomalies.length > 0 && Number.isFinite(ratio));
    if (!eligible) {
      const reason = !reliable(input) ? 'Evidence weak or incomplete; waiting.' : !liquid(input) ? 'Liquidity below research threshold; waiting.' : !fresh(input, clock.getTime()) ? 'Market observation stale or future dated; waiting.' : 'No qualifying research anomaly; watching.';
      runtime.publish(envelope(ids.activity, 'AIActivityEvent', { agent: 'JEV', task: input.id, state: 'WAITING', progress: null, message: reason }, !reliable(input) || !fresh(input, clock.getTime()) ? 'CHUA_XAC_MINH' : 'OBSERVED'));
      return;
    }
    let candidate = persisted;
    if (!candidate) {
      const latest = new Map();
      for (const event of prior) latest.set(event.payload.token, event);
      latest.delete(input.payload.token);
      const higher = [...latest.values()].filter(event => reliable(event) && liquid(event) && fresh(event, sourceTime) && Number.isFinite(event.payload.volume24hUsd / event.payload.liquidityUsd) && (event.payload.volume24hUsd / event.payload.liquidityUsd > ratio || event.payload.volume24hUsd / event.payload.liquidityUsd === ratio && event.payload.token < input.payload.token)).length;
      candidate = envelope(ids.candidate, 'TokenCandidate', { token: input.payload.token, symbol: input.payload.token.slice(0, 32), snapshotId: input.id, liquidityUsd: input.payload.liquidityUsd, volume24hUsd: input.payload.volume24hUsd, rank: higher + 1, anomalies });
      runtime.publish(candidate);
    }
    if (!runtime.get(ids.signal)) {
      const signals = [{ name: 'price', value: input.payload.price }];
      if (ratio !== null && Number.isFinite(ratio)) signals.push({ name: 'volume_liquidity_ratio', value: ratio });
      if (Number.isFinite(input.payload.recentVolumeUsd)) signals.push({ name: 'real_volume_5m_usd', value: input.payload.recentVolumeUsd }, { name: 'recent_txs_5m', value: input.payload.recentTxs5m });
      if (momentum !== null && Number.isFinite(momentum)) signals.push({ name: 'price_change_fraction', value: momentum });
      runtime.publish(envelope(ids.signal, 'SignalObservation', { candidateId: candidate.id, snapshotId: input.id, signals }));
    }
    const stage = quoted || Number.isSafeInteger(input.payload.poolAgeMs) ? 'ELIGIBLE ' : '';
    runtime.publish(envelope(ids.activity, 'AIActivityEvent', { agent: 'JEV', task: input.id, state: 'COMPLETED', progress: null, message: stage + 'Research candidate observed; no trade authorized. Ticker unavailable; displaying token identifier.' }, 'COMPLETED'));
  }
  return {
    start() {
      if (running) return;
      running = true; const ticket = ++generation;
      try { detach = runtime.subscribeDurable('jev.hunter.v1', 'MarketSnapshot', (event, context) => handle(event, context, ticket)); }
      catch (error) { running = false; throw error; }
    },
    stop() { if (!running) return; running = false; generation++; detach?.(); detach = null; }
  };
}
module.exports = { createHunter };
