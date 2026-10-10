'use strict';
const s = require('./schema.cjs');
const { tokenIdentity } = require('./token-identity.cjs');
const { NETWORKS, TYPES, PRODUCERS, definitions } = require('./types.cjs');
const validatedImmutable = new WeakSet();
function deeplyFrozen(value) {
  return !value || typeof value !== 'object' || Object.isFrozen(value) && Object.values(value).every(deeplyFrozen);
}
function checkClock(input, now) {
  const clock = now();
  if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) s.bad('CLOCK');
  if (Date.parse(input.timestamp) > clock.getTime() + 60000) s.bad('FUTURE_TIMESTAMP');
}
function validateEvent(input, { now = () => new Date() } = {}) {
  // The bus hands projections deeply frozen events. Revalidating their entire
  // payload on every portfolio replay is quadratic work; time remains dynamic.
  if (validatedImmutable.has(input)) { checkClock(input, now); return input; }
  s.noSecrets(input);
  s.object({ id: s.id, type: s.oneOf(TYPES), timestamp: s.timestamp, producer: s.oneOf(PRODUCERS), source: s.string(500), evidence: s.array(s.id), status: s.oneOf(['PENDING', 'OBSERVED', 'PROPOSED', 'APPROVED', 'REJECTED', 'COMPLETED', 'FAILED', 'CHUA_XAC_MINH']), correlationId: s.id, network: s.oneOf(NETWORKS), epoch: s.integer(1), confidence: s.fraction, evidence_quality: s.fraction, missing_evidence: s.array(s.string(500)), uncertainty: s.fraction, payload: () => {} })(input);
  const definition = definitions[input.type];
  if (!definition.producers.includes(input.producer)) s.bad('PRODUCER');
  if (input.type === 'MarketSnapshot') {
    // Age/cap quotes may omit real volume and use the documented headline fallback.
    const identityKeys = ['tokenSymbol', 'tokenName', 'imageUrl'], identity = tokenIdentity(input.payload);
    for (const key of identityKeys) if (Object.hasOwn(input.payload, key) && (!Object.hasOwn(identity, key) || identity[key] !== input.payload[key])) s.bad('TOKEN_IDENTITY');
    if (Object.hasOwn(input.payload, 'tokenDecimals') && (!Number.isInteger(input.payload.tokenDecimals) || input.payload.tokenDecimals < 0 || input.payload.tokenDecimals > 18)) s.bad('TOKEN_DECIMALS');
    const fields = Object.keys(input.payload).filter(key => !identityKeys.includes(key) && key !== 'tokenDecimals');
    if (fields.includes('poolAgeMs') && !fields.includes('realVolumeUsd')) fields.push('realVolumeUsd');
    const keys = fields.sort().join(',');
    const base = 'liquidityUsd,observedAt,price,token,volume24hUsd';
    const extended = 'liquidityUsd,marketCapUsd,observedAt,poolAgeMs,price,realVolumeUsd,token,volume24hUsd';
    const extendedReal = 'liquidityUsd,marketCapUsd,observedAt,poolAgeMs,price,realVolumeUsd,recentTxs5m,recentVolumeUsd,token,volume24hUsd';
    const extendedRealLp = 'liquidityUsd,marketCapUsd,observedAt,poolAddress,poolAgeMs,price,realVolumeUsd,recentTxs5m,recentVolumeUsd,token,volume24hUsd';
    const depth = 'executableDepthUsd,liquidityUsd,observedAt,price,priceImpactBps,token,volume24hUsd';
    const extendedDepth = 'executableDepthUsd,liquidityUsd,marketCapUsd,observedAt,poolAgeMs,price,priceImpactBps,realVolumeUsd,token,volume24hUsd';
    const extendedDepthReal = 'executableDepthUsd,liquidityUsd,marketCapUsd,observedAt,poolAgeMs,price,priceImpactBps,realVolumeUsd,recentTxs5m,recentVolumeUsd,token,volume24hUsd';
    const extendedDepthRealLp = 'executableDepthUsd,liquidityUsd,marketCapUsd,observedAt,poolAddress,poolAgeMs,price,priceImpactBps,realVolumeUsd,recentTxs5m,recentVolumeUsd,token,volume24hUsd';
    const depthGas = 'executableDepthUsd,gasUsd,liquidityUsd,observedAt,price,priceImpactBps,token,volume24hUsd';
    const extendedDepthGas = 'executableDepthUsd,gasUsd,liquidityUsd,marketCapUsd,observedAt,poolAgeMs,price,priceImpactBps,realVolumeUsd,token,volume24hUsd';
    const fallback = input.source.includes('#dexscreener-fallback');
    if (fallback) {
      const allowed = new Set(['token', 'price', 'liquidityUsd', 'volume24hUsd', 'observedAt', 'poolAgeMs', 'marketCapUsd', 'recentVolumeUsd', 'recentTxs5m']);
      if (Object.keys(input.payload).some(key => !allowed.has(key) && !identityKeys.includes(key) && key !== 'tokenDecimals')) s.bad('KEYS');
      if (input.payload.poolAgeMs !== undefined && (!Number.isSafeInteger(input.payload.poolAgeMs) || input.payload.poolAgeMs < 0)) s.bad('POOL_AGE');
      if (input.payload.marketCapUsd !== undefined) s.nonnegative(input.payload.marketCapUsd);
      if (input.payload.recentVolumeUsd !== undefined) s.nonnegative(input.payload.recentVolumeUsd);
      if (input.payload.recentTxs5m !== undefined && (!Number.isSafeInteger(input.payload.recentTxs5m) || input.payload.recentTxs5m < 0)) s.bad('RECENT_TXS');
    }
    if (!fallback && keys !== base && keys !== extended && keys !== extendedReal && keys !== extendedRealLp && keys !== depth && keys !== extendedDepth && keys !== extendedDepthReal && keys !== extendedDepthRealLp && keys !== depthGas && keys !== extendedDepthGas) s.bad('KEYS');
    s.object({ token: s.id, price: s.positive, liquidityUsd: s.nonnegative, volume24hUsd: s.nonnegative, observedAt: s.timestamp })({ token: input.payload.token, price: input.payload.price, liquidityUsd: input.payload.liquidityUsd, volume24hUsd: input.payload.volume24hUsd, observedAt: input.payload.observedAt });
    if (keys === depth || keys === extendedDepth || keys === extendedDepthReal || keys === extendedDepthRealLp || keys === depthGas || keys === extendedDepthGas) { s.nonnegative(input.payload.executableDepthUsd); s.nonnegative(input.payload.priceImpactBps); }
    if (keys === depthGas || keys === extendedDepthGas) s.nonnegative(input.payload.gasUsd);
    if (!fallback && (keys === extended || keys === extendedReal || keys === extendedRealLp || keys === extendedDepth || keys === extendedDepthReal || keys === extendedDepthRealLp || keys === extendedDepthGas)) {
      // Owner directive: the strategy targets the OLDEST long-lived tokens, so
      // the event contract allows pool ages up to 10 years instead of 2h.
      if (!Number.isSafeInteger(input.payload.poolAgeMs) || input.payload.poolAgeMs < 0 || input.payload.poolAgeMs > 315360000000) s.bad('POOL_AGE');
      s.nonnegative(input.payload.marketCapUsd);
      if (Object.hasOwn(input.payload, 'realVolumeUsd')) s.nonnegative(input.payload.realVolumeUsd);
    }
    if (keys === extendedRealLp || keys === extendedDepthRealLp) s.id(input.payload.poolAddress);
    if (keys === extendedReal || keys === extendedRealLp || keys === extendedDepthReal || keys === extendedDepthRealLp) {
      s.nonnegative(input.payload.recentVolumeUsd);
      if (!Number.isSafeInteger(input.payload.recentTxs5m) || input.payload.recentTxs5m < 0 || input.payload.recentTxs5m > 100000) s.bad('RECENT_TXS');
    }
  } else if (input.type === 'SafetyDecision' && Object.hasOwn(input.payload, 'mintAuthorityRevoked')) {
    const curve = input.payload.lpStatus === 'bonding-curve';
    s.object({ ...definition.payload, mintAuthorityRevoked: s.boolean, freezeAuthorityRevoked: s.boolean,
      maxLpLockedPct: curve || !input.payload.approved ? s.nullable(s.number(0, 100)) : s.number(0, 100), top10HolderPct: s.number(0, 100),
      ...(curve ? { lpStatus: s.oneOf(['bonding-curve']) } : {}),
      insiderHolderPct: s.nullable(s.number(0, 100)), scoreNormalised: s.nullable(s.number(0, 100)) })(input.payload);
    if (curve && input.payload.approved && (!input.payload.mintAuthorityRevoked || !input.payload.freezeAuthorityRevoked)) s.bad('SAFETY_EVIDENCE');
  } else if (input.type === 'TokenCandidate' && Object.hasOwn(input.payload, 'discoverySource')) {
    s.object({ ...definition.payload, discoverySource: s.oneOf(['onchain-ws']) })(input.payload);
  } else if (input.type === 'StrategyDecision' && Object.hasOwn(input.payload, 'sellPercent')) {
    s.object({ ...definition.payload, sellPercent: value => { if (!Number.isFinite(value) || value <= 0 || value > 100) s.bad('SELL_PERCENT'); } })(input.payload);
    if (input.source !== 'commander.manual-live-sell' || input.payload.action !== 'SELL') s.bad('SELL_PERCENT');
  } else s.object(definition.payload)(input.payload);
  checkClock(input, now);
  const p = input.payload;
  if (input.type === 'ScanProgress' && (p.failed + p.skipped > p.completed || p.total !== null && p.completed > p.total || p.total === null && p.completed !== 0 || p.state === 'COMPLETED' && (p.total === null || p.completed !== p.total || p.failed !== 0))) s.bad('SCAN_COUNTS');
  if (input.type === 'WalletValuation') {
    if (input.status !== 'OBSERVED' || !input.evidence.length || input.missing_evidence.length || !/^\d+\.\d+$/.test(p.amount) || p.valueUsd !== Math.floor(Number(p.amount) * p.priceUsd * 100) / 100) s.bad('WALLET_VALUATION');
    if ([p.balanceAt, p.priceAt].some(at => Date.parse(at) > Date.parse(input.timestamp) || Date.parse(input.timestamp) - Date.parse(at) > 60000)) s.bad('WALLET_VALUATION_STALE');
  }
  if (['FailureReport', 'RootCauseReport'].includes(input.type) && p.category === null && (input.status !== 'CHUA_XAC_MINH' || !input.missing_evidence.length)) s.bad('UNRESOLVED_CAUSE');
  if (['ExecutionIntent', 'TradeResult'].includes(input.type) || input.type === 'RiskDecision' && p.approved) {
    if (!input.evidence.length || input.missing_evidence.length) s.bad('EXECUTION_EVIDENCE');
  }
  if (input.type === 'ExecutionIntent' && input.status !== 'APPROVED') s.bad('EXECUTION_STATUS');
  if (input.type === 'TradeResult' && input.status !== 'COMPLETED') s.bad('TRADE_STATUS');
  if (input.type === 'TradeResult' && (p.mode === 'live') !== (input.producer === 'LIVE_EXECUTION')) s.bad('TRADE_MODE');
  if (input.type === 'RiskDecision' && input.status !== (p.approved ? 'APPROVED' : 'REJECTED')) s.bad('RISK_STATUS');
  if (input.type === 'SafetyDecision' && input.status !== (p.approved ? 'APPROVED' : 'REJECTED')) s.bad('SAFETY_STATUS');
  if (input.type === 'SafetyDecision' && !input.evidence.length) s.bad('SAFETY_EVIDENCE');
  if (input.type === 'JevVerdict' && !['COMPLETED', 'CHUA_XAC_MINH'].includes(input.status)) s.bad('JEV_VERDICT_STATUS');
  if (input.type === 'AIActivityEvent' && p.agent !== input.producer) s.bad('ACTIVITY_ATTRIBUTION');
  if (input.type === 'BacktestResult' && Date.parse(p.sampleEnd) <= Date.parse(p.sampleStart)) s.bad('SAMPLE_WINDOW');
  if (input.type === 'MarketSnapshot' && Date.parse(p.observedAt) > Date.parse(input.timestamp)) s.bad('OBSERVATION_TIME');
  if (input.type === 'RiskDecision' && (p.approved ? p.quantity <= 0 : p.quantity !== 0)) s.bad('RISK_QUANTITY');
  if (input.type === 'TradeResult' && (p.state === 'CLOSED' ? p.exitPrice === null : p.exitPrice !== null)) s.bad('TRADE_STATE');
  if (input.type === 'TradeResult' && p.state !== 'CLOSED' && p.realizedPnl !== 0) s.bad('UNREALIZED_TRADE');
  if (Buffer.byteLength(JSON.stringify(input)) > 65536) s.bad('SIZE');
  if (deeplyFrozen(input)) { validatedImmutable.add(input); return input; }
  return structuredClone(input);
}
module.exports = { validateEvent, NETWORKS, TYPES };
