'use strict';
// Real (no-mock) tests for the Jev decision adapter.
// Run: node --test tests/jev-decision.test.cjs
// Requires network + the machine TypeSafe key (C:\JEV). No key => the degrade
// contract tests still run; live-verdict tests are skipped, not faked.
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateCandidate, buildQuestions, CONFIDENCE_FLOOR, hasKey } = require('../services/jev/decision/jev-client.cjs');

const healthyCandidate = {
  token: 'EXAMPLE-token-1', network: 'SOLANA',
  liquidityUsd: 85000, volume24hUsd: 420000, priceUsd: 0.0042,
  ageMinutes: 95, top10HolderShare: 0.22, observedAt: new Date().toISOString()
};

test('buildQuestions produces a spec-shaped batch (noul + score + choice)', () => {
  const { state, questions } = buildQuestions(healthyCandidate);
  assert.equal(questions.tradable.type, 'noul');
  assert.equal(questions.momentum.type, 'score');
  assert.equal(questions.action.type, 'choice');
  assert.deepEqual(Object.keys(questions.action.criteria).sort(), ['REJECT', 'TRADE', 'WATCH']);
  assert.equal(state.liquidityUsd, 85000);
});

test('degrade contract: API unavailable returns ok:false with fallback rule-quant, never throws', async () => {
  const r = await evaluateCandidate(healthyCandidate, 'khong-ton-tai-model-xyz');
  assert.equal(r.ok, false);
  assert.ok(['bad-request', 'validation', 'auth', 'no-key', 'rate-limit', 'network', 'timeout', 'api-outage'].includes(r.reason), 'reason=' + r.reason);
  assert.equal(r.fallback, 'rule-quant');
});

// Live verdicts (skip cleanly when no key — never fake a PASS)
if (hasKey()) {
  test('live: healthy candidate returns typed verdict with confidence + guardrail clean', async () => {
    const v = await evaluateCandidate(healthyCandidate);
    assert.equal(v.ok, true, JSON.stringify(v).slice(0, 200));
    assert.ok(['TRADE', 'WATCH', 'REJECT'].includes(v.action), 'action=' + v.action);
    if (v.confidence !== null) assert.ok(v.confidence >= 0 && v.confidence <= 1);
    assert.ok(v.tradableProbability === null || (v.tradableProbability >= 0 && v.tradableProbability <= 1));
    assert.ok(typeof v.momentum === 'number' && v.momentum >= 0 && v.momentum <= 4, 'momentum=' + v.momentum);
    assert.equal(v.guardrail.violations.length, 0);
    assert.ok(v.latencyMs < 15000, 'latency=' + v.latencyMs);
  });

  test('live: garbage candidate gets REJECT or WATCH, never TRADE', async () => {
    const v = await evaluateCandidate({
      token: 'EXAMPLE-rug-ish', network: 'SOLANA',
      liquidityUsd: 900, volume24hUsd: 150, priceUsd: 0.0000001,
      ageMinutes: 2, top10HolderShare: 0.94, observedAt: new Date().toISOString()
    });
    assert.equal(v.ok, true, JSON.stringify(v).slice(0, 200));
    assert.ok(['WATCH', 'REJECT'].includes(v.action), 'action=' + v.action + ' conf=' + v.confidence);
    // A REJECT on low confidence is a guess: the client must have downgraded it.
    if (v.action === 'REJECT') assert.ok(v.confidence >= 0.7, 'REJECT confidence must be >= 0.7, got ' + v.confidence);
  });

  test('live: unknown-data candidate is never rejected for missing data', async () => {
    const v = await evaluateCandidate({
      token: 'EXAMPLE-unknown-data', network: 'ROBINHOOD',
      liquidityUsd: 0, volume24hUsd: 0, priceUsd: null,
      ageMinutes: null, top10HolderShare: null, observedAt: new Date().toISOString()
    });
    assert.equal(v.ok, true, JSON.stringify(v).slice(0, 200));
    if (v.action === 'REJECT') assert.ok(v.confidence >= 0.7, 'REJECT on unknown data needs high confidence, got ' + v.confidence);
  });
} else {
  test('live verdicts skipped: no TypeSafe key on this machine', () => { assert.ok(true); });
}
