'use strict';
const { canonical, validateResult } = require('./contract.cjs');
const { assertNoSecrets } = require('./secrets.cjs');
const { buildRegistry } = require('./evidence-registry.cjs');
const { criterionView } = require('./views.cjs');
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const string = () => ({ type: 'string' });
const array = items => ({ type: 'array', items });
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && canonical(Object.keys(v).sort()) === canonical([...keys].sort());
const text = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 2000;
const bareEvidenceId = v => /^[\[({\s]*E(?:[a-f0-9]{12}|[a-z]+\d+_[LR]\d+(?:p\d+)?_[a-f0-9]{12})[\])}\s]*$/i.test(v);
function schemaFor(packet, criterionIds = packet.criteria.map(c => c.id)) {
  return object({ criteria: object(Object.fromEntries(packet.criteria.filter(c => criterionIds.includes(c.id)).map(c => {
    const view = criterionView(packet, c.id), files = [...new Set(view.documents.map(d => d.file))];
    const ids = kind => ({ type: 'string', enum: view.entries.filter(e => !kind || e.kind === kind).map(e => e.id) });
    const schema = object({
    observations: object(Object.fromEntries(c.evidenceKinds.map(kind => [kind, array(object({ evidence_id: ids(kind), explanation: string() }))]))),
    findings: array(object({ severity: { type: 'string', enum: ['ERROR', 'UNKNOWN'] }, file: { type: 'string', enum: files }, message: string(), root_cause: string(), required_fix: string(), evidence_ids: array(ids()) })),
    missing_evidence: array(string()),
    reason: string(), assessment: { type: 'string', enum: ['SUPPORTS', 'CONTRADICTS', 'UNKNOWN'] }
    });
    // Preserve the required-field contract; only generation property order changes.
    schema.required = ['assessment', 'reason', 'observations', 'findings', 'missing_evidence'];
    return [c.id, schema];
  }))) });
}
function evaluateReview(packet, raw, criterionIds = packet.criteria.map(c => c.id)) {
  assertNoSecrets(raw);
  const registry = buildRegistry(packet), byId = new Map(registry.entries.map(e => [e.id, e]));
  const criteria = packet.criteria.filter(c => criterionIds.includes(c.id));
  if (!criteria.length || new Set(criterionIds).size !== criterionIds.length || criteria.length !== criterionIds.length || !exact(raw, ['criteria']) || !exact(raw.criteria, criterionIds)) throw Error('INVALID_REVIEW_SCHEMA');
  const selected = new Set(), missing = [], checks = [], findings = [], root_causes = [], required_fixes = [];
  const affected = new Set(), documentIds = new Set();
  const resolve = (id, kind) => { const e = byId.get(id); if (!e || e.scope !== packet.scope || (kind && e.kind !== kind)) throw Error('INVALID_EVIDENCE_SELECTION'); selected.add(id); documentIds.add(e.document_id); return e; };
  for (const c of criteria) {
    const allowed = new Set(criterionView(packet, c.id).entries.map(e => e.id));
    const select = (id, kind) => { const entry = resolve(id, kind); if (!allowed.has(id)) throw Error('INVALID_CRITERION_EVIDENCE'); return entry; };
    const review = raw.criteria[c.id], refs = new Set(), observations = [];
    if (!exact(review, ['assessment', 'reason', 'observations', 'findings', 'missing_evidence']) || !['SUPPORTS', 'CONTRADICTS', 'UNKNOWN'].includes(review.assessment) || !text(review.reason) || review.reason.trim() === c.requirement.trim() || !exact(review.observations, c.evidenceKinds) || !Array.isArray(review.findings) || !Array.isArray(review.missing_evidence) || review.missing_evidence.some(v => !text(v))) throw Error('INVALID_CRITERION_ANALYSIS');
    const absent = [];
    for (const kind of c.evidenceKinds) {
      const list = review.observations[kind];
      if (!Array.isArray(list)) throw Error('INVALID_OBSERVATION_LIST');
      if (!list.length) absent.push(c.id + ':' + kind);
      const seen = new Set();
      for (const observation of list) {
        if (!exact(observation, ['evidence_id', 'explanation']) || !text(observation.explanation) || observation.explanation.trim() === c.requirement.trim() || seen.has(observation.evidence_id)) throw Error('INVALID_AUDIT_OBSERVATION');
        seen.add(observation.evidence_id);
        const e = select(observation.evidence_id, kind); refs.add(e.document_id);
        observations.push({ document_id: e.document_id, quote: e.quote, explanation: observation.explanation });
      }
    }
    for (const [index, f] of review.findings.entries()) {
      if (!exact(f, ['severity', 'file', 'message', 'root_cause', 'required_fix', 'evidence_ids']) || !['ERROR', 'UNKNOWN'].includes(f.severity) || !packet.documents.some(d => d.file === f.file) || ![f.message, f.root_cause, f.required_fix].every(text) || !Array.isArray(f.evidence_ids) || !f.evidence_ids.length) throw Error('INVALID_ANALYSIS_FINDING');
      const cited = f.evidence_ids.map(id => select(id));
      if (!cited.some(e => e.file === f.file)) throw Error('INVALID_FINDING_TARGET_EVIDENCE');
      const evidence_ids = [...new Set(cited.map(e => e.document_id))], id = c.id + '/finding-' + (index + 1);
      evidence_ids.forEach(ref => refs.add(ref)); affected.add(f.file);
      findings.push({ id, severity: f.severity, file: f.file, message: f.message, evidence_ids });
      root_causes.push({ finding_id: id, explanation: f.root_cause, evidence_ids });
      required_fixes.push({ finding_id: id, action: f.required_fix, files: [f.file] });
    }
    // An ID names evidence already supplied, not a description of a missing
    // fact. Reject this format error only for otherwise supportive analysis;
    // never discard validated negative/unknown analysis to retry it into support.
    const malformedMissing = review.missing_evidence.some(bareEvidenceId);
    if (malformedMissing && review.assessment === 'SUPPORTS' && !review.findings.length) throw Error('INVALID_MISSING_EVIDENCE_DESCRIPTION');
    absent.push(...review.missing_evidence.map(v => c.id + ':' + (bareEvidenceId(v) ? 'INVALID_MISSING_EVIDENCE_DESCRIPTION' : v)));
    let status = review.findings.some(f => f.severity === 'ERROR') ? 'FAIL' : review.assessment === 'SUPPORTS' && !absent.length && !review.findings.length ? 'PASS' : 'CHUA_XAC_MINH';
    if (review.assessment === 'CONTRADICTS' && !review.findings.length) absent.push(c.id + ':counterexample-and-root-cause');
    if (status === 'CHUA_XAC_MINH' && !absent.length) absent.push(c.id + ':unresolved-review');
    missing.push(...absent);
    if (status !== 'PASS' && !review.findings.length) {
      const id = c.id + '/missing', file = packet.documents[0].file, evidence_ids = [...refs]; affected.add(file);
      findings.push({ id, severity: 'UNKNOWN', file, message: absent.join('; ') || 'Unresolved review', evidence_ids });
      root_causes.push({ finding_id: id, explanation: 'Required criterion evidence has not been established.', evidence_ids });
      required_fixes.push({ finding_id: id, action: 'Supply and verify the missing criterion evidence before acceptance.', files: [file] });
    }
    checks.push({ criterion_id: c.id, status, reason: review.reason, evidence_ids: [...refs], observations });
  }
  const status = checks.some(c => c.status === 'FAIL') ? 'FAIL' : checks.some(c => c.status !== 'PASS') ? 'CHUA_XAC_MINH' : 'PASS';
  const result = { status, scope: packet.scope, findings, root_causes, evidence: [...documentIds], required_fixes, affected_files: [...affected], checks };
  // Preserve the original exact quote and coverage validator for all supported
  // criteria. Missing evidence remains an explicit host unknown, never invented.
  if (status === 'PASS') validateResult(result, { ...packet, criteria });
  else for (const check of checks.filter(c => c.status === 'PASS')) {
    validateResult({ status: 'PASS', scope: packet.scope, findings: [], root_causes: [], evidence: check.evidence_ids, required_fixes: [], affected_files: [], checks: [check] }, { ...packet, criteria: packet.criteria.filter(c => c.id === check.criterion_id) });
  }
  return { result, evidence_ids: [...selected], missing_evidence: [...new Set(missing)], analysis: structuredClone(raw), registry_hash: registry.registry_hash };
}
module.exports = { schemaFor, evaluateReview };
