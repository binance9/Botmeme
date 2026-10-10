'use strict';
// Research only: unit initial capital, sequential full-capital long positions.
// Signal uses closed observation i; entry is i+1, exit i+1+horizon.
// Costs apply at both fills. Sharpe is per-trade, not annualized.
function validateHistory(history) {
  if (!Array.isArray(history) || history.length > 256) throw Error('INVALID_REPLAY_HISTORY');
  const ids = new Set(); let previous = -Infinity;
  for (const e of history) {
    const time = Date.parse(e?.payload?.observedAt);
    if (e?.type !== 'MarketSnapshot' || typeof e.id !== 'string' || ids.has(e.id) || !Number.isFinite(time) || time <= previous || !Number.isFinite(e.payload.price) || e.payload.price <= 0 || e.network !== history[0].network || e.epoch !== history[0].epoch || e.payload.token !== history[0].payload.token) throw Error('INVALID_REPLAY_HISTORY');
    ids.add(e.id); previous = time;
  }
}
function parameters(p) {
  if (!p || !Number.isFinite(p.threshold) || p.threshold < 0 || !Number.isSafeInteger(p.horizon) || p.horizon < 1 || p.horizon > 64 || !Number.isFinite(p.feeBps) || p.feeBps < 0 || p.feeBps > 1000 || !Number.isFinite(p.slippageBps) || p.slippageBps < 0 || p.slippageBps > 1000) throw Error('INVALID_REPLAY_PARAMETERS');
}
function metrics(trades) {
  let equity = 1, peak = 1, maxDrawdown = 0;
  for (const t of trades) {
    for (const markedReturn of t.markedReturns) {
      const markedEquity = equity * (1 + markedReturn);
      peak = Math.max(peak, markedEquity); maxDrawdown = Math.max(maxDrawdown, (peak - markedEquity) / peak);
    }
    equity *= 1 + t.return;
  }
  const expectancy = trades.length ? trades.reduce((sum, t) => sum + t.return, 0) / trades.length : 0;
  const variance = trades.length > 1 ? trades.reduce((sum, t) => sum + (t.return - expectancy) ** 2, 0) / (trades.length - 1) : 0;
  const sharpe = variance > 0 ? expectancy / Math.sqrt(variance) : 0;
  if (![equity, maxDrawdown, expectancy, sharpe].every(Number.isFinite)) throw Error('NONFINITE_REPLAY_RESULT');
  return { trades: trades.length, netPnl: equity - 1, maxDrawdown, expectancy, sharpe };
}
/** Pure chronological replay. Incomplete exits are excluded, never guessed. */
function backtest(history, p) {
  validateHistory(history); parameters(p); const trades = [], slip = p.slippageBps / 10000, fee = p.feeBps / 10000;
  for (let i = 1; i + 1 + p.horizon < history.length; i++) {
    if (history[i].payload.price / history[i - 1].payload.price - 1 < p.threshold) continue;
    const entry = i + 1, exit = entry + p.horizon;
    const cost = history[entry].payload.price * (1 + slip) * (1 + fee);
    const proceeds = history[exit].payload.price * (1 - slip) * (1 - fee);
    const markedReturns = history.slice(entry, exit + 1).map(e => e.payload.price * (1 - slip) * (1 - fee) / cost - 1);
    trades.push({ signalId: history[i].id, entryId: history[entry].id, exitId: history[exit].id, return: proceeds / cost - 1, markedReturns });
    i = exit; // next iteration observes the next bar; positions never overlap.
  }
  return { ...metrics(trades), details: trades, evidenceIds: history.map(e => e.id) };
}
/** Expanding train windows select parameters before each disjoint OOS block.
 * OOS replay is isolated, so no training position can leak into evaluation.
 * Final selected parameters come from the last training block, never its OOS.
 */
function walkforward(history, { candidates, minTrain = 20, testSize = 10, minTrades = 2 } = {}) {
  validateHistory(history);
  if (!Array.isArray(candidates) || !candidates.length || candidates.length > 32 || ![minTrain, testSize, minTrades].every(Number.isSafeInteger) || minTrain < 4 || testSize < 4 || minTrades < 1) throw Error('INVALID_WALKFORWARD_POLICY');
  candidates.forEach(parameters);
  const folds = []; let selected = null;
  for (let split = minTrain; split + testSize <= history.length; split += testSize) {
    const train = history.slice(0, split), test = history.slice(split, split + testSize);
    const ranked = candidates.map(p => ({ parameters: { ...p }, result: backtest(train, p) })).filter(x => x.result.trades >= minTrades).sort((a, b) => (b.result.netPnl - 2 * b.result.maxDrawdown) - (a.result.netPnl - 2 * a.result.maxDrawdown));
    if (!ranked.length) return { status: 'CHUA_XAC_MINH', missing: ['Insufficient training trades.'], folds };
    selected = ranked[0]; const result = backtest(test, selected.parameters);
    if (result.trades < minTrades) return { status: 'CHUA_XAC_MINH', missing: ['Insufficient out-of-sample trades.'], folds };
    folds.push({ trainIds: train.map(e => e.id), testIds: test.map(e => e.id), parameters: selected.parameters, trainResult: selected.result, result });
  }
  if (!folds.length) return { status: 'CHUA_XAC_MINH', missing: ['Insufficient chronological samples.'], folds };
  // A proposal is one fixed parameter version. Earlier folds explored different
  // parameters and MUST NOT be pooled as evidence of this final version's edge.
  return { status: 'COMPLETED', missing: [], folds, selected: selected.parameters, backtest: selected.result, ...metrics(folds.at(-1).result.details), evidenceIds: history.map(e => e.id) };
}
module.exports = { backtest, walkforward };
