'use strict';
const { strategyState } = require('../../core/strategy/lifecycle.cjs');
function buildWorld(runtime, tradeStore, throughId) {
  const state = runtime.snapshot(), end = state.events.findIndex(e => e.id === throughId);
  if (end < 0) throw Error('COMMANDER_SOURCE_MISSING');
  const history = state.events.slice(0, end + 1), source = history.at(-1);
  const local = history.filter(e => e.network === source.network && e.epoch === source.epoch);
  const latest = (type, key) => [...new Map(local.filter(e => e.type === type).map(e => [key(e), e])).values()];
  return {
    network: source.network, epoch: source.epoch, source, history, local,
    objectives: ['PRESERVE_CAPITAL', 'LIMIT_DRAWDOWN', 'POSITIVE_COST_ADJUSTED_EXPECTANCY', 'AVOID_UNNECESSARY_TRADES'],
    candidates: latest('TokenCandidate', e => e.payload.token), signals: latest('SignalObservation', e => e.payload.candidateId),
    regimes: local.filter(e => e.type === 'MarketRegimeState'), strategies: strategyState(history, source.network, source.epoch),
    critiques: local.filter(e => e.type === 'ProposalCritique'), failures: local.filter(e => e.type === 'RootCauseReport').slice(-50),
    tasks: latest('AIActivityEvent', e => e.payload.agent), journal: local.filter(e => e.type === 'StrategyDecision').slice(-100),
    // Most source events have no unplanned signal. Do not replay the portfolio
    // until a bounded batch actually needs a decision.
    get portfolio() {
      const value = tradeStore.snapshot({ throughId });
      Object.defineProperty(this, 'portfolio', { value, enumerable: true });
      return value;
    }, unresolvedAnomalies: local.filter(e => e.type === 'RootCauseReport' && e.status === 'CHUA_XAC_MINH')
  };
}
module.exports = { buildWorld };
