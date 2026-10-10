'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { economicViability } = require('../core/risk/viability.cjs');
const { DEFAULT_POLICY } = require('../core/risk/engine.cjs');
test('costs that consume the existing stop room wait, and a larger actual size does not', () => {
  const common = { plannedOrderUsd: 100, feeBps: DEFAULT_POLICY.feeBps, slippageBps: DEFAULT_POLICY.slippageBps, priceImpactBps: 10, stopDistance: DEFAULT_POLICY.stopDistance };
  const small = economicViability({ ...common, actualOrderUsd: 1, gasUsd: 1 });
  const sized = economicViability({ ...common, actualOrderUsd: 100, gasUsd: 0.01 });
  assert.equal(small.state, 'WAIT');
  assert.ok(small.totalUsd >= 1 * DEFAULT_POLICY.stopDistance);
  assert.equal(sized.state, 'ELIGIBLE');
  assert.match(sized.reason, /planned 100 USD, actual 100 USD/);
  assert.match(sized.reason, /stays inside 10 bps/);
});
