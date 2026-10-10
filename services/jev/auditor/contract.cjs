'use strict';
const { createHash } = require('node:crypto');
const { assertNoSecrets } = require('./secrets.cjs');
const STATUSES = ['PASS', 'FAIL', 'CHUA_XAC_MINH'];
const KINDS = ['source', 'diff', 'architecture', 'runtime', 'dependency'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const fail = message => { throw new Error(message); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const text = (value, max = 2000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const id = value => typeof value === 'string' && /^[a-zA-Z0-9._:/-]{1,160}$/.test(value);
function validatePacket(packet) {
  assertNoSecrets(packet);
  if (!exact(packet, ['scope', 'criteria', 'documents']) || !text(packet.scope, 200)) fail('INVALID_AUDIT_PACKET');
  if (!Array.isArray(packet.criteria) || !packet.criteria.length || packet.criteria.length > 30 || packet.criteria.some(c => !exact(c, ['id', 'requirement', 'evidenceKinds']) || !id(c.id) || !text(c.requirement) || !Array.isArray(c.evidenceKinds) || !c.evidenceKinds.length || c.evidenceKinds.some(k => !KINDS.includes(k)))) fail('INVALID_AUDIT_CRITERIA');
  if (new Set(packet.criteria.map(c => c.id)).size !== packet.criteria.length) fail('DUPLICATE_CRITERION');
  if (!Array.isArray(packet.documents) || packet.documents.length > 80) fail('INVALID_AUDIT_DOCUMENTS');
  const ids = new Set();
  for (const d of packet.documents) {
    if (!exact(d, ['id', 'kind', 'file', 'sha256', 'content']) || !id(d.id) || !KINDS.includes(d.kind) || !text(d.file, 300) || typeof d.content !== 'string' || d.content.length > 160000 || d.sha256 !== sha256(d.content) || ids.has(d.id)) fail('INVALID_EVIDENCE_DOCUMENT');
    if (/(?:^|[\\/])(?:\.env(?:\..*)?|auth\.json|credentials?[^\\/]*|.*\.(?:dpapi|sqlite))$/i.test(d.file)) fail('PRIVATE_FILE_DENIED');
    ids.add(d.id);
  }
  if (Buffer.byteLength(canonical(packet)) > 180000) fail('AUDIT_PACKET_TOO_LARGE');
  return packet;
}
const stringSchema = { type: 'string' };
const strings = { type: 'array', items: stringSchema };
const obj = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const RESULT_SCHEMA = obj({
  status: { type: 'string', enum: STATUSES }, scope: stringSchema,
  findings: { type: 'array', items: obj({ id: stringSchema, severity: { type: 'string', enum: ['ERROR', 'UNKNOWN'] }, file: stringSchema, message: stringSchema, evidence_ids: strings }) },
  root_causes: { type: 'array', items: obj({ finding_id: stringSchema, explanation: stringSchema, evidence_ids: strings }) },
  evidence: strings,
  required_fixes: { type: 'array', items: obj({ finding_id: stringSchema, action: stringSchema, files: strings }) },
  affected_files: strings,
  checks: { type: 'array', items: obj({ criterion_id: stringSchema, status: { type: 'string', enum: STATUSES }, reason: stringSchema, evidence_ids: strings, observations: { type: 'array', items: obj({ document_id: stringSchema, quote: stringSchema, explanation: stringSchema }) } }) }
});
function validateResult(result, packet) {
  assertNoSecrets(result);
  if (!exact(result, Object.keys(RESULT_SCHEMA.properties)) || !STATUSES.includes(result.status) || result.scope !== packet.scope) fail('INVALID_AUDIT_RESULT');
  const docs = new Map(packet.documents.map(d => [d.id, d])), files = new Set(packet.documents.map(d => d.file));
  const refs = values => Array.isArray(values) && values.length > 0 && values.every(v => docs.has(v)) && new Set(values).size === values.length;
  const fileList = values => Array.isArray(values) && values.every(v => files.has(v)) && new Set(values).size === values.length;
  if (!Array.isArray(result.findings) || !Array.isArray(result.root_causes) || !Array.isArray(result.required_fixes) || !Array.isArray(result.checks) || !Array.isArray(result.evidence) || !fileList(result.affected_files) || result.evidence.some(e => !docs.has(e))) fail('INVALID_AUDIT_REFERENCES');
  const findings = new Map();
  for (const f of result.findings) {
    if (!exact(f, ['id', 'severity', 'file', 'message', 'evidence_ids']) || !id(f.id) || findings.has(f.id) || !['ERROR', 'UNKNOWN'].includes(f.severity) || !files.has(f.file) || !text(f.message) || !refs(f.evidence_ids) || !result.affected_files.includes(f.file)) fail('INVALID_AUDIT_FINDING');
    findings.set(f.id, f);
  }
  for (const cause of result.root_causes) if (!exact(cause, ['finding_id', 'explanation', 'evidence_ids']) || !findings.has(cause.finding_id) || !text(cause.explanation) || !refs(cause.evidence_ids)) fail('INVALID_ROOT_CAUSE');
  for (const fix of result.required_fixes) if (!exact(fix, ['finding_id', 'action', 'files']) || !findings.has(fix.finding_id) || !text(fix.action) || !fileList(fix.files) || !fix.files.length) fail('INVALID_REQUIRED_FIX');
  for (const f of findings.values()) if (!result.root_causes.some(c => c.finding_id === f.id) || !result.required_fixes.some(c => c.finding_id === f.id)) fail('FINDING_WITHOUT_ACTIONABLE_CAUSE');
  const criteria = new Map(packet.criteria.map(c => [c.id, c])), seen = new Set();
  for (const check of result.checks) {
    if (!exact(check, ['criterion_id', 'status', 'reason', 'evidence_ids', 'observations'])) fail('INVALID_AUDIT_CHECK');
    if (!criteria.has(check.criterion_id)) fail('INVALID_AUDIT_CHECK');
    if (seen.has(check.criterion_id)) fail('INVALID_AUDIT_CHECK');
    if (!STATUSES.includes(check.status) || !text(check.reason) || !refs(check.evidence_ids) || !Array.isArray(check.observations)) fail('INVALID_AUDIT_CHECK');
    const criterion = criteria.get(check.criterion_id);
    if (check.status === 'PASS' && criterion.evidenceKinds.some(kind => !check.evidence_ids.some(ref => docs.get(ref).kind === kind))) fail('PASS_WITHOUT_REQUIRED_EVIDENCE');
    for (const observation of check.observations) {
      if (!exact(observation, ['document_id', 'quote', 'explanation']) || !check.evidence_ids.includes(observation.document_id) || !text(observation.quote, 400) || observation.quote.trim().length < 12 || !text(observation.explanation) || observation.explanation.trim() === criterion.requirement.trim()) fail('INVALID_AUDIT_OBSERVATION');
      const doc = docs.get(observation.document_id);
      let runtimeOutput = '';
      if (doc.kind === 'runtime') { try { runtimeOutput = JSON.parse(doc.content).output ?? ''; } catch {} }
      if (!doc.content.includes(observation.quote) && !runtimeOutput.includes(observation.quote)) fail('INVALID_OBSERVATION_QUOTE');
    }
    if (check.status === 'PASS' && (check.reason.trim() === criterion.requirement.trim() || criterion.evidenceKinds.some(kind => !check.observations.some(o => docs.get(o.document_id).kind === kind)))) fail('PASS_WITHOUT_OBSERVED_EVIDENCE');
    seen.add(check.criterion_id);
  }
  if (seen.size !== criteria.size) fail('INCOMPLETE_CRITERIA_COVERAGE');
  const derived = result.findings.some(f => f.severity === 'ERROR') || result.checks.some(c => c.status === 'FAIL') ? 'FAIL' : result.findings.length || result.checks.some(c => c.status === 'CHUA_XAC_MINH') ? 'CHUA_XAC_MINH' : 'PASS';
  if (result.status !== derived || (derived !== 'PASS' && !result.findings.length)) fail('CONTRADICTORY_AUDIT_STATUS');
  for (const item of [...result.findings, ...result.root_causes, ...result.checks]) if (item.evidence_ids.some(ref => !result.evidence.includes(ref))) fail('UNCITED_RESULT_EVIDENCE');
  return structuredClone(result);
}
module.exports = { STATUSES, KINDS, RESULT_SCHEMA, sha256, canonical, validatePacket, validateResult };
