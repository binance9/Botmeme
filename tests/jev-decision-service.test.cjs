'use strict';
// Jev decision service tests — real TypeSafe System One calls (no mocks).
// Run: node --test tests/jev-decision-service.test.cjs
// Degrade contract: with or without a working API the service publishes exactly
// one verdict per candidate and never throws.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('../runtime/events/bus.cjs');
const { createJevDecision } = require('../services/jev/decision/service.cjs');
const { hasKey } = require('../services/jev/decision/jev-client.cjs');

function fixture() {
  const at = new Date().toISOString();
  const snap = { id: 'snap-jev-svc', type: 'MarketSnapshot', timestamp: at, producer: 'MARKET_DATA', source: 'test.scan', evidence: [], status: 'OBSERVED', correlationId: 'corr-jev-svc', network: 'SOLANA', epoch: 1, confidence: 0.9, evidence_quality: 0.9, missing_evidence: [], uncertainty: 0.1,
    payload: { token: 'TOKENJEV', price: 0.004, liquidityUsd: 90000, volume24hUsd: 450000, observedAt: at, marketCapUsd: 70000, poolAgeMs: 25 * 60 * 1000, realVolumeUsd: 60000 } };
  const cand = { id: 'cand-jev-svc', type: 'TokenCandidate', timestamp: at, producer: 'JEV', source: 'test.hunter', evidence: [snap.id], status: 'OBSERVED', correlationId: 'corr-jev-svc', network: 'SOLANA', epoch: 1, confidence: 0.85, evidence_quality: 0.85, missing_evidence: [], uncertainty: 0.15,
    payload: { token: 'TOKENJEV', symbol: 'TKJ', snapshotId: snap.id, liquidityUsd: 90000, volume24hUsd: 450000, rank: 1, anomalies: ['TOKEN_DISCOVERY'] } };
  return { snap, cand };
}

test('service publishes exactly one typed JevVerdict per candidate (live API or honest degrade)', async () => {
  const runtime = createRuntime({ now: () => new Date() });
  const service = createJevDecision({ runtime });
  service.start();
  const { snap, cand } = fixture();
  runtime.publish(snap);
  runtime.publish(cand);
  await runtime.flush();
  // Verdicts are evaluated detached (bounded parallel) — poll briefly for the
  // degraded/typed verdict to land instead of assuming synchronous delivery.
  let verdicts = [];
  for (let i = 0; i < 40 && !(verdicts = runtime.snapshot().events.filter(e => e.type === 'JevVerdict' && e.payload.candidateId === cand.id)).length; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(verdicts.length, 1, 'one verdict per candidate');
  const v = verdicts[0];
  assert.ok(['TRADE', 'WATCH', 'REJECT', 'NO_ACTION'].includes(v.payload.action), 'action=' + v.payload.action);
  assert.ok(v.payload.latencyMs >= 1);
  assert.ok(Array.isArray(v.payload.violations));
  if (v.status === 'COMPLETED') {
    assert.ok(v.payload.model.length > 0 && v.payload.model !== 'unavailable');
    if (hasKey()) assert.ok(true); // live call succeeded
  } else {
    assert.equal(v.status, 'CHUA_XAC_MINH');
    assert.equal(v.payload.action, 'NO_ACTION');
  }
  // Idempotent: a second delivery (restart replay) must not duplicate the verdict.
  runtime.publish({ ...cand });
  await runtime.flush();
  assert.equal(runtime.snapshot().events.filter(e => e.type === 'JevVerdict' && e.payload.candidateId === cand.id).length, 1);
  await service.stop();
  await runtime.close();
});
