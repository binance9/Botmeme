'use strict';
// A reproducible counterexample against the actual legacy function, not a market
// demo or trading acceptance. The imported module has no file/network side effects.
(async () => {
  const { paperStatistics } = await import('file:///C:/botcode%201/MemePilot/src/statistics.mjs');
  const actual = paperStatistics({ initialUsd: 100, trades: [{ side: 'BUY' }, { side: 'SELL', partial: true, pnlUsd: 10 }, { side: 'SELL', partial: false, pnlUsd: -5 }], balanceHistory: [] });
  const expected = { closedTrades: 1, winRatePct: 100 };
  const matches = actual.closedTrades === expected.closedTrades && actual.winRatePct === expected.winRatePct;
  console.log(JSON.stringify({ case: 'One closed net-winning position with two exit fills', expected, actual, result: matches ? 'PASS' : 'FAIL', interpretation: 'Position win-rate contract only; no live trade or profit claim' }));
  process.exitCode = matches ? 0 : 1;
})().catch(() => { console.error('STATISTICS_CHECK_FAILED'); process.exitCode = 2; });
