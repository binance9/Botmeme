'use strict';
const { createHash } = require('node:crypto');
const { walkforward } = require('../../core/strategy/replay.cjs');
const DEFAULT_POLICY = Object.freeze({ minSamples: 40, minTrain: 20, testSize: 10, minTrades: 2, every: 1, maxHistory: 200, minQuality: 0.7, feeBps: 10, slippageBps: 10, thresholds: [0.002, 0.01, 0.03], horizons: [1, 3, 5] });
function createQuant({ runtime, tradeStore = null, now = () => new Date(), policy = {} } = {}) {
  if (!runtime || !['get', 'snapshot', 'publish', 'subscribeDurable'].every(k => typeof runtime[k] === 'function') || typeof now !== 'function') throw Error('INVALID_QUANT_RUNTIME');
  const p = structuredClone({ ...DEFAULT_POLICY, ...policy });
  if (Object.keys(p).some(k => !Object.hasOwn(DEFAULT_POLICY, k)) || !['minSamples', 'minTrain', 'testSize', 'minTrades', 'every', 'maxHistory'].every(k => Number.isSafeInteger(p[k]) && p[k] > 0) || p.minTrain < 4 || p.testSize < 4 || p.minSamples < p.minTrain + p.testSize || p.maxHistory < p.minSamples || p.maxHistory > 240 || !Number.isFinite(p.minQuality) || p.minQuality < 0 || p.minQuality > 1 || !Array.isArray(p.thresholds) || !p.thresholds.length || !Array.isArray(p.horizons) || !p.horizons.length || p.thresholds.length * p.horizons.length > 32) throw Error('INVALID_QUANT_POLICY');
  const candidates = p.thresholds.flatMap(threshold => p.horizons.map(horizon => ({ threshold, horizon, feeBps: p.feeBps, slippageBps: p.slippageBps })));
  walkforward([], { candidates, minTrain: p.minTrain, testSize: p.testSize, minTrades: p.minTrades });
  let running = false, generation = 0, detach = [];
  const reliable = e => e.evidence.length && !e.missing_evidence.length && e.confidence >= p.minQuality && e.evidence_quality >= p.minQuality && e.uncertainty <= 1 - p.minQuality && ['OBSERVED', 'COMPLETED'].includes(e.status);
  function handle(input, context, ticket) {
    if (!running || generation !== ticket || context.signal.aborted) throw Error('QUANT_STOPPED');
    if (input.type === 'TradeResult' && input.payload.state !== 'CLOSED') return;
    const all = runtime.snapshot().events, index = all.findIndex(e => e.id === input.id);
    if (index < 0) throw Error('QUANT_INPUT_NOT_PERSISTED');
    const history = all.slice(0, index + 1).filter(e => e.type === 'MarketSnapshot' && e.network === input.network && e.epoch === input.epoch && e.payload.token === input.payload.token && Date.parse(e.timestamp) <= Date.parse(input.timestamp) && reliable(e));
    const hash = createHash('sha256').update(JSON.stringify([input.id, input.network, input.epoch, p])).digest('hex');
    const id = suffix => 'quant.' + suffix + '/' + hash;
    if (runtime.get(id('activity'))) return;
    if (input.type === 'MarketSnapshot' && history.length >= p.minSamples && (history.length - p.minSamples) % p.every !== 0) return;
    const sample = history.slice(-p.maxHistory);
    const emit = (suffix, type, payload, evidence, status = 'COMPLETED', missing = []) => {
      const eventId = id(suffix); if (runtime.get(eventId)) return eventId;
      runtime.publish({ id: eventId, type, timestamp: input.timestamp, producer: 'CODEX_2', source: 'quant.chronological-replay', evidence, status, correlationId: input.correlationId, network: input.network, epoch: input.epoch, confidence: missing.length ? 0 : Math.min(0.8, sample.length / 250), evidence_quality: sample.length ? Math.min(...sample.map(e => e.evidence_quality)) : 0, uncertainty: missing.length ? 1 : 1 - Math.min(0.8, sample.length / 250), missing_evidence: missing, payload });
      return eventId;
    };
    const wait = message => emit('activity', 'AIActivityEvent', { agent: 'CODEX_2', task: input.id, state: 'WAITING', progress: null, message }, [input.id], 'CHUA_XAC_MINH', [message]);
    if (input.type === 'TradeResult') {
      let projected;
      try { projected = tradeStore?.snapshot({ throughId: input.id })?.trades.find(row => row.id === input.id); }
      catch { return wait('Authoritative trade projection unavailable; loss-triggered learning withheld.'); }
      if (!projected || !Number.isFinite(projected.realizedPnl)) return wait('Authoritative realized PnL unavailable; loss-triggered learning withheld.');
      if (projected.realizedPnl >= 0) return;
    }
    if (sample.length < p.minSamples) return wait('Insufficient reliable chronological history for quant evaluation.');
    let result;
    try { result = walkforward(sample, { candidates, minTrain: p.minTrain, testSize: p.testSize, minTrades: p.minTrades }); }
    catch (error) { if (error.message === 'INVALID_REPLAY_HISTORY' || error.message === 'NONFINITE_REPLAY_RESULT') return wait('History unordered, duplicated or numerically unusable; evaluation withheld.'); throw error; }
    if (result.status !== 'COMPLETED') return wait(result.missing.join(' '));
    const previous = all.slice(0, index).filter(e => e.type === 'StrategyProposal' && e.network === input.network && e.epoch === input.epoch && e.payload.lifecycle === 'CHALLENGER' && e.evidence.some(ref => runtime.get(ref)?.payload?.token === input.payload.token)).at(-1);
    const version = id('version'), proposal = { strategyVersion: version, parentVersion: previous?.payload.strategyVersion ?? null, regimes: ['TRENDING', 'MOMENTUM_EXPANSION'], parameters: Object.entries(result.selected).map(([name, value]) => ({ name, value })), backtestId: null, walkForwardId: null, lifecycle: 'IDEA' };
    const refs = sample.map(e => e.id);
    const idea = emit('idea', 'StrategyProposal', proposal, [...refs, ...(input.type === 'TradeResult' ? [input.id] : [])], 'PROPOSED');
    const train = result.folds.at(-1).trainIds.map(ref => runtime.get(ref));
    const bt = emit('backtest', 'BacktestResult', { proposalId: idea, strategyVersion: version, trades: result.backtest.trades, netPnl: result.backtest.netPnl, maxDrawdown: result.backtest.maxDrawdown, expectancy: result.backtest.expectancy, sharpe: result.backtest.sharpe, sampleStart: train[0].payload.observedAt, sampleEnd: train.at(-1).payload.observedAt }, [idea, ...train.map(e => e.id)]);
    emit('backtest-stage', 'StrategyProposal', { ...proposal, backtestId: bt, lifecycle: 'BACKTEST' }, [idea, bt], 'PROPOSED');
    const wf = emit('walkforward', 'WalkForwardResult', { proposalId: idea, strategyVersion: version, backtestId: bt, folds: 1, outOfSamplePnl: result.netPnl, maxDrawdown: result.maxDrawdown }, [idea, bt, ...result.folds.at(-1).testIds]);
    emit('walkforward-stage', 'StrategyProposal', { ...proposal, backtestId: bt, walkForwardId: wf, lifecycle: 'WALK_FORWARD' }, [idea, bt, wf], 'PROPOSED');
    const positive = result.netPnl > 0 && result.expectancy > 0;
    if (positive) emit('challenger', 'StrategyProposal', { ...proposal, backtestId: bt, walkForwardId: wf, lifecycle: 'CHALLENGER' }, [idea, bt, wf, ...refs], 'PROPOSED');
    emit('activity', 'AIActivityEvent', { agent: 'CODEX_2', task: input.id, state: 'COMPLETED', progress: null, message: positive ? 'Chronological cost-adjusted research challenger; critic and commander evaluation required. Confidence is sample support, not probability of profit.' : 'Cost-adjusted out-of-sample edge absent; no challenger proposed.' }, [idea, bt, wf]);
  }
  return { start() { if (running) return; running = true; const ticket = ++generation; try { for (const type of ['MarketSnapshot', 'TradeResult']) detach.push(runtime.subscribeDurable('quant.v1.' + type, type, (e, context) => handle(e, context, ticket))); } catch (error) { running = false; detach.forEach(f => f()); detach = []; throw error; } }, stop() { running = false; generation++; detach.forEach(f => f()); detach = []; } };
}
module.exports = { createQuant, DEFAULT_POLICY };
