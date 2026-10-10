'use strict';
const { createRiskEngine } = require('../../core/risk/engine.cjs');
const { createStrategyEngine } = require('../../core/strategy/engine.cjs');
const { createPaperExecution } = require('../../core/execution/paper.cjs');
async function seedPosition({ runtime, tradeStore, now }, token = 'FOMO') {
  const stamp = now().toISOString(), { network, epoch } = runtime.status();
  const envelope = (id, type, producer, payload) => ({ id: token + '/' + id, type, producer, timestamp: stamp, source: 'test.manual-exit', evidence: ['fixture'], status: 'OBSERVED', correlationId: token, network, epoch, confidence: .9, evidence_quality: .9, uncertainty: .1, missing_evidence: [], payload });
  const quote = (id, price) => envelope(id, 'MarketSnapshot', 'MARKET_DATA', { token, price, observedAt: stamp, liquidityUsd: 100000, marketCapUsd: 10000, poolAgeMs: 3 * 60000, volume24hUsd: 1000, realVolumeUsd: 1000 });
  runtime.publish(quote('quote', .001));
  runtime.publish(envelope('candidate', 'TokenCandidate', 'JEV', { token, symbol: token, snapshotId: token+'/quote', liquidityUsd: 100000, volume24hUsd: 1000, rank: 1, anomalies: ['TOKEN_DISCOVERY','REAL_VOLUME'] }));
  runtime.publish(envelope('regime', 'MarketRegimeState', 'MARKET_DATA', { regime: 'MOMENTUM_EXPANSION', snapshotIds: [token+'/quote'], reason: 'test fixture' }));
  const modules = [createRiskEngine({ runtime, tradeStore, now }), createStrategyEngine({ runtime, now }), createPaperExecution({ runtime, tradeStore, now })];
  modules.forEach(m => m.start());
  runtime.publish(envelope('buy', 'StrategyDecision', 'CODEX_1', { candidateId: token+'/candidate', snapshotId: token+'/quote', signalIds: [], strategyVersion: 'meme-flow-v1', quantEvidenceIds: [], criticReportIds: [], regimeId: token+'/regime', action: 'BUY', disposition: 'TRADE', reason: 'test fixture' }));
  await runtime.flush(); modules.forEach(m => m.stop());
  runtime.publish(quote('profit', .00225)); await runtime.flush();
  return tradeStore.snapshot().trades.find(t => t.token === token && t.side === 'BUY');
}
module.exports = { seedPosition };
