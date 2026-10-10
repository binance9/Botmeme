'use strict';
// Identity protocol fixtures only; never evidence of real model acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const { trustedIdentity, attributionIdentity } = require('../services/jev/auditor/reviewer-identity.cjs');
const { sha256, KINDS } = require('../services/jev/auditor/contract.cjs');
const { buildRegistry } = require('../services/jev/auditor/evidence-registry.cjs');
const { JevAuditor } = require('../services/jev/auditor/service.cjs');
const { buildAttributionInput, attributionParts, assembleAttribution, assertAttribution, validateAttributionPart } = require('../services/jev/auditor/attribution.cjs');
function fixture() {
  const packet = { scope: 'identity-protocol-fixture', criteria: [{ id: 'identity', requirement: 'Check exact supplied evidence identity.', evidenceKinds: [...KINDS] }], documents: KINDS.map(kind => { const content = `Explicit identity protocol fixture evidence for ${kind}.`; return { id: kind, kind, file: `tests/identity/${kind}.txt`, content, sha256: sha256(content) }; }) };
  const registry = buildRegistry(packet);
  const analysis = { criteria: { identity: { assessment: 'SUPPORTS', reason: 'The selected fixture passages are the provided evidence.', observations: Object.fromEntries(KINDS.map(kind => [kind, [{ evidence_id: registry.entries.find(e => e.kind === kind).id, explanation: 'The quoted passage identifies a protocol fixture.' }]])), findings: [], missing_evidence: [] } } };
  const input = buildAttributionInput(packet, analysis, 'identity');
  const identity = { provider: 'ssh-llamacpp', model: 'qwen3-32b' };
  const parts = attributionParts(input).map(part => ({ ...identity, input: part, review: { input_hash: part.input_hash, relation: 'SUPPORTED', reason: 'Explicit protocol fixture judgment.' } }));
  return { packet, analysis, input, identity, parts, receipt: { ...identity, parts, review: assembleAttribution(input, parts) } };
}
test('allowlist accepts only exact provider model pairs and retains deep-review restriction', () => {
  assert.equal(trustedIdentity('ssh-llamacpp', 'qwen3-32b', { deep: true }), true);
  assert.equal(trustedIdentity('ollama-local', 'qwen3:14b', { deep: true }), true);
  assert.equal(trustedIdentity('ollama-local', 'qwen3:8b'), true);
  assert.equal(trustedIdentity('ollama-local', 'qwen3:8b', { deep: true }), false);
  for (const [provider, model] of [['ssh-llamacpp', 'qwen3:14b'], ['ollama-local', 'qwen3-32b'], ['ssh-llamacpp', 'qwen3:32b'], ['arbitrary', 'qwen3-32b'], [undefined, 'qwen3-32b']]) assert.equal(trustedIdentity(provider, model), false);
  assert.equal(attributionIdentity({ model: 'qwen3-32b' }), null);
  assert.deepEqual(attributionIdentity({ model: 'qwen3:14b' }), { provider: 'ollama-local', model: 'qwen3:14b' });
});
test('new attribution identity binds all isolated parts and primary identity without bypassing veto', () => {
  const { packet, analysis, input, identity, parts, receipt } = fixture();
  assert.equal(assertAttribution(packet, analysis, 'identity', receipt, identity).status, 'SUPPORTED');
  assert.throws(() => assertAttribution(packet, analysis, 'identity', receipt, { provider: 'ollama-local', model: 'qwen3:14b' }), /INVALID_ATTRIBUTION_REVIEWER/);
  const absent = structuredClone(parts[0]); delete absent.provider;
  assert.throws(() => validateAttributionPart(absent.input, absent), /INVALID_ATTRIBUTION_PART_BINDING/);
  const mixed = structuredClone(parts); mixed[0] = { ...mixed[0], provider: 'ollama-local', model: 'qwen3:14b' };
  assert.throws(() => assembleAttribution(input, mixed), /INVALID_ATTRIBUTION_PART_BINDING/);
  const swapped = { ...receipt, provider: 'ollama-local', model: 'qwen3:14b' };
  assert.throws(() => assertAttribution(packet, analysis, 'identity', swapped), /INVALID_ATTRIBUTION_REVIEWER/);
  parts[0].review.relation = 'CONTRADICTED'; receipt.review = assembleAttribution(input, parts);
  assert.equal(assertAttribution(packet, analysis, 'identity', receipt, identity).status, 'CONTRADICTED');
  parts[0].review.input_hash = 'f'.repeat(64);
  assert.throws(() => assembleAttribution(input, parts), /INVALID_ATTRIBUTION_PART_REVIEW/);
});
test('service rejects mismatched declared identity and new identity does not grant acceptance without host evidence', async () => {
  const { packet, analysis } = fixture();
  for (const provider of ['ollama-local', 'arbitrary']) {
    const reviewer = { provider: 'ssh-llamacpp', model: 'qwen3-32b', async review() { return { analysis, provenance: { provider, model: 'qwen3-32b', protocol: 'evidence-first/2' } }; } };
    const result = await new JevAuditor({ reviewer, escalationReviewer: null }).audit(packet);
    assert.equal(result.status, 'CHUA_XAC_MINH'); assert.equal(result.source.attempts[0].result, 'INVALID_REVIEWER_IDENTITY');
  }
  const reviewer = { provider: 'ssh-llamacpp', model: 'qwen3-32b', async review() { return { analysis, provenance: { provider: 'ssh-llamacpp', model: 'qwen3-32b', protocol: 'evidence-first/2' } }; } };
  const result = await new JevAuditor({ reviewer, escalationReviewer: null }).audit(packet);
  assert.equal(result.status, 'CHUA_XAC_MINH');
  assert.equal(result.source.attempts[0].result, 'VALID_STRUCTURED_REVIEW');
  assert.ok(result.missing_evidence.includes('HOST_BINDING_REQUIRED'));
  assert.ok(result.missing_evidence.includes('ATTRIBUTION_COVERAGE_REQUIRED'));
});
