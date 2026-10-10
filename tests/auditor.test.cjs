'use strict';
// Protocol tests use explicit reviewer stubs to exercise rejection paths.
// None of these fixtures constitutes real JEV review or trading acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePacket, validateResult, sha256, canonical, KINDS, RESULT_SCHEMA } = require('../services/jev/auditor/contract.cjs');
const { JevAuditor } = require('../services/jev/auditor/service.cjs');
const { OllamaReviewer, schemaFor, renderPacket } = require('../services/jev/auditor/ollama.cjs');
const { assertNoSecrets } = require('../services/jev/auditor/secrets.cjs');
const { buildRegistry } = require('../services/jev/auditor/evidence-registry.cjs');
const { evaluateReview } = require('../services/jev/auditor/evaluation.cjs');
const { criterionView, renderView } = require('../services/jev/auditor/views.cjs');
const { buildAttributionInput, attributionSchema, attributionParts, attributionPartSchema, assembleAttribution } = require('../services/jev/auditor/attribution.cjs');
const { readbackSchema, runtimeExplanation } = require('../services/jev/auditor/readback.cjs');
const catalogue = (...args) => require('../services/jev/auditor/anchors.cjs').catalogue(...args);

function packet() {
  return {
    scope: 'auditor-protocol-only',
    criteria: [{ id: 'scope-evidence', requirement: 'Every supplied evidence kind must be inspected for this bounded protocol scope.', evidenceKinds: [...KINDS] }],
    documents: KINDS.map(kind => {
      const content = `Explicit protocol fixture: ${kind}; no runtime acceptance claim.`;
      return { id: kind, kind, file: `tests/protocol/${kind}.txt`, content, sha256: sha256(content) };
    })
  };
}
function pass(p) {
  const refs = p.documents.map(d => d.id);
  return { status: 'PASS', scope: p.scope, findings: [], root_causes: [], evidence: refs, required_fixes: [], affected_files: [], checks: p.criteria.map(c => ({ criterion_id: c.id, status: 'PASS', reason: 'Protocol fixture response only.', evidence_ids: refs, observations: p.documents.map(d => ({ document_id: d.id, quote: d.content.slice(0, 80), explanation: `The supplied ${d.kind} fragment anchors this protocol observation; it is not real module acceptance.` })) })) };
}
function failure(p, status = 'FAIL') {
  const result = pass(p), file = p.documents[0].file;
  result.status = status;
  result.findings = [{ id: 'f1', severity: status === 'FAIL' ? 'ERROR' : 'UNKNOWN', file, message: 'Required caller evidence contradicts the asserted contract.', evidence_ids: ['source'] }];
  result.root_causes = [{ finding_id: 'f1', explanation: 'Caller skips the required validation boundary.', evidence_ids: ['source'] }];
  result.required_fixes = [{ finding_id: 'f1', action: 'Validate at the caller and capture a fresh runtime receipt.', files: [file] }];
  result.affected_files = [file];
  result.checks[0].status = status;
  return result;
}
function support(p) {
  const registry = buildRegistry(p);
  return { criteria: Object.fromEntries(p.criteria.map(c => [c.id, {
    assessment: 'SUPPORTS', reason: 'Protocol fixture analysis only; this does not establish runtime acceptance.',
    observations: Object.fromEntries(c.evidenceKinds.map(kind => [kind, [{ evidence_id: registry.entries.find(e => e.kind === kind).id, explanation: `The supplied ${kind} fragment is the selected protocol evidence.` }]])),
    findings: [], missing_evidence: []
  }])) };
}
function grounded(p, analysis) {
  const raw = structuredClone(analysis), entries = new Map(buildRegistry(p).entries.map(entry => [entry.id, entry]));
  for (const review of Object.values(raw.criteria)) for (const observation of review.observations.runtime ?? []) {
    observation.explanation = runtimeExplanation(entries.get(observation.evidence_id));
  }
  return raw;
}
function wire(p, analysis) {
  const raw = grounded(p, analysis), quotes = new Map(buildRegistry(p).entries.map(entry => [entry.id, entry.quote]));
  for (const review of Object.values(raw.criteria)) for (const list of Object.values(review.observations)) {
    for (const observation of list) observation.quote = quotes.get(observation.evidence_id);
  }
  return raw;
}
function contradict(p, unknown = false) {
  const raw = support(p), review = raw.criteria[p.criteria[0].id];
  review.assessment = unknown ? 'UNKNOWN' : 'CONTRADICTS';
  review.findings = [{ severity: unknown ? 'UNKNOWN' : 'ERROR', file: p.documents[0].file,
    message: 'Required caller evidence contradicts the asserted contract.', root_cause: 'Caller skips the required validation boundary.',
    required_fix: 'Validate at the caller and capture a fresh runtime receipt.', evidence_ids: [buildRegistry(p).entries.find(e => e.kind === 'source').id] }];
  return raw;
}
function reviewer(makeAnalysis, provider = 'ollama-local') {
  return { model: 'qwen3:14b', calls: 0, async review(p) { this.calls++; return { analysis: makeAnalysis(p), provenance: { provider, model: this.model, protocol: 'evidence-first/2' } }; } };
}
function criterion(raw, p = packet()) { return raw.criteria[p.criteria[0].id]; }
function attributionSupport(input) {
  return { input_hash: input.input_hash, relation: 'SUPPORTED', reason: 'Explicit isolated attribution protocol fixture, not real model acceptance.' };
}


test('packet requires exact contract, nonempty unique criteria and valid evidence digests', () => {
  const p = packet();
  assert.equal(validatePacket(p), p);
  const extra = structuredClone(p); extra.claimedStatus = 'PASS';
  assert.throws(() => validatePacket(extra), /INVALID_AUDIT_PACKET/);
  const empty = structuredClone(p); empty.criteria = [];
  assert.throws(() => validatePacket(empty), /INVALID_AUDIT_CRITERIA/);
  const duplicate = structuredClone(p); duplicate.criteria.push(duplicate.criteria[0]);
  assert.throws(() => validatePacket(duplicate), /DUPLICATE_CRITERION/);
  const altered = structuredClone(p); altered.documents[0].content += ' altered';
  assert.throws(() => validatePacket(altered), /INVALID_EVIDENCE_DOCUMENT/);
});

test('missing runtime evidence returns unknown without invoking any reviewer', async () => {
  const p = packet(); p.documents = p.documents.filter(d => d.kind !== 'runtime');
  const first = reviewer(support), second = reviewer(support);
  const result = await new JevAuditor({ reviewer: first, escalationReviewer: second }).audit(p);
  assert.equal(result.status, 'CHUA_XAC_MINH');
  assert.match(result.findings[0].message, /MISSING_EVIDENCE_KINDS:runtime/);
  assert.equal(first.calls + second.calls, 0);
});

test('blank evidence is missing, even if its hash is valid', async () => {
  const p = packet(); p.documents[3].content = ' '; p.documents[3].sha256 = sha256(' ');
  const first = reviewer(support);
  const result = await new JevAuditor({ reviewer: first, escalationReviewer: null }).audit(p);
  assert.equal(result.status, 'CHUA_XAC_MINH'); assert.equal(first.calls, 0);
});

test('classifier-shaped response cannot stand in for structured source review', async () => {
  const first = reviewer(() => ({ choice: 'PASS', confidence: 0.99 }));
  const result = await new JevAuditor({ reviewer: first, escalationReviewer: null }).audit(packet());
  assert.equal(result.status, 'CHUA_XAC_MINH');
});

test('classifier provenance cannot masquerade as reviewer even with a valid result shape', async () => {
  const first = reviewer(support, 'typesafe-classifier');
  const result = await new JevAuditor({ reviewer: first, escalationReviewer: null }).audit(packet());
  assert.equal(result.status, 'CHUA_XAC_MINH');
});

test('unknown document, affected file, criterion or omitted criterion is rejected', () => {
  const p = packet();
  for (const mutate of [
    r => { r.checks[0].evidence_ids.push('invented'); },
    r => { r.affected_files.push('outside-scope.cjs'); },
    r => { r.checks[0].criterion_id = 'invented'; },
    r => { r.checks = []; }
  ]) { const r = pass(p); mutate(r); assert.throws(() => validateResult(r, p)); }
});

test('PASS requires every evidence kind specified by the criterion', () => {
  const p = packet(), r = pass(p);
  r.checks[0].evidence_ids = ['source'];
  r.checks[0].observations = r.checks[0].observations.filter(o => o.document_id === 'source');
  assert.throws(() => validateResult(r, p), /PASS_WITHOUT_REQUIRED_EVIDENCE/);
});

test('a PASS label cannot override an ERROR finding or failed check', () => {
  const p = packet(), r = failure(p); r.status = 'PASS';
  assert.throws(() => validateResult(r, p), /CONTRADICTORY_AUDIT_STATUS/);
});

test('a finding must retain its actionable root cause and required fix', () => {
  const p = packet();
  for (const key of ['root_causes', 'required_fixes']) {
    const r = failure(p); r[key] = [];
    assert.throws(() => validateResult(r, p), /FINDING_WITHOUT_ACTIONABLE_CAUSE/);
  }
});

test('valid FAIL is final and never sent to a second reviewer to seek PASS', async () => {
  const first = reviewer(p => contradict(p)), second = reviewer(support), p = packet();
  const result = await new JevAuditor({ reviewer: first, escalationReviewer: second }).audit(p);
  assert.equal(result.status, 'FAIL'); assert.equal(first.calls, 1); assert.equal(second.calls, 0);
  assert.deepEqual(result.required_fixes[0], evaluateReview(p, contradict(p)).result.required_fixes[0]);
  assert.equal(result.packetHash, sha256(canonical(p)));
});

test('valid unknown verdict is final, not retried to manufacture PASS', async () => {
  const first = reviewer(p => contradict(p, true)), second = reviewer(support);
  const result = await new JevAuditor({ reviewer: first, escalationReviewer: second }).audit(packet());
  assert.equal(result.status, 'CHUA_XAC_MINH'); assert.equal(second.calls, 0);
});

test('malformed result shape escalates exactly once and preserves a genuine second FAIL', async () => {
  const first = reviewer(() => ({ status: 'PASS' })), second = reviewer(p => contradict(p));
  const result = await new JevAuditor({ reviewer: first, escalationReviewer: second }).audit(packet());
  assert.equal(result.status, 'FAIL'); assert.equal(first.calls, 1); assert.equal(second.calls, 1);
  assert.equal(result.source.attempts.length, 2);
});

test('two malformed results stop with unknown after two attempts', async () => {
  const first = reviewer(() => ({})), second = reviewer(() => ({}));
  const result = await new JevAuditor({ reviewer: first, escalationReviewer: second }).audit(packet());
  assert.equal(result.status, 'CHUA_XAC_MINH'); assert.equal(first.calls, 1); assert.equal(second.calls, 1);
});

test('malformed Ollama JSON output escalates once instead of becoming a transport failure', async () => {
  const first = new OllamaReviewer({ model: 'qwen3:8b', fetcher: async () => new Response(JSON.stringify({ done: true, done_reason: 'stop', model: 'qwen3:8b', message: { role: 'assistant', content: '{ not JSON' } })) });
  const second = reviewer(p => contradict(p));
  const result = await new JevAuditor({ reviewer: first, escalationReviewer: second }).audit(packet());
  assert.equal(second.calls, 1); assert.equal(result.status, 'FAIL');
});

test('provider outage does not escalate and raw error text cannot leak into result', async () => {
  const first = { async review() { throw Error('network failed with sensitive upstream diagnostic'); } }, second = reviewer(support);
  const result = await new JevAuditor({ reviewer: first, escalationReviewer: second }).audit(packet());
  assert.equal(result.status, 'CHUA_XAC_MINH'); assert.equal(second.calls, 0);
  assert.doesNotMatch(JSON.stringify(result), /sensitive upstream diagnostic/);
});

test('reviewer cannot mutate evidence or criteria behind the original packet hash', async () => {
  const p = packet(), original = canonical(p);
  const first = reviewer(received => {
    received.documents[0].content = 'replacement source';
    received.documents[0].sha256 = sha256('replacement source');
    received.criteria[0].requirement = 'Different requirement';
    return support(received);
  });
  const result = await new JevAuditor({ reviewer: first, escalationReviewer: null }).audit(p);
  assert.equal(canonical(p), original, 'caller evidence must also remain unchanged');
  assert.notEqual(result.status, 'PASS', 'changed evidence cannot retain acceptance under the original hash');
});

test('private credential files are denied before review', () => {
  for (const file of ['.env', 'config/.env.production', 'config/auth.json', 'credentials.json', 'wallet/session.dpapi', 'data/private.sqlite']) {
    const p = packet(); p.documents[0].file = file;
    assert.throws(() => validatePacket(p), /PRIVATE_FILE_DENIED/, file);
  }
});

test('literal secrets are denied while identifier-only source can be inspected', () => {
  for (const content of ['apiKey = "abcdefghijklmnopqrstuvwxyz123456"', 'const privateKey = "abcdefghijklmnopqrstuvwxyz123456"', '-----BEGIN PRIVATE KEY-----\nabc']) {
    const p = packet(); Object.assign(p.documents[0], { content, sha256: sha256(content) });
    assert.throws(() => validatePacket(p), /SECRET_LITERAL_DENIED/);
  }
  const p = packet(), content = 'function validatePrivateKeyName(input) { return input === "privateKey"; }';
  Object.assign(p.documents[0], { content, sha256: sha256(content) });
  assert.doesNotThrow(() => validatePacket(p));
});

test('unquoted credential formats are rejected in every packet text field', () => {
  // Artificial strings exercise credential-shaped input; no real credential is used.
  const formats = ['Authorization: Bearer ' + 'x'.repeat(32), 'api_key=' + 'x'.repeat(32)];
  for (const secret of formats) for (const location of ['content', 'scope', 'requirement', 'file']) {
    const p = packet();
    if (location === 'content') { p.documents[0].content = secret; p.documents[0].sha256 = sha256(secret); }
    else if (location === 'scope') p.scope = secret;
    else if (location === 'requirement') p.criteria[0].requirement = secret;
    else p.documents[0].file = secret;
    assert.throws(() => validatePacket(p), /SECRET_LITERAL_DENIED/, `Credential shape leaked through packet ${location}`);
  }
});

test('unquoted credential formats are rejected in reviewer findings, causes, fixes and reasons', () => {
  const p = packet();
  for (const secret of ['Authorization: Bearer ' + 'x'.repeat(32), 'api_key=' + 'x'.repeat(32)]) {
    for (const location of ['message', 'explanation', 'action', 'reason']) {
      const r = failure(p);
      if (location === 'message') r.findings[0].message = secret;
      if (location === 'explanation') r.root_causes[0].explanation = secret;
      if (location === 'action') r.required_fixes[0].action = secret;
      if (location === 'reason') r.checks[0].reason = secret;
      assert.throws(() => validateResult(r, p), /SECRET_LITERAL_DENIED/, `Credential shape leaked through reviewer ${location}`);
    }
  }
});

test('credential rejection returns sanitized unknown without copying model secret text', async () => {
  const secret = 'Authorization: Bearer ' + 'x'.repeat(32);
  const first = reviewer(p => { const r = contradict(p); criterion(r, p).findings[0].message = secret; return r; });
  const result = await new JevAuditor({ reviewer: first, escalationReviewer: null }).audit(packet());
  assert.equal(result.status, 'CHUA_XAC_MINH');
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('every produced service outcome carries a unique receipt_id matching its immutable id', async () => {
  const p = packet(), missing = packet(); missing.documents = missing.documents.filter(d => d.kind !== 'runtime');
  const outage = { model: 'qwen3:8b', async review() { throw Error('REVIEW_PROVIDER_HTTP_503'); } };
  const cases = [
    { input: p, first: reviewer(support), expected: 'CHUA_XAC_MINH' },
    { input: p, first: reviewer(r => contradict(r)), expected: 'FAIL' },
    { input: p, first: reviewer(r => contradict(r, true)), expected: 'CHUA_XAC_MINH' },
    { input: missing, first: reviewer(support), expected: 'CHUA_XAC_MINH' },
    { input: p, first: reviewer(() => ({})), expected: 'CHUA_XAC_MINH' },
    { input: p, first: outage, expected: 'CHUA_XAC_MINH' },
    { input: p, first: reviewer(() => ({})), second: reviewer(r => contradict(r)), expected: 'FAIL' }
  ];
  const receipts = new Set();
  for (const item of cases) {
    const result = await new JevAuditor({ reviewer: item.first, escalationReviewer: item.second ?? null }).audit(item.input);
    assert.equal(result.status, item.expected);
    assert.match(result.receipt_id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.equal(result.receipt_id, result.id);
    assert.ok(!receipts.has(result.receipt_id), 'Each distinct audit receives a distinct receipt identity');
    receipts.add(result.receipt_id);
  }
});

test('invalid or credential-bearing audit input returns structured unknown with receipt identity', async () => {
  const badHash = packet(); badHash.documents[0].sha256 = '0'.repeat(64);
  const secretText = 'Authorization: Bearer ' + 'x'.repeat(32), secretPacket = packet();
  secretPacket.scope = secretText;
  for (const input of [null, {}, badHash, secretPacket]) {
    const first = reviewer(support);
    const result = await new JevAuditor({ reviewer: first, escalationReviewer: null }).audit(input);
    assert.equal(result.status, 'CHUA_XAC_MINH');
    assert.equal(first.calls, 0, 'Invalid inputs must not reach the reviewer');
    assert.equal(result.receipt_id, result.id);
    assert.match(result.receipt_id, /^[a-f0-9-]{36}$/);
    assert.equal(typeof result.scope, 'string');
    for (const key of ['findings', 'root_causes', 'evidence', 'required_fixes', 'affected_files']) assert.ok(Array.isArray(result[key]), key);
    assert.ok(!JSON.stringify(result).includes(secretText), 'Rejected input must not leak into error scope or finding');
  }
});

test('dynamic schema binds scope, file, criteria and evidence to independent enum domains', () => {
  const input = packet(), before = canonical(RESULT_SCHEMA), schema = schemaFor(input), p = schema.properties;
  assert.deepEqual(Object.keys(p), ['criteria'], 'No model-controlled authority, hash, receipt or status fields');
  assert.deepEqual(p.criteria.required, input.criteria.map(c => c.id));
  const c = p.criteria.properties[input.criteria[0].id], registry = buildRegistry(input);
  assert.deepEqual(c.properties.findings.items.properties.file.enum, input.documents.map(d => d.file));
  assert.deepEqual(c.properties.findings.items.properties.evidence_ids.items.enum, registry.entries.map(e => e.id));
  assert.deepEqual(c.properties.observations.required, input.criteria[0].evidenceKinds);
  for (const kind of input.criteria[0].evidenceKinds) {
    const observation = c.properties.observations.properties[kind].items;
    assert.deepEqual(observation.properties.evidence_id.enum, registry.entries.filter(e => e.kind === kind).map(e => e.id));
    assert.equal(Object.hasOwn(observation.properties.explanation, 'enum'), false);
  }
  assert.deepEqual(c.properties.assessment.enum, ['SUPPORTS', 'CONTRADICTS', 'UNKNOWN']);
  assert.equal(Object.hasOwn(c.properties.reason, 'enum'), false);
  assert.equal(canonical(RESULT_SCHEMA), before, 'Public validator schema remains unchanged');
});


test('dynamic schema calls and individual field mutations cannot contaminate other fields or template', () => {
  const template = canonical(RESULT_SCHEMA), firstPacket = packet(), secondPacket = packet();
  secondPacket.scope = 'different-audit-scope'; secondPacket.criteria[0].id = 'different-criterion';
  secondPacket.documents[0].id = 'different-source-id'; secondPacket.documents[0].file = 'different-source.cjs';
  const first = schemaFor(firstPacket), snapshot = canonical(first), second = schemaFor(secondPacket);
  const secondCriterion = second.properties.criteria.properties['different-criterion'];
  assert.deepEqual(second.properties.criteria.required, ['different-criterion']);
  assert.ok(secondCriterion.properties.findings.items.properties.file.enum.includes('different-source.cjs'));
  const registry = buildRegistry(secondPacket);
  assert.deepEqual(secondCriterion.properties.observations.properties.source.items.properties.evidence_id.enum, registry.entries.filter(e => e.kind === 'source').map(e => e.id));
  assert.equal(canonical(first), snapshot);
  secondCriterion.properties.observations.properties.source.items.properties.evidence_id.enum.push('mutation');
  assert.ok(!secondCriterion.properties.findings.items.properties.evidence_ids.items.enum.includes('mutation'));
  assert.ok(!secondCriterion.properties.observations.properties.runtime.items.properties.evidence_id.enum.includes('mutation'));
  assert.equal(Object.hasOwn(secondCriterion.properties.reason, 'enum'), false);
  assert.equal(canonical(RESULT_SCHEMA), template);
  assert.equal(canonical(first), snapshot);
});


test('secret-free rejected model output is retained for diagnosis without becoming acceptance', async () => {
  const malformed = support(packet()); malformed.scope = 'wrong-scope';
  const first = reviewer(() => malformed);
  const result = await new JevAuditor({ reviewer: first, escalationReviewer: null }).audit(packet());
  assert.equal(result.status, 'CHUA_XAC_MINH');
  assert.deepEqual(result.source.attempts[0].rejected_review, malformed);
  malformed.scope = 'mutated-after-response';
  assert.equal(result.source.attempts[0].rejected_review.scope, 'wrong-scope');
});

test('secret-bearing rejected model output is omitted entirely from diagnostic attempts', async () => {
  const secret = 'api_key=' + 'x'.repeat(32);
  const first = reviewer(p => { const result = contradict(p); criterion(result, p).findings[0].message = secret; return result; });
  const result = await new JevAuditor({ reviewer: first, escalationReviewer: null }).audit(packet());
  assert.equal(result.status, 'CHUA_XAC_MINH');
  assert.equal(Object.hasOwn(result.source.attempts[0], 'rejected_review'), false);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('PASS observations must independently cover every required evidence kind', () => {
  const p = packet(), r = pass(p);
  assert.doesNotThrow(() => validateResult(r, p));
  r.checks[0].observations = r.checks[0].observations.filter(o => o.document_id !== 'runtime');
  assert.throws(() => validateResult(r, p), 'Citing runtime alone without inspecting an exact fragment is insufficient');
});

test('observation requires a real cited document and a quote from that exact document', () => {
  const p = packet();
  for (const modify of [
    r => { r.checks[0].observations[0].document_id = 'invented-document'; },
    r => { r.checks[0].observations[0].quote = p.documents[1].content; },
    r => { r.checks[0].evidence_ids = r.checks[0].evidence_ids.filter(id => id !== 'source'); },
    r => { r.checks[0].observations[0].quote = 'A fabricated source observation that occurs nowhere.'; }
  ]) { const r = pass(p); modify(r); assert.throws(() => validateResult(r, p)); }
});

test('verified quote lengths are bounded inclusively at 12 and 400 characters', () => {
  const p = packet(); p.documents[0].content = 'A'.repeat(402); p.documents[0].sha256 = sha256(p.documents[0].content);
  for (const length of [12, 400]) {
    const r = pass(p); r.checks[0].observations[0].quote = 'A'.repeat(length);
    assert.doesNotThrow(() => validateResult(r, p), `Length ${length} is allowed by contract`);
  }
  for (const length of [11, 401]) {
    const r = pass(p); r.checks[0].observations[0].quote = 'A'.repeat(length);
    assert.throws(() => validateResult(r, p), `Length ${length} must be rejected`);
  }
});

test('reason and observation explanation cannot merely repeat the criterion requirement', () => {
  const p = packet();
  for (const field of ['reason', 'explanation']) {
    const r = pass(p);
    if (field === 'reason') r.checks[0].reason = p.criteria[0].requirement;
    else r.checks[0].observations[0].explanation = p.criteria[0].requirement;
    assert.throws(() => validateResult(r, p), `${field} must contain evidence interpretation, not copied instructions`);
  }
});

test('runtime observations can quote decoded output without accepting invented output', () => {
  const p = packet(), runtime = p.documents.find(d => d.kind === 'runtime');
  const output = 'Receipt validation passed\nReplay state matched the recorded digest.';
  runtime.content = JSON.stringify({ output, exitCode: 0 }); runtime.sha256 = sha256(runtime.content);
  const r = pass(p), observation = r.checks[0].observations.find(o => o.document_id === 'runtime');
  observation.quote = output;
  assert.doesNotThrow(() => validateResult(r, p));
  observation.quote = 'Receipt validation passed\nReplay fabricated a different result.';
  assert.throws(() => validateResult(r, p));
});

test('observation fields are mandatory schema members with independent reference domains', () => {
  const p = packet(), schema = schemaFor(p).properties.criteria.properties[p.criteria[0].id];
  assert.ok(schema.required.includes('observations'));
  assert.deepEqual(schema.properties.observations.required, KINDS);
  for (const kind of KINDS) {
    const observation = schema.properties.observations.properties[kind].items;
    assert.deepEqual(observation.required, ['evidence_id', 'explanation']);
    assert.equal(Object.hasOwn(observation.properties, 'quote'), false);
    assert.equal(Object.hasOwn(observation.properties, 'document_id'), false);
    assert.equal(Object.hasOwn(observation.properties.explanation, 'enum'), false);
  }
  assert.equal(RESULT_SCHEMA.properties.checks.items.properties.observations.items.properties.quote.type, 'string');
});


test('reviewer requests model reasoning but does not return its private thought text', async () => {
  const p = packet(), thought = 'Private protocol sentinel thought text', sent = [];
  const r = new OllamaReviewer({ fetcher: async (url, init) => {
    const request = JSON.parse(init.body); sent.push(request);
    const raw = request.format.properties.criteria ? wire(p, support(p)) : attributionSupport(JSON.parse(request.messages[1].content));
    return new Response(JSON.stringify({ done: true, done_reason: 'stop', model: 'qwen3:14b', message: { role: 'assistant', thinking: thought, content: JSON.stringify(raw) } }));
  } });
  const response = await r.review(p);
  assert.equal(sent.length, KINDS.length + 2);
  assert.ok(sent.every(request => request.think === true && request.model === 'qwen3:14b'));
  assert.equal(response.provenance.protocol, 'evidence-first/2');
  assert.ok(!JSON.stringify(response).includes(thought));
  assert.deepEqual(response.analysis, grounded(p, support(p)));
  assert.equal(Object.hasOwn(response, 'result'), false, 'Model transport returns analysis without acceptance');
  assert.deepEqual(response.provenance.calls.map(call => call.phase), ['analysis', 'attribution']);
  assert.equal(response.provenance.attributions.length, 1);
});


test('wire review deterministically derives only actual references without changing model claims', () => {
  const p = packet(), raw = support(p), before = structuredClone(raw), evaluated = evaluateReview(p, raw);
  const registry = buildRegistry(p), selected = Object.values(criterion(raw).observations).flat().map(o => o.evidence_id);
  assert.deepEqual(raw, before, 'Evaluation cannot mutate the model analysis');
  assert.deepEqual(evaluated.evidence_ids, selected);
  for (const observation of evaluated.result.checks[0].observations) {
    assert.ok(registry.entries.some(e => selected.includes(e.id) && e.document_id === observation.document_id && e.quote === observation.quote));
  }
  assert.equal(evaluated.result.checks[0].reason, criterion(raw).reason);
});


test('wire review rejects extra, missing or contradictory redundant fields', () => {
  const p = packet();
  for (const modify of [
    r => { r.status = 'PASS'; }, r => { r.scope = p.scope; }, r => { r.receipt_id = 'invented'; },
    r => { r.source_hash = 'a'.repeat(64); }, r => { r.evidence_ids = []; },
    r => { r.unknownField = true; }, r => { delete r.criteria; },
    r => { delete criterion(r).observations; }, r => { criterion(r).status = 'PASS'; }
  ]) { const raw = support(p); modify(raw); assert.throws(() => evaluateReview(p, raw)); }
});


test('wire reference derivation never repairs invented, missing or concatenated quotes', () => {
  const p = packet();
  for (const modify of [
    r => { criterion(r).observations.source[0].evidence_id = 'invented'; },
    r => { criterion(r).observations.source[0].quote = 'Not a substring of supplied evidence'; },
    r => { criterion(r).observations.source[0].evidence_id += criterion(r).observations.runtime[0].evidence_id; },
    r => { delete criterion(r).observations.source[0].evidence_id; },
    r => { delete criterion(r).observations.runtime; }
  ]) {
    const raw = support(p); modify(raw); const before = structuredClone(raw);
    assert.throws(() => evaluateReview(p, raw)); assert.deepEqual(raw, before);
  }
});


test('wire contradictory analysis retains actionable findings and citations', () => {
  const p = packet(), raw = contradict(p), f = criterion(raw).findings[0], result = evaluateReview(p, raw).result;
  assert.equal(result.status, 'FAIL'); assert.equal(result.findings[0].message, f.message);
  assert.equal(result.root_causes[0].explanation, f.root_cause); assert.equal(result.required_fixes[0].action, f.required_fix);
  assert.deepEqual(result.findings[0].evidence_ids, ['source']);
  assert.equal(result.checks[0].reason, criterion(raw).reason);
});


test('wire contradictory analysis without observations preserves its own explicit finding evidence', () => {
  const p = packet(), raw = contradict(p);
  for (const kind of KINDS) criterion(raw).observations[kind] = [];
  const evaluated = evaluateReview(p, raw);
  assert.equal(evaluated.result.status, 'FAIL');
  assert.deepEqual(evaluated.result.findings[0].evidence_ids, ['source']);
  assert.deepEqual(evaluated.evidence_ids, criterion(raw).findings[0].evidence_ids);
  for (const kind of KINDS) assert.ok(evaluated.missing_evidence.includes('scope-evidence:' + kind));
});


test('wire derivation never assigns unrelated finding citations to an unsupported check', () => {
  const p = packet();
  p.criteria.push({ id: 'second-scope', requirement: 'A separate criterion needs independently selected evidence.', evidenceKinds: ['source'] });
  const raw = support(p);
  raw.criteria['second-scope'] = contradict(p).criteria['scope-evidence'];
  raw.criteria['second-scope'].observations = { source: raw.criteria['second-scope'].observations.source };
  criterion(raw).observations.source = [];
  const evaluated = evaluateReview(p, raw);
  assert.equal(evaluated.result.checks[0].status, 'CHUA_XAC_MINH');
  assert.ok(evaluated.missing_evidence.includes('scope-evidence:source'));
});


test('wire SUPPORTS cannot replace host binding or registered proof obligations', async () => {
  const p = packet(), first = reviewer(support), result = await new JevAuditor({ reviewer: first, escalationReviewer: null }).audit(p);
  assert.equal(result.status, 'CHUA_XAC_MINH');
  assert.ok(result.missing_evidence.includes('HOST_BINDING_REQUIRED'));
  assert.ok(result.missing_evidence.includes('UNREGISTERED_CRITERION_POLICY'));
  assert.equal(result.authority, 'deterministic-acceptance/2');
  assert.equal(first.calls, 1);
});


test('wire selections reject duplicate observations and deduplicate finding references', () => {
  const p = packet(), raw = support(p);
  criterion(raw).observations.source.push(structuredClone(criterion(raw).observations.source[0]));
  assert.throws(() => evaluateReview(p, raw), /INVALID_AUDIT_OBSERVATION/, 'Duplicate selections cannot inflate support');
  const distinct = contradict(p), id = criterion(distinct).findings[0].evidence_ids[0];
  criterion(distinct).findings[0].evidence_ids.push(id);
  const evaluated = evaluateReview(p, distinct);
  assert.equal(evaluated.evidence_ids.length, new Set(evaluated.evidence_ids).size);
  assert.deepEqual(evaluated.result.findings[0].evidence_ids, ['source']);
});


test('legitimate no-observation FAIL from provider wire remains final without escalation', async () => {
  const p = packet(), raw = contradict(p);
  for (const kind of KINDS) criterion(raw).observations[kind] = [];
  const first = new OllamaReviewer({ fetcher: async () => new Response(JSON.stringify({ done: true, done_reason: 'stop', model: 'qwen3:14b', message: { role: 'assistant', content: JSON.stringify(raw) } })) });
  const second = reviewer(support), result = await new JevAuditor({ reviewer: first, escalationReviewer: second }).audit(p);
  assert.equal(result.status, 'FAIL'); assert.equal(second.calls, 0);
  assert.equal(result.findings[0].message, criterion(raw).findings[0].message);
  assert.deepEqual(result.checks, evaluateReview(p, raw).result.checks);
});


test('structured credential fields are screened as key-value pairs at every nesting level', () => {
  const dummy = 'x'.repeat(64);
  for (const key of ['authorization', 'apiKey', 'api_key', 'privateKey', 'private_key', 'seedPhrase', 'seed_phrase', 'recoveryPhrase', 'recovery_phrase', 'signingSecret', 'signing_secret', 'accessToken', 'access_token', 'refreshToken', 'refresh_token']) {
    for (const value of ['x', dummy]) {
      assert.throws(() => assertNoSecrets({ [key]: value }), /SECRET_LITERAL_DENIED/, key);
      assert.throws(() => assertNoSecrets({ metadata: [{ diagnostic: { [key]: value } }] }), /SECRET_LITERAL_DENIED/, `nested ${key}`);
    }
  }
  assert.doesNotThrow(() => assertNoSecrets({ source: "const fieldName = 'private_key'; function check(input) { return input[fieldName]; }" }));
  assert.doesNotThrow(() => assertNoSecrets({ fieldName: 'private_key' }), 'A source field name alone is not credential material');
});

test('extra credential object in a rejected reviewer result is never retained as diagnosis', async () => {
  const dummy = 'x'.repeat(64), first = reviewer(p => ({ ...support(p), diagnostic: { private_key: dummy } }));
  const result = await new JevAuditor({ reviewer: first, escalationReviewer: null }).audit(packet());
  assert.equal(result.status, 'CHUA_XAC_MINH');
  assert.equal(Object.hasOwn(result.source.attempts[0], 'rejected_review'), false);
  assert.ok(!JSON.stringify(result).includes(dummy));
});

test('credential pairs in malformed provider wire never leak through rejectedReview error metadata', async () => {
  const p = packet(), dummy = 'x'.repeat(64), raw = support(p);
  raw.diagnostic = { nested: [{ private_key: dummy }] };
  const first = new OllamaReviewer({ fetcher: async () => new Response(JSON.stringify({ done: true, done_reason: 'stop', model: 'qwen3:14b', message: { role: 'assistant', content: JSON.stringify(raw) } })) });
  const result = await new JevAuditor({ reviewer: first, escalationReviewer: null }).audit(p);
  assert.equal(result.status, 'CHUA_XAC_MINH');
  assert.equal(Object.hasOwn(result.source.attempts[0], 'rejected_review'), false);
  assert.ok(!JSON.stringify(result).includes(dummy));
});

test('anchor catalogue quotes originate exactly in their own source or decoded runtime evidence', () => {
  const p = packet(), source = p.documents[0], runtime = p.documents.find(d => d.kind === 'runtime');
  source.content = "const mode = 'paper';\nif (safe && fresh) return intent;\n" + 'x'.repeat(805);
  source.sha256 = sha256(source.content);
  const output = 'Receipt says "paper only"\nAll runtime guards were inspected.';
  runtime.content = JSON.stringify({ output }); runtime.sha256 = sha256(runtime.content);
  const anchors = catalogue(p), second = catalogue(p);
  assert.deepEqual([...anchors].map(([id, entries]) => [id, [...entries]]), [...second].map(([id, entries]) => [id, [...entries]]), 'Identical evidence has deterministic anchor identities');
  for (const doc of p.documents) {
    const entries = anchors.get(doc.id);
    assert.ok(entries instanceof Map);
    for (const [id, quote] of entries) {
      assert.equal(typeof id, 'string'); assert.ok(id.length > 0);
      assert.ok(quote.length >= 12 && quote.length <= 400);
      assert.ok(doc.content.includes(quote) || doc.kind === 'runtime' && output.includes(quote), `${id} must name a real contiguous fragment of its own document`);
    }
  }
  assert.ok([...anchors.get(source.id).values()].some(quote => quote.includes('if (safe && fresh) return intent;')), 'The conjunct must not disappear in evidence encoding');
  assert.ok([...anchors.get(runtime.id).values()].some(quote => quote === 'Receipt says "paper only"'), 'Decoded runtime lines remain quotable without JSON escape transcription');
});

test('wire registry rejects unknown malformed and bracketed IDs without fuzzy repair', () => {
  const p = packet();
  for (const id of ['anchor-that-does-not-exist', '999999999999999', '[' + buildRegistry(p).entries[0].id + ']', buildRegistry(p).entries[0].id.toLowerCase()]) {
    const raw = support(p); criterion(raw).observations.source[0].evidence_id = id;
    const before = structuredClone(raw); assert.throws(() => evaluateReview(p, raw), /INVALID_EVIDENCE_SELECTION/); assert.deepEqual(raw, before);
  }
});


test('wire registry rejects evidence from another scope or required kind', () => {
  const p = packet(), foreign = packet(); foreign.scope = 'foreign-scope';
  const foreignId = buildRegistry(foreign).entries.find(e => e.kind === 'source').id;
  const raw = support(p); criterion(raw).observations.source[0].evidence_id = foreignId;
  assert.throws(() => evaluateReview(p, raw), /INVALID_EVIDENCE_SELECTION/);
  criterion(raw).observations.source[0].evidence_id = buildRegistry(p).entries.find(e => e.kind === 'runtime').id;
  assert.throws(() => evaluateReview(p, raw), /INVALID_EVIDENCE_SELECTION/);
});


test('rendered anchor expansion is bounded before any provider request', async () => {
  const p = packet(), source = p.documents[0];
  source.content = 'abcdefghijkl\n'.repeat(3400); source.sha256 = sha256(source.content);
  assert.ok(Buffer.byteLength(canonical(p)) < 64000, 'The original packet fits the raw evidence budget');
  assert.ok(p.criteria.every(c => Buffer.byteLength(renderView(p, c.id)) > 64000), 'Explicit registry labels exceed each rendered criterion prompt budget');
  let calls = 0;
  const provider = new OllamaReviewer({ fetcher: async () => { calls++; throw Error('Unexpected provider call'); } });
  await assert.rejects(provider.review(p), /REVIEW_SCOPE_TOO_LARGE/);
  assert.equal(calls, 0, 'Oversized rendered context must never be silently submitted for truncation');
});

test('wire registry enum contains exactly the supplied IDs for each evidence kind', () => {
  const p = packet();
  p.documents[0].content = "const safe = true;\n" + 'x'.repeat(650); p.documents[0].sha256 = sha256(p.documents[0].content);
  const runtime = p.documents.find(d => d.kind === 'runtime');
  runtime.content = JSON.stringify({ output: 'First actual runtime result\nSecond actual runtime result' }); runtime.sha256 = sha256(runtime.content);
  const schema = schemaFor(p).properties.criteria.properties[p.criteria[0].id], registry = buildRegistry(p);
  for (const kind of KINDS) {
    const allowed = schema.properties.observations.properties[kind].items.properties.evidence_id.enum;
    const expected = registry.entries.filter(e => e.kind === kind).map(e => e.id);
    assert.deepEqual(allowed, expected); assert.equal(allowed.length, new Set(allowed).size);
    assert.ok(allowed.every(id => new RegExp('^E' + kind + '[0-9]+_[LR][0-9]+(?:p[0-9]+)?_[0-9a-f]{12}$').test(id)), 'Readable addresses retain their kind, document index, anchor and evidence hash');
  }
  assert.ok(registry.entries.some(e => e.anchor.startsWith('R')));
  assert.ok(registry.entries.some(e => e.anchor.includes(':')));
});


test('required-kind checklist retains every criterion and the full surrounding evidence context', () => {
  const p = packet();
  p.criteria.push({ id: 'caller-wiring', requirement: 'Inspect the complete caller guard and dependency boundary.', evidenceKinds: ['source', 'dependency'] });
  p.documents[0].content = 'if (safe && fresh) {\n  executePaper();\n}\n'; p.documents[0].sha256 = sha256(p.documents[0].content);
  const rendered = renderPacket(p);
  assert.ok(rendered.includes(canonical(p.criteria)), 'Each criterion retains its exact required evidence kinds and requirement');
  for (const doc of p.documents) {
    const begin = 'BEGIN ' + canonical({ id: doc.id, kind: doc.kind, file: doc.file, sha256: doc.sha256 });
    const start = rendered.indexOf(begin), end = rendered.indexOf('END ' + doc.id, start);
    assert.ok(start >= 0 && end > start);
    const body = rendered.slice(start + begin.length, end);
    for (const line of doc.content.split('\n').filter(Boolean)) assert.ok(body.includes(line), `Missing original context in ${doc.id}`);
  }
  for (const e of buildRegistry(p).entries) assert.ok(rendered.includes('[' + e.id + '] ' + e.quote));
  assert.ok(rendered.includes('Empty selections mean missing evidence'));
});


test('Ollama refuses incomplete output, model mismatch, tool calls and oversized responses', async () => {
  const base = { done: true, done_reason: 'stop', model: 'qwen3:14b', message: { role: 'assistant', content: '{}' } };
  for (const modify of [v => { v.done = false; }, v => { v.done_reason = 'length'; }, v => { v.model = 'other'; }, v => { v.message.tool_calls = [{}]; }]) {
    const response = structuredClone(base); modify(response);
    const r = new OllamaReviewer({ fetcher: async () => new Response(JSON.stringify(response)) });
    await assert.rejects(r.review(packet()), /REVIEW_PROVIDER_INCOMPLETE/);
  }
  const r = new OllamaReviewer({ fetcher: async () => new Response('x'.repeat(256 * 1024 + 1)) });
  await assert.rejects(r.review(packet()), /REVIEW_RESPONSE_TOO_LARGE/);
});

test('wire raw evidence byte budget is enforced before provider I/O even when rendered text fits', async () => {
  const p = packet(); p.documents[0].content = 'Protocol evidence line.' + '\t'.repeat(33000); p.documents[0].sha256 = sha256(p.documents[0].content);
  assert.ok(Buffer.byteLength(canonical(p)) > 64000, 'JSON escape expansion exceeds the raw packet limit');
  assert.ok(p.criteria.every(c => Buffer.byteLength(renderView(p, c.id)) < 64000), 'This regression isolates the raw limit from every rendered criterion limit');
  let calls = 0;
  const r = new OllamaReviewer({ fetcher: async () => { calls++; throw Error('Unexpected provider request'); } });
  await assert.rejects(r.review(p), /REVIEW_SCOPE_TOO_LARGE/); assert.equal(calls, 0);
});

test('malformed registry selection retries once with the exact host rejection and unchanged evidence', async () => {
  const p = packet(), seen = [], first = new OllamaReviewer({ fetcher: async (url, init) => {
    const sent = JSON.parse(init.body); seen.push(sent);
    const raw = wire(p, support(p)); criterion(raw).observations.source[0].evidence_id = 'invented';
    return new Response(JSON.stringify({ done: true, done_reason: 'stop', model: 'qwen3:14b', message: { role: 'assistant', content: JSON.stringify(raw) } }));
  } });
  const second = new OllamaReviewer({ fetcher: async (url, init) => {
    const sent = JSON.parse(init.body); seen.push(sent);
    return new Response(JSON.stringify({ done: true, done_reason: 'stop', model: 'qwen3:14b', message: { role: 'assistant', content: JSON.stringify(contradict(p)) } }));
  } });
  const result = await new JevAuditor({ reviewer: first, escalationReviewer: second }).audit(p);
  assert.equal(result.status, 'FAIL'); assert.equal(seen.length, 2);
  assert.equal(result.source.attempts[0].result, 'INVALID_EVIDENCE_SELECTION');
  assert.ok(seen[1].messages[0].content.includes('INVALID_EVIDENCE_SELECTION'));
  assert.equal(seen[0].messages[1].content, seen[1].messages[1].content);
  assert.ok(seen.every(request => request.model === 'qwen3:14b'));
});

test('wire reviewer protocol and configured model attribution cannot be forged', async () => {
  for (const corrupt of [p => { p.protocol = 'classifier/1'; }, p => { delete p.protocol; }, p => { p.model = 'qwen3:8b'; }]) {
    const first = { model: 'qwen3:14b', async review(p) {
      const provenance = { provider: 'ollama-local', model: 'qwen3:14b', protocol: 'evidence-first/2' }; corrupt(provenance);
      return { analysis: support(p), provenance };
    } };
    const result = await new JevAuditor({ reviewer: first, escalationReviewer: null }).audit(packet());
    assert.equal(result.status, 'CHUA_XAC_MINH');
    assert.equal(result.source.attempts[0].result, 'INVALID_REVIEWER_IDENTITY');
  }
});

test('wire multi-criterion valid ERROR stops before later malformed output and cannot trigger retry', async () => {
  const p = packet();
  p.criteria.push({ id: 'pending-criterion', requirement: 'Independently inspect the second bounded criterion.', evidenceKinds: ['source', 'runtime'] });
  let calls = 0;
  const first = new OllamaReviewer({ fetcher: async (url, init) => {
    calls++;
    const sent = JSON.parse(init.body);
    assert.deepEqual(sent.format.properties.criteria.required, [p.criteria[0].id]);
    const raw = contradict(p); criterion(raw).assessment = 'SUPPORTS';
    const content = calls === 1 ? JSON.stringify({ criteria: { [p.criteria[0].id]: criterion(raw) } }) : '{ malformed later review';
    return new Response(JSON.stringify({ done: true, done_reason: 'stop', model: 'qwen3:14b', message: { role: 'assistant', content } }));
  } });
  const second = reviewer(support), result = await new JevAuditor({ reviewer: first, escalationReviewer: second }).audit(p);
  assert.equal(calls, 1, 'A later provider call must not erase a genuine earlier finding');
  assert.equal(second.calls, 0, 'An evidence-backed ERROR is not a retryable format failure');
  assert.equal(result.status, 'FAIL'); assert.equal(result.source.attempts.length, 1);
  assert.equal(result.checks[0].status, 'FAIL'); assert.equal(result.checks[1].status, 'CHUA_XAC_MINH');
  assert.equal(result.findings[0].message, criterion(contradict(p)).findings[0].message);
  assert.ok(result.missing_evidence.some(item => item.startsWith('pending-criterion:')));
  const provenance = result.source.attempts[0];
  assert.deepEqual(provenance.notReviewedCriteria, ['pending-criterion']);
  assert.deepEqual(provenance.calls.map(call => call.criterion_id), [p.criteria[0].id]);
  assert.deepEqual(provenance.views, [criterionView(p, p.criteria[0].id).manifest]);
  assert.equal(result.analysis.criteria['pending-criterion'].assessment, 'UNKNOWN');
  assert.deepEqual(result.analysis.criteria['pending-criterion'].observations, { source: [], runtime: [] });
});

test('wire multi-criterion UNKNOWN remains final with unreviewed criteria explicitly unknown', async () => {
  const p = packet();
  p.criteria.push({ id: 'unreviewed', requirement: 'Inspect an independent source obligation.', evidenceKinds: ['source'] });
  let calls = 0;
  const first = new OllamaReviewer({ fetcher: async () => {
    calls++; const raw = contradict(p, true);
    return new Response(JSON.stringify({ done: true, done_reason: 'stop', model: 'qwen3:14b', message: { role: 'assistant', content: JSON.stringify({ criteria: { [p.criteria[0].id]: criterion(raw) } }) } }));
  } });
  const second = reviewer(support), result = await new JevAuditor({ reviewer: first, escalationReviewer: second }).audit(p);
  assert.equal(result.status, 'CHUA_XAC_MINH'); assert.equal(calls, 1); assert.equal(second.calls, 0);
  assert.equal(result.checks[1].status, 'CHUA_XAC_MINH');
  assert.deepEqual(result.source.attempts[0].notReviewedCriteria, ['unreviewed']);
});

test('wire all supported criteria retain original registry IDs and only actual view provenance', async () => {
  const p = packet();
  p.criteria.push({ id: 'second-criterion', requirement: 'Inspect the independently bounded source and runtime.', evidenceKinds: ['source', 'runtime'] });
  const complete = grounded(p, support(p)), calls = [], expectedAttributions = [], requests = [];
  for (const c of p.criteria) {
    const primary = { criteria: { [c.id]: complete.criteria[c.id] } }, input = buildAttributionInput(p, primary, c.id);
    for (const observation of Object.values(complete.criteria[c.id].observations).flat()) {
      assert.ok(buildRegistry(p).entries.some(entry => entry.id === observation.evidence_id), 'Selections retain the complete parent packet hash');
      assert.ok(renderView(p, c.id).includes(observation.evidence_id), 'Selected parent ID remains present in this exact criterion view');
    }
    const parts = attributionParts(input).map(part => ({ model: 'qwen3:14b', input: part, review: attributionSupport(part) }));
    const eligibility = require('../services/jev/auditor/readback.cjs').observationEligibility(p, c.id);
    requests.push({ format: readbackSchema(p, [c.id]), content: renderView(p, c.id) + '\nOBSERVATION ELIGIBILITY: ' + canonical(eligibility), reply: wire(p, primary) });
    for (const part of parts) requests.push({ format: attributionPartSchema(part.input), content: canonical(part.input), reply: part.review });
    expectedAttributions.push({ model: 'qwen3:14b', review: assembleAttribution(input, parts), parts });
  }
  const transport = new OllamaReviewer({ fetcher: async (url, init) => {
    const request = JSON.parse(init.body), expected = requests[calls.length]; calls.push(request);
    assert.deepEqual(request.format, expected.format);
    assert.equal(request.messages[1].content, expected.content);
    assert.deepEqual(request.messages.map(message => message.role), ['system', 'user'], 'Each attribution part has an independent fresh context');
    return new Response(JSON.stringify({ done: true, done_reason: 'stop', model: 'qwen3:14b', prompt_eval_count: 10, eval_count: 20, total_duration: 30, message: { role: 'assistant', content: JSON.stringify(expected.reply) } }));
  } });
  const response = await transport.review(p);
  assert.equal(calls.length, requests.length); assert.deepEqual(response.analysis, complete);
  assert.equal(Object.hasOwn(response, 'status'), false); assert.equal(Object.hasOwn(response, 'result'), false);
  assert.deepEqual(response.provenance.notReviewedCriteria, []);
  assert.deepEqual(response.provenance.views, p.criteria.map(c => criterionView(p, c.id).manifest));
  assert.deepEqual(response.provenance.calls.map(call => [call.criterion_id, call.phase]), p.criteria.flatMap(c => [[c.id, 'analysis'], [c.id, 'attribution']]));
  assert.deepEqual(response.provenance.attributions, expectedAttributions);
  assert.equal(response.provenance.promptTokens, requests.length * 10); assert.equal(response.provenance.outputTokens, requests.length * 20); assert.equal(response.provenance.durationNs, requests.length * 30);
});


test('wire finding target must retain evidence from the file it actually criticizes', () => {
  const p = packet(), content = 'function secondCaller() { return skippedGuard(); }';
  p.documents.push({ id: 'second-source', kind: 'source', file: 'tests/protocol/second-source.cjs', content, sha256: sha256(content) });
  const raw = contradict(p); criterion(raw).findings[0].file = 'tests/protocol/second-source.cjs';
  assert.throws(() => evaluateReview(p, raw), /INVALID_FINDING_TARGET_EVIDENCE/, 'Another source file cannot justify this target by proximity');
  criterion(raw).findings[0].evidence_ids = [buildRegistry(p).entries.find(e => e.document_id === 'second-source').id];
  const evaluated = evaluateReview(p, raw);
  assert.equal(evaluated.result.status, 'FAIL');
  assert.deepEqual(evaluated.result.findings[0].evidence_ids, ['second-source']);
  assert.deepEqual(evaluated.result.required_fixes[0].files, ['tests/protocol/second-source.cjs']);
});

test('serialized credential objects are rejected through repeated JSON string encoding', () => {
  const secret = 'x'.repeat(32);
  for (const key of ['api_key', 'privateKey', 'signing_secret', 'access_token']) {
    let encoded = { nested: [{ [key]: secret }] };
    for (let depth = 1; depth <= 4; depth++) {
      encoded = JSON.stringify(encoded);
      assert.throws(() => assertNoSecrets(encoded), /SECRET_LITERAL_DENIED/, `${key} at serialization depth ${depth} must be screened as credential data`);
      assert.throws(() => assertNoSecrets({ diagnostic: encoded }), /SECRET_LITERAL_DENIED/, 'Wrapping serialized credentials in metadata cannot bypass screening');
    }
  }
});

test('multiline and escaped quoted source credentials are denied without leaking fragments', () => {
  const left = 'x'.repeat(16), right = 'y'.repeat(16);
  const values = [left + '\n' + right, left + '\r\n' + right, left + '\\"' + right, left + '\\\n' + right];
  for (const value of values) {
    const source = 'api_key=' + '"' + value + '"';
    assert.throws(() => assertNoSecrets(source), /SECRET_LITERAL_DENIED/, 'Literal source credentials remain secret across newline or quote escapes');
    assert.throws(() => assertNoSecrets(JSON.stringify(source)), /SECRET_LITERAL_DENIED/, 'Serialized source cannot bypass quoted credential screening');
  }
});

test('serialized harmless references and source identifiers remain inspectable', () => {
  const examples = [
    { fieldName: 'private_key', source: "function lookup(input) { return input['api_key']; }" },
    { source: 'const api_key = process.env.AUDIT_API_KEY;\nreturn api_key;' },
    { source: 'function validate(input) { return input.authorization; }' },
    { source: 'const value = "plain multiline text\\nwithout credential assignment";' }
  ];
  for (const example of examples) {
    assert.doesNotThrow(() => assertNoSecrets(example));
    let encoded = example;
    for (let depth = 1; depth <= 4; depth++) {
      encoded = JSON.stringify(encoded);
      assert.doesNotThrow(() => assertNoSecrets(encoded), 'Serialization alone does not make identifiers or external references secret literals');
    }
  }
});

test('encoded or multiline packet credentials stop before reviewer invocation', async () => {
  const dummy = 'x'.repeat(32);
  for (const source of [JSON.stringify(JSON.stringify({ nested: { api_key: dummy } })), 'api_key=' + '"' + dummy.slice(0, 16) + '\n' + dummy.slice(16) + '"']) {
    const p = packet(); p.documents[0].content = source; p.documents[0].sha256 = sha256(source);
    const first = reviewer(support), second = reviewer(support);
    const result = await new JevAuditor({ reviewer: first, escalationReviewer: second }).audit(p);
    assert.equal(result.status, 'CHUA_XAC_MINH');
    assert.equal(first.calls + second.calls, 0, 'Credential-bearing source must never reach either reviewer');
    assert.ok(!JSON.stringify(result).includes(dummy.slice(0, 16)), 'The blocked receipt cannot echo secret fragments');
  }
});

test('encoded or multiline reviewer credentials cannot persist in analysis or rejected diagnostics', async () => {
  const dummy = 'x'.repeat(32);
  for (const secret of [JSON.stringify(JSON.stringify({ nested: { api_key: dummy } })), 'api_key=' + '"' + dummy.slice(0, 16) + '\n' + dummy.slice(16) + '"']) {
    const first = reviewer(p => { const raw = contradict(p); criterion(raw).reason = secret; return raw; });
    const second = reviewer(support), result = await new JevAuditor({ reviewer: first, escalationReviewer: second }).audit(packet());
    assert.equal(result.status, 'CHUA_XAC_MINH'); assert.equal(second.calls, 0, 'Secret leakage is not a reason to seek an approving reviewer');
    assert.equal(result.source.attempts[0].result, 'SECRET_LITERAL_DENIED');
    assert.equal(Object.hasOwn(result.source.attempts[0], 'rejected_review'), false);
    assert.equal(Object.hasOwn(result, 'analysis'), false);
    assert.ok(!JSON.stringify(result).includes(dummy.slice(0, 16)), 'Neither raw nor encoded secret fragments may be persisted');
  }
});

test('escaped JSON literals embedded in source cannot conceal credential payloads', () => {
  const dummy = 'x'.repeat(32);
  for (const nested of [{ api_key: dummy }, { log: JSON.stringify({ nested: { private_key: dummy } }) }]) {
    const escaped = JSON.stringify(JSON.stringify(nested));
    for (const source of ['const payload = ' + escaped + ';', 'record(' + escaped + ');']) {
      assert.throws(() => assertNoSecrets(source), /SECRET_LITERAL_DENIED/);
    }
  }
  const harmless = JSON.stringify(JSON.stringify({ field: 'api_key', source: 'const value = process.env.AUDIT_API_KEY;' }));
  assert.doesNotThrow(() => assertNoSecrets('record(' + harmless + ');'), 'Embedded JSON source references are data without secret values');
});

test('credential screening depth is bounded and fails closed without exposing nested values', () => {
  let nested = { field: 'public reference' };
  for (let i = 0; i < 40; i++) nested = [nested];
  assert.throws(() => assertNoSecrets(nested), /SECRET_SCREEN_LIMIT/);
  assert.throws(() => assertNoSecrets(JSON.stringify(nested)), /SECRET_SCREEN_LIMIT/);
  const cycle = { field: 'api_key' }; cycle.self = cycle;
  assert.doesNotThrow(() => assertNoSecrets(cycle), 'A harmless cyclic reference must not overflow the stack');
  cycle.diagnostic = { private_key: 'x'.repeat(32) };
  assert.throws(() => assertNoSecrets(cycle), /SECRET_LITERAL_DENIED/, 'Previously seen cycles cannot suppress later credential siblings');
});

test('result coverage rejects exactly one omitted criterion and duplicate substitution', () => {
  const p = packet();
  p.criteria.push({ id: 'second-coverage', requirement: 'Inspect an independently required source boundary.', evidenceKinds: ['source'] });
  p.criteria.push({ id: 'third-coverage', requirement: 'Inspect the final independently required runtime boundary.', evidenceKinds: ['runtime'] });
  const complete = pass(p);
  assert.doesNotThrow(() => validateResult(complete, p));
  for (let omitted = 0; omitted < p.criteria.length; omitted++) {
    const incomplete = structuredClone(complete); incomplete.checks.splice(omitted, 1);
    assert.equal(incomplete.checks.length, p.criteria.length - 1);
    assert.throws(() => validateResult(incomplete, p), /INCOMPLETE_CRITERIA_COVERAGE/);
    incomplete.checks.push(structuredClone(incomplete.checks[0]));
    assert.equal(incomplete.checks.length, p.criteria.length, 'Matching length cannot conceal a missing criterion');
    assert.throws(() => validateResult(incomplete, p), /INVALID_AUDIT_CHECK/);
  }
});

test('requested packet criteria require unique nonempty IDs without granting profile authority', async () => {
  const p = packet();
  p.criteria.push({ id: 'owner-requested-boundary', requirement: 'Inspect this new explicitly requested boundary.', evidenceKinds: ['source'] });
  assert.doesNotThrow(() => validatePacket(p), 'Packet validation must permit well-formed new requested criteria');
  const empty = structuredClone(p); empty.criteria[1].id = '';
  assert.throws(() => validatePacket(empty), /INVALID_AUDIT_CRITERIA/);
  const duplicate = structuredClone(p); duplicate.criteria[1].id = duplicate.criteria[0].id;
  assert.throws(() => validatePacket(duplicate), /DUPLICATE_CRITERION/);
  const first = reviewer(support), result = await new JevAuditor({ reviewer: first, escalationReviewer: null }).audit(p);
  assert.equal(result.status, 'CHUA_XAC_MINH');
  assert.ok(result.missing_evidence.includes('UNREGISTERED_CRITERION_POLICY'), 'Syntactic validity does not register acceptance obligations');
});

test('wire missing evidence descriptions reject bare existing or invented evidence IDs', () => {
  const p = packet(), real = buildRegistry(p).entries[0].id, invented = 'E000000000000';
  assert.ok(!buildRegistry(p).entries.some(e => e.id === invented));
  for (const id of [real, invented]) {
    const raw = support(p); criterion(raw).missing_evidence = [id];
    assert.throws(() => evaluateReview(p, raw), /INVALID_MISSING_EVIDENCE_DESCRIPTION/, 'An evidence address does not describe a missing fact');
  }
});

test('wire factual missing evidence stays unknown and never retries toward support', async () => {
  const missing = 'The runtime capture does not include the required stale-input rejection case.';
  const first = reviewer(p => { const raw = support(p); criterion(raw).missing_evidence = [missing]; return raw; });
  const second = reviewer(support), result = await new JevAuditor({ reviewer: first, escalationReviewer: second }).audit(packet());
  assert.equal(result.status, 'CHUA_XAC_MINH'); assert.equal(first.calls, 1); assert.equal(second.calls, 0);
  assert.ok(result.missing_evidence.includes('scope-evidence:' + missing));
  assert.equal(result.source.attempts[0].result, 'VALID_STRUCTURED_REVIEW');
});

test('wire valid ERROR survives malformed auxiliary missing evidence without retry', async () => {
  const p = packet();
  for (const missing of [buildRegistry(p).entries[0].id, 'E000000000000']) {
    const raw = contradict(p); criterion(raw).missing_evidence = [missing];
    const evaluated = evaluateReview(p, raw);
    assert.equal(evaluated.result.status, 'FAIL', 'A confirmed error cannot be erased by malformed auxiliary text');
    const first = reviewer(() => raw), second = reviewer(support);
    const result = await new JevAuditor({ reviewer: first, escalationReviewer: second }).audit(p);
    assert.equal(result.status, 'FAIL'); assert.equal(first.calls, 1); assert.equal(second.calls, 0);
    assert.equal(result.findings[0].message, criterion(raw).findings[0].message);
    assert.equal(result.root_causes[0].explanation, criterion(raw).findings[0].root_cause);
    assert.equal(result.required_fixes[0].action, criterion(raw).findings[0].required_fix);
  }
});

test('wire negative or unknown analysis with malformed auxiliary missing IDs never retries', async () => {
  const p = packet();
  for (const kind of ['UNKNOWN', 'CONTRADICTS', 'UNKNOWN_FINDING_WITH_SUPPORTS']) for (const id of [buildRegistry(p).entries[0].id, 'E000000000000']) {
    const raw = kind === 'UNKNOWN_FINDING_WITH_SUPPORTS' ? contradict(p, true) : support(p);
    const review = criterion(raw);
    review.assessment = kind === 'UNKNOWN_FINDING_WITH_SUPPORTS' ? 'SUPPORTS' : kind;
    review.reason = 'The reviewer cannot establish whether the caller validates stale input from the supplied execution record.';
    review.missing_evidence = [id];
    const first = reviewer(() => raw), second = reviewer(support);
    const result = await new JevAuditor({ reviewer: first, escalationReviewer: second }).audit(p);
    assert.equal(result.status, 'CHUA_XAC_MINH'); assert.equal(first.calls, 1); assert.equal(second.calls, 0);
    assert.equal(result.source.attempts.length, 1);
    assert.equal(result.source.attempts[0].result, 'VALID_STRUCTURED_REVIEW', 'Malformed auxiliary text cannot erase independent negative analysis');
    assert.equal(result.checks[0].status, 'CHUA_XAC_MINH');
    if (review.findings.length) {
      assert.equal(result.findings[0].message, review.findings[0].message);
      assert.equal(result.root_causes[0].explanation, review.findings[0].root_cause);
    }
  }
});

test('wire semantic attribution veto blocks real mismatched-quote patterns without retry', async () => {
  // Source/claim pairs observed in revoked receipts 6b410dfd and c376210a.
  // The injected critic tests gate wiring only; it is not model calibration.
  const counterexamples = [
    { quote: "const id = value => typeof value === 'string' && /^[a-zA-Z0-9._:/-]{1,160}$/.test(value);", explanation: 'validateResult ensures criteria coverage via seen.size !== criteria.size.' },
    { quote: "if (!findings.has(cause.finding_id)) fail('INVALID_ROOT_CAUSE');", explanation: 'This regular expression matches unquoted API keys with 16 or more characters.' },
    { quote: 'answer = await reviewer.review(freeze(structuredClone(packet)), { previousError });', explanation: 'Verifies model identity by rejecting mismatched provider, model and protocol attributes.' }
  ];
  for (const relation of ['UNKNOWN', 'CONTRADICTED']) for (const counterexample of counterexamples) {
    const p = packet(); p.documents[0].content = counterexample.quote; p.documents[0].sha256 = sha256(counterexample.quote);
    p.criteria.push({ id: 'pending-semantic-review', requirement: 'Inspect a separate pending source boundary.', evidenceKinds: ['source'] });
    const raw = support(p), id = p.criteria[0].id; criterion(raw).observations.source[0].explanation = counterexample.explanation;
    const primary = grounded(p, { criteria: { [id]: criterion(raw) } }), bundle = buildAttributionInput(p, primary, id);
    let calls = 0; const returnedParts = [], expectedParts = attributionParts(bundle);
    const first = new OllamaReviewer({ fetcher: async (url, init) => {
      calls++; const request = JSON.parse(init.body); let response;
      if (calls === 1) response = wire(p, primary);
      else {
        assert.ok(calls <= expectedParts.length + 1, 'A semantic veto prevents subsequent criterion requests');
        assert.equal(request.model, 'qwen3:14b');
        assert.deepEqual(request.messages.map(message => message.role), ['system', 'user']);
        const part = JSON.parse(request.messages[1].content);
        assert.deepEqual(part, expectedParts[calls - 2]);
        response = attributionSupport(part);
        if (part.evidence_id === bundle.observations.find(o => o.kind === 'source').evidence_id) {
          assert.equal(part.quote, counterexample.quote); assert.equal(part.explanation, counterexample.explanation);
          response = { input_hash: part.input_hash, relation, reason: 'The selected quote does not establish the behavior attributed to it.' };
        }
        returnedParts.push({ model: 'qwen3:14b', input: part, review: response });
      }
      return new Response(JSON.stringify({ done: true, done_reason: 'stop', model: 'qwen3:14b', message: { role: 'assistant', content: JSON.stringify(response) } }));
    } });
    const second = reviewer(support), result = await new JevAuditor({ reviewer: first, escalationReviewer: second }).audit(p);
    assert.equal(result.status, 'CHUA_XAC_MINH'); assert.equal(calls, expectedParts.length + 1); assert.equal(second.calls, 0);
    assert.ok(result.missing_evidence.includes('ATTRIBUTION_VETO:' + id + ':' + relation));
    assert.deepEqual(result.analysis.criteria[id], primary.criteria[id], 'Critic veto cannot silently rewrite the primary analysis');
    assert.equal(result.analysis.criteria['pending-semantic-review'].assessment, 'UNKNOWN');
    assert.deepEqual(result.source.attempts[0].attributions, [{ model: 'qwen3:14b', review: assembleAttribution(bundle, returnedParts), parts: returnedParts }]);
    assert.deepEqual(result.source.attempts[0].calls.map(call => call.phase), ['analysis', 'attribution']);
    assert.equal(result.source.attempts.length, 1);
  }
});

test('wire primary negatives never invoke attribution or gain acceptance through another critic', async () => {
  for (const unknown of [false, true]) {
    const p = packet(), raw = contradict(p, unknown); let calls = 0;
    const first = new OllamaReviewer({ fetcher: async (url, init) => {
      calls++; const request = JSON.parse(init.body);
      assert.ok(request.format.properties.criteria, 'Only primary analysis is requested after a genuine negative');
      return new Response(JSON.stringify({ done: true, done_reason: 'stop', model: 'qwen3:14b', message: { role: 'assistant', content: JSON.stringify(raw) } }));
    } });
    const second = reviewer(support), result = await new JevAuditor({ reviewer: first, escalationReviewer: second }).audit(p);
    assert.equal(result.status, unknown ? 'CHUA_XAC_MINH' : 'FAIL'); assert.equal(calls, 1); assert.equal(second.calls, 0);
    assert.deepEqual(result.source.attempts[0].attributions, []);
    assert.deepEqual(result.source.attempts[0].calls.map(call => call.phase), ['analysis']);
  }
});


test('wire isolated attribution veto survives later malformed or failed subcalls without retry', async () => {
  for (const relation of ['UNKNOWN', 'CONTRADICTED']) for (const failure of ['malformed', 'outage']) {
    const p = packet(), primary = support(p); let calls = 0;
    let negativePart;
    const first = new OllamaReviewer({ fetcher: async (_url, init) => {
      calls++; const request = JSON.parse(init.body);
      let raw;
      if (calls === 1) raw = wire(p, primary);
      else if (calls === 2) {
        const input = JSON.parse(request.messages[1].content);
        assert.equal(input.kind, 'observation');
        raw = { input_hash: input.input_hash, relation, reason: 'The supplied fragment does not establish this claimed behavior.' };
        negativePart = { model: 'qwen3:14b', input, review: raw };
      } else {
        assert.equal(calls, 3, 'No new review may run after an interrupted valid veto');
        if (failure === 'outage') throw Error('SENSITIVE_UPSTREAM_DIAGNOSTIC');
        raw = { input_hash: '0'.repeat(64), relation: 'SUPPORTED', reason: 'A reply for a different observation.' };
      }
      return new Response(JSON.stringify({ done: true, done_reason: 'stop', model: 'qwen3:14b', message: { role: 'assistant', content: JSON.stringify(raw) } }));
    } });
    const second = reviewer(support), result = await new JevAuditor({ reviewer: first, escalationReviewer: second }).audit(p);
    assert.equal(calls, 3); assert.equal(second.calls, 0);
    assert.equal(result.status, 'CHUA_XAC_MINH'); assert.equal(result.source.attempts.length, 1);
    assert.equal(result.source.attempts[0].result, 'ATTRIBUTION_INTERRUPTED_AFTER_VETO');
    const retained = result.source.attempts[0].attribution_evidence;
    assert.ok(retained, 'Accepted negative subcall evidence must survive the later provider failure');
    assert.deepEqual(retained, [negativePart], 'The exact validated negative input and judgment must remain available for inspection');
    assert.ok(!JSON.stringify(result).includes('SENSITIVE_UPSTREAM_DIAGNOSTIC'));
  }
});
