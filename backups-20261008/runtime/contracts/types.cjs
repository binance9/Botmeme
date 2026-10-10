'use strict';
const s = require('./schema.cjs');
const NETWORKS = Object.freeze(['SOLANA', 'ETHEREUM', 'BSC', 'ROBINHOOD']);
const PRODUCERS = Object.freeze(['JEV', 'CODEX_1', 'CODEX_2', 'CODEX_3', 'MARKET_DATA', 'STRATEGY_ENGINE', 'RISK_ENGINE', 'PAPER_EXECUTION', 'LIVE_EXECUTION', 'PERFORMANCE', 'RUNTIME', 'SAFETY_GATE', 'EXIT_MANAGER']);
const REGIMES = Object.freeze(['TRENDING', 'RANGE', 'HIGH_VOLATILITY', 'LOW_LIQUIDITY', 'MOMENTUM_EXPANSION', 'MOMENTUM_DECAY', 'RISK_OFF', 'UNKNOWN']);
const categories = s.oneOf(['STRATEGY_FAILURE', 'MARKET_REGIME_FAILURE', 'DATA_FAILURE', 'EXECUTION_FAILURE', 'INFRASTRUCTURE_FAILURE']);
const ids = s.array(s.id), names = s.array(s.string(300)), maybeId = s.nullable(s.id);
const trace = { candidateId: s.id, snapshotId: s.id, signalIds: s.array(s.id, 64), strategyVersion: s.id, decisionId: s.id, riskDecisionId: s.id };
const definitions = {
  ScanProgress: { producers: ['MARKET_DATA'], payload: { runId: s.id, state: s.oneOf(['RUNNING', 'COMPLETED', 'PARTIAL_FAILURE', 'FAILED', 'STOPPED']), total: s.nullable(s.integer()), completed: s.integer(), failed: s.integer(), skipped: s.integer() } },
  WalletValuation: { producers: ['RUNTIME'], payload: { amount: s.string(100), symbol: s.oneOf(['SOL', 'ETH', 'BNB']), balanceAt: s.timestamp, priceAt: s.timestamp, priceUsd: s.positive, valueUsd: s.nonnegative, accountHash: s.id } },
  TokenCandidate: { producers: ['JEV'], payload: { token: s.id, symbol: s.string(32), snapshotId: s.id, liquidityUsd: s.nonnegative, volume24hUsd: s.nonnegative, rank: s.integer(1), anomalies: names } },
  MarketSnapshot: { producers: ['MARKET_DATA'], payload: { token: s.id, price: s.positive, liquidityUsd: s.nonnegative, volume24hUsd: s.nonnegative, observedAt: s.timestamp } },
  SignalObservation: { producers: ['JEV', 'STRATEGY_ENGINE'], payload: { candidateId: s.id, snapshotId: s.id, signals: s.array(s.object({ name: s.id, value: s.number() }), 64, 1) } },
  StrategyProposal: { producers: ['CODEX_2'], payload: { strategyVersion: s.id, parentVersion: maybeId, regimes: s.array(s.oneOf(REGIMES), 8, 1), parameters: s.array(s.object({ name: s.id, value: s.number() }), 64), backtestId: maybeId, walkForwardId: maybeId, lifecycle: s.oneOf(['IDEA', 'BACKTEST', 'WALK_FORWARD', 'CHALLENGER']) } },
  BacktestResult: { producers: ['CODEX_2'], payload: { proposalId: s.id, strategyVersion: s.id, trades: s.integer(), netPnl: s.number(), maxDrawdown: s.fraction, expectancy: s.number(), sharpe: s.number(), sampleStart: s.timestamp, sampleEnd: s.timestamp } },
  WalkForwardResult: { producers: ['CODEX_2'], payload: { proposalId: s.id, strategyVersion: s.id, backtestId: s.id, folds: s.integer(1), outOfSamplePnl: s.number(), maxDrawdown: s.fraction } },
  FailureReport: { producers: ['CODEX_3'], payload: { tradeId: maybeId, decisionId: maybeId, category: s.nullable(categories), summary: s.string() } },
  RootCauseReport: { producers: ['CODEX_3'], payload: { failureId: s.id, category: s.nullable(categories), cause: s.string(), recommendations: s.array(s.string(500), 32, 1) } },
  ProposalCritique: { producers: ['CODEX_3'], payload: { proposalId: s.id, backtestId: s.id, walkForwardId: s.id, paperTradeIds: ids, verdict: s.oneOf(['SUPPORTED', 'REJECTED', 'CHUA_XAC_MINH']), reason: s.string() } },
  StrategyLifecycleDecision: { producers: ['CODEX_1'], payload: { strategyVersion: s.id, proposalId: s.id, stage: s.oneOf(['PAPER_EVALUATION', 'CODEX_3_CRITIQUE', 'CODEX_1_DECISION', 'CHAMPION', 'DISABLED']), previousId: maybeId, critiqueId: maybeId, reason: s.string() } },
  StrategyDecision: { producers: ['CODEX_1', 'EXIT_MANAGER'], payload: { candidateId: s.id, snapshotId: s.id, signalIds: s.array(s.id, 64), strategyVersion: s.id, quantEvidenceIds: ids, criticReportIds: ids, regimeId: s.id, action: s.oneOf(['BUY', 'SELL', 'REDUCE', 'HOLD', 'NO_ACTION']), disposition: s.oneOf(['TRADE', 'WATCH', 'REJECT', 'WAIT', 'REDUCE_RISK', 'EXIT', 'NO_ACTION']), reason: s.string() } },
  SafetyDecision: { producers: ['SAFETY_GATE'], payload: { candidateId: s.id, approved: s.boolean, reason: s.string(300), checks: s.array(s.object({ name: s.id, passed: s.boolean, detail: s.string(200) }), 32) } },
  JevVerdict: { producers: ['JEV'], payload: { candidateId: s.id, action: s.oneOf(['TRADE', 'WATCH', 'REJECT', 'NO_ACTION']), confidence: s.nullable(s.fraction), tradableProbability: s.nullable(s.fraction), momentum: s.nullable(s.number()), model: s.string(100), latencyMs: s.integer(1), violations: s.array(s.string(200)) } },
  RiskDecision: { producers: ['RISK_ENGINE'], payload: { decisionId: s.id, approved: s.boolean, quantity: s.nonnegative, maxExposureUsd: s.nonnegative, reason: s.string() } },
  ExecutionIntent: { producers: ['STRATEGY_ENGINE'], payload: { mode: s.oneOf(['paper', 'live']), token: s.id, ...trace, action: s.oneOf(['BUY', 'SELL', 'REDUCE']), quantity: s.positive, referencePrice: s.positive } },
  TradeResult: { producers: ['PAPER_EXECUTION', 'LIVE_EXECUTION'], payload: { mode: s.oneOf(['paper', 'live']), intentId: s.id, token: s.id, ...trace, side: s.oneOf(['BUY', 'SELL', 'REDUCE']), quantity: s.positive, entryPrice: s.positive, exitPrice: s.nullable(s.positive), realizedPnl: s.number(), fees: s.nonnegative, slippageBps: s.nonnegative, state: s.oneOf(['OPEN', 'CLOSED']) } },
  PerformanceSnapshot: { producers: ['PERFORMANCE'], payload: { realizedPnl: s.number(), unrealizedPnl: s.nullable(s.number()), totalTrades: s.integer(), winRate: s.nullable(s.fraction), capitalUsed: s.nonnegative, equity: s.nullable(s.number()), maxDrawdown: s.nullable(s.fraction) } },
  AIActivityEvent: { producers: PRODUCERS, payload: { agent: s.oneOf(PRODUCERS), task: s.id, state: s.oneOf(['IDLE', 'RUNNING', 'WAITING', 'COMPLETED', 'PARTIAL_FAILURE', 'FAILED', 'STOPPED']), progress: s.nullable(s.fraction), message: s.string() } },
  MarketRegimeState: { producers: ['MARKET_DATA', 'CODEX_2'], payload: { regime: s.oneOf(REGIMES), snapshotIds: s.array(s.id, 256, 1), reason: s.string() } }
};
for (const definition of Object.values(definitions)) { Object.freeze(definition.producers); Object.freeze(definition.payload); Object.freeze(definition); }
Object.freeze(definitions);
const TYPES = Object.freeze(Object.keys(definitions));
module.exports = { NETWORKS, TYPES, PRODUCERS, REGIMES, definitions };
