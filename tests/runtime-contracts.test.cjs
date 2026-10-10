'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateEvent, NETWORKS, TYPES } = require('../runtime/contracts/index.cjs');
const at = '2026-09-24T10:00:00.000Z', before = '2026-09-23T10:00:00.000Z';
const options = { now: () => new Date(at) };
const trace = { candidateId: 'candidate-1', snapshotId: 'snapshot-1', signalIds: ['signal-1'], strategyVersion: 'strategy-v1', decisionId: 'decision-1', riskDecisionId: 'risk-1' };
const fixtures = {
  ScanProgress: ['MARKET_DATA', { runId: 'scan:one', state: 'RUNNING', total: 5, completed: 2, failed: 1, skipped: 0 }],
  WalletValuation: ['RUNTIME', { amount: '0.010000000000000000', symbol: 'ETH', balanceAt: at, priceAt: at, priceUsd: 2000, valueUsd: 20, accountHash: 'account-hash' }],
  TokenCandidate: ['JEV', { token: 'token-1', symbol: 'MEME', snapshotId: 'snapshot-1', liquidityUsd: 1000, volume24hUsd: 3000, rank: 1, anomalies: [] }],
  MarketSnapshot: ['MARKET_DATA', { token: 'token-1', price: 0.01, liquidityUsd: 1000, volume24hUsd: 3000, observedAt: at }],
  SignalObservation: ['JEV', { candidateId: 'candidate-1', snapshotId: 'snapshot-1', signals: [{ name: 'momentum', value: -0.2 }] }],
  StrategyProposal: ['CODEX_2', { strategyVersion: 'strategy-v1', parentVersion: null, regimes: ['TRENDING'], parameters: [{ name: 'threshold', value: 0.7 }], backtestId: null, walkForwardId: null, lifecycle: 'IDEA' }],
  BacktestResult: ['CODEX_2', { proposalId: 'proposal-1', strategyVersion: 'strategy-v1', trades: 20, netPnl: -10, maxDrawdown: 0.2, expectancy: -0.5, sharpe: -1, sampleStart: before, sampleEnd: at }],
  WalkForwardResult: ['CODEX_2', { proposalId: 'proposal-1', strategyVersion: 'strategy-v1', backtestId: 'backtest-1', folds: 3, outOfSamplePnl: -5, maxDrawdown: 0.1 }],
  FailureReport: ['CODEX_3', { tradeId: 'trade-1', decisionId: 'decision-1', category: 'DATA_FAILURE', summary: 'Stale market observation.' }],
  RootCauseReport: ['CODEX_3', { failureId: 'failure-1', category: 'DATA_FAILURE', cause: 'Observation exceeded freshness policy.', recommendations: ['Reject stale observations.'] }],
  ProposalCritique: ['CODEX_3', { proposalId: 'proposal-1', backtestId: 'backtest-1', walkForwardId: 'walk-1', paperTradeIds: [], verdict: 'CHUA_XAC_MINH', reason: 'Paper evidence missing.' }],
  StrategyLifecycleDecision: ['CODEX_1', { strategyVersion: 'strategy-v1', proposalId: 'proposal-1', stage: 'PAPER_EVALUATION', previousId: null, critiqueId: null, reason: 'Bounded paper evaluation only.' }],
  StrategyDecision: ['CODEX_1', { candidateId: 'candidate-1', snapshotId: 'snapshot-1', signalIds: ['signal-1'], strategyVersion: 'strategy-v1', quantEvidenceIds: [], criticReportIds: [], regimeId: 'regime-1', action: 'NO_ACTION', disposition: 'WAIT', reason: 'Evidence remains insufficient.' }],
  RiskDecision: ['RISK_ENGINE', { decisionId: 'decision-1', approved: false, quantity: 0, maxExposureUsd: 100, reason: 'Liquidity insufficient.' }],
  ExecutionIntent: ['STRATEGY_ENGINE', { mode: 'paper', token: 'token-1', ...trace, action: 'BUY', quantity: 3, referencePrice: 0.01 }],
  TradeResult: ['PAPER_EXECUTION', { mode: 'paper', intentId: 'intent-1', token: 'token-1', ...trace, side: 'SELL', quantity: 3, entryPrice: 0.01, exitPrice: 0.005, realizedPnl: -0.02, fees: 0.005, slippageBps: 10, state: 'CLOSED' }],
  PerformanceSnapshot: ['PERFORMANCE', { realizedPnl: -20, unrealizedPnl: 2, totalTrades: 30, winRate: 0.4, capitalUsed: 100, equity: 980, maxDrawdown: 0.05 }],
  AIActivityEvent: ['JEV', { agent: 'JEV', task: 'scan-1', state: 'RUNNING', progress: 0.25, message: 'Observed 25 of 100 tokens.' }],
  MarketRegimeState: ['MARKET_DATA', { regime: 'UNKNOWN', snapshotIds: ['snapshot-1'], reason: 'Insufficient observations.' }],
  SafetyDecision: ['SAFETY_GATE', { candidateId: 'candidate-1', approved: true, reason: 'All safety gates passed.', checks: [{ name: 'LIQ', passed: true, detail: '85000' }] }],
  JevVerdict: ['JEV', { candidateId: 'candidate-1', action: 'WATCH', confidence: 0.7, tradableProbability: 0.44, momentum: 2, model: 'jev-1.13.0', latencyMs: 900, violations: [] }]
};
function event(type = 'TokenCandidate') {
  const [producer, payload] = fixtures[type];
  const status = type === 'ExecutionIntent' ? 'APPROVED' : type === 'TradeResult' ? 'COMPLETED' : type === 'RiskDecision' ? 'REJECTED' : type === 'SafetyDecision' ? 'APPROVED' : type === 'JevVerdict' ? 'COMPLETED' : 'OBSERVED';
  return structuredClone({ id: 'event-1', type, timestamp: at, producer, source: 'local-market-adapter', evidence: ['source-observation-1'], status, correlationId: 'scan-1', network: 'SOLANA', epoch: 1, confidence: 0.6, evidence_quality: 0.7, missing_evidence: [], uncertainty: 0.4, payload });
}
test('runtime contracts validate all nineteen explicit types and four independent network identities', () => {
  assert.equal(TYPES.length, 21); assert.deepEqual(new Set(TYPES), new Set(Object.keys(fixtures)));
  assert.deepEqual(NETWORKS, ['SOLANA', 'ETHEREUM', 'BSC', 'ROBINHOOD']);
  for (const type of Object.keys(fixtures)) for (const network of NETWORKS) {
    const input = event(type); input.network = network;
    const result = validateEvent(input, options); assert.deepEqual(result, input); assert.notEqual(result, input); assert.notEqual(result.payload, input.payload);
  }
});
test('runtime contracts reject extra missing nested or unrecognized envelope and payload fields', () => {
  for (const mutate of [e => { e.extra = 1; }, e => { delete e.epoch; }, e => { e.payload.extra = 1; }, e => { delete e.payload.token; }, e => { e.type = 'SignerRequest'; }, e => { e.network = 'OTHER'; }, e => { e.source = {}; }, e => { e.evidence = 'id'; }]) {
    const input = event(); mutate(input); assert.throws(() => validateEvent(input, options), /INVALID_EVENT_/);
  }
  const nested = event('SignalObservation'); nested.payload.signals[0].secretHint = 'x'; assert.throws(() => validateEvent(nested, options), /INVALID_EVENT_KEYS/);
});
test('runtime contracts prohibit producer role escalation and activity impersonation', () => {
  for (const type of ['ExecutionIntent', 'TradeResult', 'StrategyDecision', 'StrategyProposal', 'RootCauseReport', 'RiskDecision']) {
    const input = event(type); input.producer = 'JEV'; assert.throws(() => validateEvent(input, options), /INVALID_EVENT_PRODUCER/);
  }
  const activity = event('AIActivityEvent'); activity.payload.agent = 'CODEX_1'; assert.throws(() => validateEvent(activity, options), /INVALID_EVENT_ACTIVITY_ATTRIBUTION/);
});
test('runtime contracts bound finite confidence epochs strings and arrays without coercion', () => {
  for (const value of [NaN, Infinity, -Infinity, -0.01, 1.01, '0.5', null]) {
    for (const field of ['confidence', 'evidence_quality', 'uncertainty']) { const input = event(); input[field] = value; assert.throws(() => validateEvent(input, options), /INVALID_EVENT_NUMBER/); }
  }
  for (const value of [0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1, '1']) { const input = event(); input.epoch = value; assert.throws(() => validateEvent(input, options), /INVALID_EVENT_INTEGER/); }
  for (const mutate of [e => { e.id = ' '; }, e => { e.id = 'a'.repeat(161); }, e => { e.evidence = Array(257).fill('id'); }]) { const input = event(); mutate(input); assert.throws(() => validateEvent(input, options), /INVALID_EVENT_/); }
  for (const value of [0, 1]) { const input = event(); input.confidence = value; assert.doesNotThrow(() => validateEvent(input, options)); }
});
test('runtime contracts enforce execution modes, producer identity, prices, quantities, fees and trade state', () => {
  for (const type of ['ExecutionIntent', 'TradeResult']) {
    for (const mode of ['simulated-live', true]) { const input = event(type); input.payload.mode = mode; assert.throws(() => validateEvent(input, options), /INVALID_EVENT_ENUM/); }
    for (const quantity of [0, -1, NaN, Infinity]) { const input = event(type); input.payload.quantity = quantity; assert.throws(() => validateEvent(input, options), /INVALID_EVENT_/); }
  }
  const live = event('TradeResult'); live.payload.mode = 'live';
  assert.throws(() => validateEvent(live, options), /INVALID_EVENT_TRADE_MODE/);
  live.producer = 'LIVE_EXECUTION'; assert.doesNotThrow(() => validateEvent(live, options));
  for (const field of ['entryPrice', 'exitPrice', 'fees', 'slippageBps']) { const input = event('TradeResult'); input.payload[field] = -0.1; assert.throws(() => validateEvent(input, options), /INVALID_EVENT_NUMBER/); }
  const input = event('TradeResult'); input.payload.exitPrice = null; assert.throws(() => validateEvent(input, options), /INVALID_EVENT_TRADE_STATE/);
  input.payload.state = 'OPEN'; assert.throws(() => validateEvent(input, options), /INVALID_EVENT_UNREALIZED_TRADE/);
  input.payload.realizedPnl = 0; assert.doesNotThrow(() => validateEvent(input, options));
});
test('runtime contracts retain risk veto and permit explicit uncertainty and NO_ACTION', () => {
  const decision = event('StrategyDecision'); decision.status = 'CHUA_XAC_MINH'; decision.missing_evidence = ['Quant evidence absent.']; decision.confidence = 0; decision.uncertainty = 1;
  assert.doesNotThrow(() => validateEvent(decision, options));
  const risk = event('RiskDecision'); risk.payload.quantity = 1; assert.throws(() => validateEvent(risk, options), /INVALID_EVENT_RISK_QUANTITY/);
  risk.payload.approved = true; risk.status = 'APPROVED'; assert.doesNotThrow(() => validateEvent(risk, options));
  risk.payload.quantity = 0; assert.throws(() => validateEvent(risk, options), /INVALID_EVENT_RISK_QUANTITY/);
});
test('runtime contracts reject malformed future and reversed observation timestamps', () => {
  for (const timestamp of ['2026-02-30T10:00:00.000Z', '2026-09-24', '2026-09-24T10:02:00.000Z']) { const input = event(); input.timestamp = timestamp; assert.throws(() => validateEvent(input, options), /INVALID_EVENT_/); }
  const snapshot = event('MarketSnapshot'); snapshot.payload.observedAt = '2026-09-24T10:00:01.000Z'; assert.throws(() => validateEvent(snapshot, options), /INVALID_EVENT_OBSERVATION_TIME/);
  const backtest = event('BacktestResult'); backtest.payload.sampleStart = at; assert.throws(() => validateEvent(backtest, options), /INVALID_EVENT_SAMPLE_WINDOW/);
});
test('runtime contracts reject credential fields and serialized secrets without echoing values', () => {
  const secret = 'SENSITIVE_VALUE_123456789';
  for (const value of ['private_key=' + secret, 'Authorization: Bearer ' + secret, JSON.stringify(JSON.stringify({ seed_phrase: secret }))]) {
    const input = event('AIActivityEvent'); input.payload.message = value;
    assert.throws(() => validateEvent(input, options), error => error.message === 'INVALID_EVENT_SECRET' && !error.message.includes(secret));
  }
  const input = event(); input.payload.private_key = secret; assert.throws(() => validateEvent(input, options), /INVALID_EVENT_SECRET/);
});


test('runtime contracts preserve unknown dashboard metrics without inventing zeros', () => {
  const p = event('PerformanceSnapshot'); p.payload.totalTrades = 0; p.payload.winRate = null; p.payload.unrealizedPnl = null;
  assert.equal(validateEvent(p, options).payload.winRate, null);
  assert.equal(validateEvent(p, options).payload.unrealizedPnl, null);
  const a = event('AIActivityEvent'); a.payload.progress = null;
  assert.equal(validateEvent(a, options).payload.progress, null);
});

test('runtime contracts reject quant promotion and unfounded or contradictory execution authority', () => {
  const proposal = event('StrategyProposal'); proposal.payload.lifecycle = 'CHAMPION';
  assert.throws(() => validateEvent(proposal, options), /INVALID_EVENT_ENUM/);
  for (const type of ['ExecutionIntent', 'TradeResult', 'RiskDecision']) {
    for (const mutation of ['missing', 'empty', 'status']) {
      const e = event(type);
      if (type === 'RiskDecision') { e.payload.approved = true; e.payload.quantity = 1; e.status = 'APPROVED'; }
      if (mutation === 'missing') e.missing_evidence = ['Unchecked risk evidence.'];
      if (mutation === 'empty') e.evidence = [];
      if (mutation === 'status') e.status = 'REJECTED';
      assert.throws(() => validateEvent(e, options), /INVALID_EVENT_(EXECUTION_EVIDENCE|EXECUTION_STATUS|TRADE_STATUS|RISK_STATUS)/);
    }
  }
  const rejected = event('TradeResult'); rejected.payload.state = 'REJECTED';
  assert.throws(() => validateEvent(rejected, options), /INVALID_EVENT_ENUM/);
});
