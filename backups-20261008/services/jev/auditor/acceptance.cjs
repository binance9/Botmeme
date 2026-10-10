'use strict';
const { canonical, sha256, validatePacket, KINDS } = require('./contract.cjs');
const { assertNoSecrets } = require('./secrets.cjs');
const { buildRegistry } = require('./evidence-registry.cjs');
const { evaluateReview } = require('./evaluation.cjs');
const { verifyObligations } = require('./proofs.cjs');
const { unchanged } = require('./evidence.cjs');
const path = require('node:path');
const { unresolvedFailures, policyRevision } = require('./history.cjs');
const { criterionView } = require('./views.cjs');
const { assertAttribution } = require('./attribution.cjs');
const { assertReadback } = require('./readback.cjs');
const { trustedIdentity } = require('./reviewer-identity.cjs');
function sourceHash(packet, binding) {
  return binding ? sha256(canonical({ root: binding.root, files: packet.documents.filter(d => d.kind === 'source').map(d => ({ file: d.file, sha256: d.sha256 })) })) : null;
}
function blocked(packet, envelope, code, binding = null) {
  const file = packet?.documents?.[0]?.file ?? 'audit-request';
  return { ...envelope, status: 'CHUA_XAC_MINH', scope: packet?.scope ?? 'rejected-audit-request', findings: [{ id: 'HOST_GATE', severity: 'UNKNOWN', file, message: code, evidence_ids: [] }], root_causes: [{ finding_id: 'HOST_GATE', explanation: code, evidence_ids: [] }], evidence: [], evidence_ids: [], missing_evidence: [code], required_fixes: [{ finding_id: 'HOST_GATE', action: 'Resolve the stated evidence or reviewer failure and perform a fresh bounded review.', files: [file] }], affected_files: [file], source_hash: packet && binding ? sourceHash(packet, binding) : null, checks: [], authority: 'deterministic-acceptance/2' };
}
function decide(packet, envelope, binding, { revoked = false } = {}) {
  validatePacket(packet); assertNoSecrets(envelope);
  const evaluated = evaluateReview(packet, envelope.analysis), proof = verifyObligations(packet);
  const registry = buildRegistry(packet), used = new Set(evaluated.evidence_ids), missing = [...evaluated.missing_evidence, ...proof.missing_evidence];
  const source_hash = sourceHash(packet, binding);
  for (const kind of KINDS) if (!packet.documents.some(d => d.kind === kind && d.content.trim())) missing.push('MISSING_EVIDENCE_KIND:' + kind);
  const attempt = envelope.source?.attempts?.at(-1);
  if (envelope.producer !== 'JEV_AUDITOR' || envelope.source?.kind !== 'internal-review-agent' || !trustedIdentity(attempt?.provider, attempt?.model, { deep: true }) || attempt?.result !== 'VALID_STRUCTURED_REVIEW' || attempt?.protocol !== 'evidence-first/2') missing.push('ATTRIBUTED_ANALYSIS_REQUIRED');
  if (envelope.packetHash !== registry.packet_hash) missing.push('PACKET_HASH_MISMATCH');
  const expectedViews = packet.criteria.map(c => criterionView(packet, c.id).manifest);
  if (canonical(attempt?.views) !== canonical(expectedViews)) missing.push('REVIEW_VIEW_COVERAGE_INCOMPLETE');
  const supported = evaluated.result.checks.filter(check => check.status === 'PASS');
  const readbacks = attempt?.readbacks;
  if (supported.length && (attempt?.readback_protocol !== 'evidence-readback/1' || !Array.isArray(readbacks) || readbacks.length !== attempt?.views?.length)) missing.push('READBACK_COVERAGE_REQUIRED');
  for (const check of supported) {
    try {
      const matches = Array.isArray(readbacks) ? readbacks.filter(raw => Object.hasOwn(raw?.criteria ?? {}, check.criterion_id)) : [];
      if (matches.length !== 1) throw Error('INVALID_READBACK_COVERAGE');
      assertReadback(packet, { criteria: { [check.criterion_id]: envelope.analysis.criteria[check.criterion_id] } }, check.criterion_id, matches[0]);
    } catch { missing.push('READBACK_BINDING_INVALID:' + check.criterion_id); }
  }
  const attributions = attempt?.attributions;
  const attribution_proofs = [];
  if (supported.length && (!Array.isArray(attributions) || attributions.length !== supported.length)) missing.push('ATTRIBUTION_COVERAGE_REQUIRED');
  for (const check of supported) {
    const matches = Array.isArray(attributions) ? attributions.filter(a => a?.review?.criterion_id === check.criterion_id) : [];
    try {
      if (matches.length !== 1) throw Error('INVALID_ATTRIBUTION_COVERAGE');
      const verified = assertAttribution(packet, { criteria: { [check.criterion_id]: envelope.analysis.criteria[check.criterion_id] } }, check.criterion_id, matches[0], { provider: attempt?.provider, model: attempt?.model });
      attribution_proofs.push({ criterion_id: verified.criterion_id, bundle_hash: verified.bundle_hash, proof_hash: verified.proof_hash, status: verified.status });
      if (verified.status !== 'SUPPORTED') missing.push('ATTRIBUTION_VETO:' + check.criterion_id + ':' + verified.status);
    } catch { missing.push('ATTRIBUTION_BINDING_INVALID:' + check.criterion_id); }
  }
  if (revoked) missing.push('RECEIPT_REVOKED');
  if (!binding) missing.push('HOST_BINDING_REQUIRED');
  else {
    let revision = null;
    try { revision = policyRevision(packet, binding); } catch { missing.push('POLICY_REVISION_BINDING_INVALID'); }
    if (!revision || binding.policyRevision !== revision) missing.push('POLICY_REVISION_BINDING_INVALID');
    try { for (const id of unresolvedFailures(packet.scope, source_hash, revision, envelope.receipt_id)) missing.push('UNRESOLVED_PRIOR_FAIL:' + id); }
    catch { missing.push('AUDIT_HISTORY_UNREADABLE'); }
    if (binding.packetHash !== registry.packet_hash) missing.push('COLLECTED_PACKET_BINDING_MISMATCH');
    const profile = Object.values(require('./profiles.cjs').profiles).find(p => p.scope === packet.scope);
    const roots = require('./evidence.cjs');
    if (!profile || path.resolve(binding.root).toLowerCase() !== path.resolve(profile.legacy ? roots.LEGACY : roots.ROOT).toLowerCase()) missing.push('PROFILE_SOURCE_ROOT_MISMATCH');
    try {
      const runtime = JSON.parse(packet.documents.find(d => d.kind === 'runtime').content), dependencies = JSON.parse(packet.documents.find(d => d.kind === 'dependency').content);
      const args = roots.CHECKS[binding.check];
      const command = args && [process.execPath, ...(args.includes('--test') ? ['--test-reporter=tap'] : []), ...args];
      if (!command || canonical(runtime.command) !== canonical(command) || runtime.cwd !== roots.ROOT) missing.push('FIXED_RUNTIME_COMMAND_MISMATCH');
      const sources = packet.documents.filter(d => d.kind === 'source').map(d => ({ file: d.file, sha256: d.sha256 }));
      if (sha256(canonical(sources)) !== binding.sourceDigest || runtime.sourceDigest !== binding.sourceDigest || runtime.protectedDigest !== binding.protectedDigest || runtime.outputSha256 !== sha256(runtime.output) || sha256(canonical(runtime)) !== binding.runtimeDigest || runtime.check !== binding.check || canonical(dependencies) !== canonical(binding.dependency)) missing.push('RUNTIME_OR_SOURCE_BINDING_INVALID');
      if (runtime.exitCode !== 0 || runtime.problem) missing.push('RUNTIME_CHECK_UNSUCCESSFUL');
      if (!Array.isArray(dependencies.unresolved) || dependencies.unresolved.length) missing.push('UNRESOLVED_DEPENDENCIES');
      if (!unchanged(binding)) missing.push('SOURCE_OR_POLICY_CHANGED');
    } catch { missing.push('HOST_RUNTIME_EVIDENCE_INVALID'); }
  }
  for (const obligation of proof.outcomes) {
    for (const entry of registry.entries) if (entry.kind === 'runtime' && entry.anchor.startsWith('R') && new RegExp('^(?:not )?ok \\d+ - ' + escapeRegex(obligation.verifier_id) + '$').test(entry.quote)) used.add(entry.id);
  }
  const status = evaluated.result.status === 'FAIL' || proof.status === 'FAIL' ? 'FAIL' : evaluated.result.status === 'PASS' && proof.status === 'PASS' && !missing.length ? 'PASS' : 'CHUA_XAC_MINH';
  const result = { ...envelope, ...evaluated.result, status, evidence_ids: [...used], missing_evidence: [...new Set(missing)], source_hash, registry_hash: registry.registry_hash, proof_obligations: proof.outcomes, attribution_proofs, authority: 'deterministic-acceptance/2' };
  if (proof.status === 'FAIL' || missing.length) {
    const file = packet.documents[0].file, id = 'HOST_OBLIGATIONS';
    result.findings.push({ id, severity: proof.status === 'FAIL' ? 'ERROR' : 'UNKNOWN', file, message: proof.status === 'FAIL' ? 'A required deterministic verifier failed.' : 'Acceptance evidence is incomplete or invalid.', evidence_ids: [] });
    result.root_causes.push({ finding_id: id, explanation: proof.status === 'FAIL' ? proof.outcomes.filter(o => o.status === 'FAILED').map(o => o.verifier_id).join('; ') : missing.join('; '), evidence_ids: [] });
    result.required_fixes.push({ finding_id: id, action: 'Fix the failed obligation or missing evidence; do not bypass the acceptance policy.', files: [file] });
    result.affected_files = [...new Set([...result.affected_files, file])];
  }
  return result;
}
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
module.exports = { decide, blocked, sourceHash };
