'use strict';
// Explicit protocol fixtures, never real runtime/model acceptance evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const { sha256, canonical, KINDS, validateResult } = require('../services/jev/auditor/contract.cjs');
const { buildRegistry, renderPacket } = require('../services/jev/auditor/evidence-registry.cjs');
const { entries: anchorEntries } = require('../services/jev/auditor/anchors.cjs');
const { schemaFor, evaluateReview } = require('../services/jev/auditor/evaluation.cjs');
const { readbackSchema, decodeReadback, runtimeExplanation } = require('../services/jev/auditor/readback.cjs');
const { verifyObligations, parseTests, OBLIGATIONS } = require('../services/jev/auditor/proofs.cjs');
const { profiles } = require('../services/jev/auditor/profiles.cjs');
const { criterionView, renderView } = require('../services/jev/auditor/views.cjs');
const { OllamaReviewer } = require('../services/jev/auditor/ollama.cjs');
const { JevAuditor } = require('../services/jev/auditor/service.cjs');
const { buildAttributionInput, attributionSchema, validateAttribution, assertAttribution, attributionParts, assembleAttribution } = require('../services/jev/auditor/attribution.cjs');

function packet() {
  return {
    scope: 'v2-protocol-fixture',
    criteria: [{ id: 'coverage', requirement: 'Verify the complete supplied evidence chain for this protocol fixture.', evidenceKinds: [...KINDS] }],
    documents: KINDS.map(kind => {
      const content = `Protocol fixture ${kind}: immutable evidence text for selection.\nSecond ${kind} line remains separate evidence.`;
      return { id: kind, kind, file: `tests/protocol-v2/${kind}.txt`, content, sha256: sha256(content) };
    })
  };
}
function setContent(doc, content) { doc.content = content; doc.sha256 = sha256(content); }
function analysis(p) {
  const registry = buildRegistry(p);
  return { criteria: Object.fromEntries(p.criteria.map(c => [c.id, {
    assessment: 'SUPPORTS', reason: 'The explicitly selected fixture passages cover the requested input kinds.',
    observations: Object.fromEntries(c.evidenceKinds.map(kind => [kind, [{ evidence_id: registry.entries.find(e => e.kind === kind).id, explanation: `This exact ${kind} passage is selected for the protocol-only review.` }]])),
    findings: [], missing_evidence: []
  }])) };
}
function proofPacket() {
  const profile = profiles['auditor-contract'];
  const p = packet(); p.scope = profile.scope; p.criteria = structuredClone(profile.criteria);
  const sourceTemplate = p.documents.find(d => d.kind === 'source');
  p.documents = [...profile.files.map((file, i) => ({ ...sourceTemplate, id: 'source-' + i, file })), ...p.documents.filter(d => d.kind !== 'source')];
  const names = [...new Set(p.criteria.flatMap(c => OBLIGATIONS[c.id]))];
  const output = ['TAP version 13', ...names.map((name, i) => `ok ${i + 1} - ${name}`), `1..${names.length}`].join('\n');
  writeRuntime(p, { check: profile.check, output, outputSha256: sha256(output), exitCode: 0 });
  return p;
}
function writeRuntime(p, runtime) { setContent(p.documents.find(d => d.kind === 'runtime'), JSON.stringify(runtime)); }
function editRuntime(p, edit) { const r = JSON.parse(p.documents.find(d => d.kind === 'runtime').content); edit(r); r.outputSha256 = sha256(r.output); writeRuntime(p, r); }
function viewPacket() {
  const p = proofPacket();
  p.documents.find(d => d.kind === 'architecture').file = 'docs/JEV-AUDITOR.md';
  for (const [index, doc] of p.documents.filter(d => d.kind === 'source').entries()) setContent(doc, `Complete responsibility file ${index}: caller and callee context.\nLast source line ${index} must remain visible.`);
  const content = 'Additional autonomous-intelligence rules retained in the complete packet.';
  p.documents.push({ id: 'autonomy', kind: 'architecture', file: 'docs/AUTONOMOUS-INTELLIGENCE.md', content, sha256: sha256(content) });
  return p;
}
function viewAnalysis(p) {
  return { criteria: Object.fromEntries(p.criteria.map(c => {
    const view = criterionView(p, c.id);
    return [c.id, { assessment: 'SUPPORTS', reason: 'The selected exact passages and required verifier records support this fixture claim.', observations: Object.fromEntries(c.evidenceKinds.map(kind => [kind, [{ evidence_id: view.entries.find(e => e.kind === kind).id, explanation: `Exact selected ${kind} fixture evidence for this criterion.` }]])), findings: [], missing_evidence: [] }];
  })) };
}
function attributionReply(input, relation = 'SUPPORTED') {
  return { criterion_id: input.criterion_id, bundle_hash: input.bundle_hash, overview: { relation, reason: 'Explicit protocol-only relationship judgment.' }, observations: Object.fromEntries(input.observations.map(observation => [observation.evidence_id, { relation, reason: 'Explicit protocol-only interpretation of this selected quote.' }])) };
}

test('v2 anchors preserve complete guards and bounded Unicode evidence without losing tails', () => {
  const guard = 'if (' + 'condition && '.repeat(27) + 'invalid) throw Error("INVALID");';
  assert.ok(guard.length > 300 && guard.length <= 400);
  assert.deepEqual(anchorEntries({ kind: 'source', content: guard }).map(e => e.text), [guard]);
  for (const content of ['a'.repeat(401), 'b'.repeat(411), 'c'.repeat(799), 'd'.repeat(801), '😀'.repeat(205), 'x'.repeat(399) + '😀' + 'y'.repeat(20)]) {
    const entries = anchorEntries({ kind: 'source', content });
    assert.equal(entries.map(e => e.text).join(''), content);
    assert.equal(new Set(entries.map(e => e.anchor)).size, entries.length);
    for (const e of entries) {
      assert.ok(e.anchor);
      assert.ok(e.text.length >= 12 && e.text.length <= 400);
      assert.ok(!/[\uD800-\uDBFF]$/.test(e.text));
      assert.ok(!/^[\uDC00-\uDFFF]/.test(e.text));
    }
  }
});

test('v2 registry binds evidence identity to scope and every original document', () => {
  const p = packet(), registry = buildRegistry(p);
  assert.equal(registry.packet_hash, sha256(canonical(p)));
  assert.equal(registry.registry_hash, sha256(canonical(registry.entries)));
  assert.deepEqual(buildRegistry(structuredClone(p)), registry);
  assert.equal(registry.entries.length, 10);
  assert.equal(new Set(registry.entries.map(e => e.id)).size, 10);
  for (const entry of registry.entries) {
    const doc = p.documents.find(d => d.id === entry.document_id);
    assert.equal(entry.scope, p.scope); assert.equal(entry.kind, doc.kind);
    assert.equal(entry.file, doc.file); assert.equal(entry.document_hash, doc.sha256);
    assert.ok(doc.content.includes(entry.quote)); assert.match(entry.anchor, /^L[12]$/);
    assert.ok(Object.isFrozen(entry));
  }
  for (const mutate of [
    q => { q.scope += '-foreign'; },
    q => { q.documents[0].file += '.moved'; },
    q => { setContent(q.documents[4], q.documents[4].content + '\nUnrelated dependency changed.'); },
    q => { q.criteria[0].requirement += ' Changed policy.'; }
  ]) {
    const changed = structuredClone(p); mutate(changed);
    const changedRegistry = buildRegistry(changed);
    assert.notEqual(changedRegistry.registry_hash, registry.registry_hash);
    assert.ok(registry.entries.every(e => !changedRegistry.entries.some(other => other.id === e.id)), 'Every evidence identity must be bound to the whole original packet');
  }
  assert.ok(Object.isFrozen(registry)); assert.ok(Object.isFrozen(registry.entries));
});

test('v2 reviewer input isolates exact evidence fragments and selects observations before conclusions', () => {
  const p = packet();
  setContent(p.documents[0], "if (seen.has(check.id)) fail('DUPLICATE');\nseen.add(check.id);");
  const view = criterionView(p, 'coverage'), rendered = renderView(p, 'coverage');
  const records = rendered.split('\n').flatMap(line => { try { const record = JSON.parse(line); return record.evidence_id ? [record] : []; } catch { return []; } });
  assert.equal(records.length, view.entries.length);
  for (const entry of view.entries) {
    assert.deepEqual(records.find(record => record.evidence_id === entry.id), { evidence_id: entry.id, quote: entry.quote });
  }
  const fields = Object.keys(schemaFor(p).properties.criteria.properties.coverage.properties);
  assert.ok(fields.indexOf('observations') < fields.indexOf('reason'));
  assert.ok(fields.indexOf('findings') < fields.indexOf('assessment'));
  assert.ok(fields.indexOf('missing_evidence') < fields.indexOf('assessment'));
  assert.deepEqual(criterionView(p, 'coverage').manifest, view.manifest);
});

test('v2 registry preserves exact decoded runtime origin and full rendered context', () => {
  const p = packet(), runtime = p.documents.find(d => d.kind === 'runtime');
  const output = 'ok 1 - Actual fixture output with "quoted" content\nShort';
  setContent(runtime, JSON.stringify({ output, outputSha256: sha256(output) }));
  const registry = buildRegistry(p), entry = registry.entries.find(e => e.document_id === 'runtime' && e.anchor === 'R1');
  assert.equal(entry.quote, output.split('\n')[0]); assert.equal(entry.document_hash, runtime.sha256);
  const rendered = renderPacket(p);
  assert.ok(rendered.includes(`[${entry.id}] ${entry.quote}`));
  assert.ok(rendered.includes('Short')); assert.ok(rendered.includes('DECODED ACTUAL RUNTIME OUTPUT:'));
  for (const doc of p.documents) assert.ok(rendered.includes(doc.sha256));
  assert.ok(rendered.includes(p.criteria[0].requirement));
});

test('v2 registry rejects altered document content before assigning evidence IDs', () => {
  const p = packet(); p.documents[0].content += ' Unhashed change.';
  assert.throws(() => buildRegistry(p), /INVALID_EVIDENCE_DOCUMENT/);
});

test('v2 schema restricts each kind and criterion without granting model authority', () => {
  const p = packet(), registry = buildRegistry(p), schema = schemaFor(p);
  assert.deepEqual(Object.keys(schema.properties), ['criteria']);
  assert.equal(schema.additionalProperties, false);
  const criteria = schema.properties.criteria;
  assert.deepEqual(criteria.required, ['coverage']); assert.equal(criteria.additionalProperties, false);
  const c = criteria.properties.coverage;
  assert.deepEqual(c.required, ['assessment', 'reason', 'observations', 'findings', 'missing_evidence']);
  assert.deepEqual(c.properties.assessment.enum, ['SUPPORTS', 'CONTRADICTS', 'UNKNOWN']);
  assert.equal(c.additionalProperties, false); assert.equal(c.properties.reason.enum, undefined);
  for (const kind of KINDS) {
    const selection = c.properties.observations.properties[kind];
    assert.deepEqual(selection.items.properties.evidence_id.enum, registry.entries.filter(e => e.kind === kind).map(e => e.id));
    assert.equal(selection.minItems, undefined, 'Missing evidence must be expressible without inventing a selection');
    assert.equal(selection.items.additionalProperties, false);
  }
  const foreign = packet(); foreign.scope += '-other';
  schemaFor(foreign);
  assert.deepEqual(schemaFor(p), schema, 'Schema generation must not share mutable enum domains');
});

test('v2 model authority fields cannot become an acceptance decision', () => {
  const p = packet();
  for (const field of ['status', 'scope', 'source_hash', 'registry_hash', 'receipt_id', 'evidence_ids']) {
    const raw = analysis(p); raw[field] = 'PASS';
    assert.throws(() => evaluateReview(p, raw), /INVALID_REVIEW_SCHEMA/, field);
  }
  for (const field of ['status', 'criterion_id', 'source_hash', 'evidence_ids']) {
    const raw = analysis(p); raw.criteria.coverage[field] = 'PASS';
    assert.throws(() => evaluateReview(p, raw), /INVALID_CRITERION_ANALYSIS/, field);
  }
  const unknown = analysis(p); unknown.criteria.foreign = structuredClone(unknown.criteria.coverage);
  assert.throws(() => evaluateReview(p, unknown), /INVALID_REVIEW_SCHEMA/);
  assert.throws(() => evaluateReview(p, { criteria: [] }), /INVALID_REVIEW_SCHEMA/);
});

test('v2 selections reject invented foreign and wrongly typed evidence IDs', () => {
  const p = packet(), registry = buildRegistry(p), foreign = packet(); foreign.scope += '-foreign';
  for (const id of ['Einvented', buildRegistry(foreign).entries[0].id, registry.entries.find(e => e.kind === 'runtime').id]) {
    const raw = analysis(p); raw.criteria.coverage.observations.source[0].evidence_id = id;
    assert.throws(() => evaluateReview(p, raw), /INVALID_EVIDENCE_SELECTION/);
  }
  const raw = analysis(p); raw.criteria.coverage.observations.source[0].quote = 'A model-written substitute quotation.';
  assert.throws(() => evaluateReview(p, raw), /INVALID_AUDIT_OBSERVATION/);
});

test('v2 projection derives only selected citations and exact public quotes', () => {
  const p = packet(), raw = analysis(p), before = structuredClone(raw), registry = buildRegistry(p);
  const review = evaluateReview(p, raw);
  assert.equal(review.result.status, 'PASS'); // Provisional analysis projection, NOT final acceptance.
  assert.deepEqual(review.evidence_ids, KINDS.map(k => raw.criteria.coverage.observations[k][0].evidence_id));
  assert.equal(review.evidence_ids.length, 5); assert.equal(registry.entries.length, 10);
  assert.deepEqual(review.missing_evidence, []); assert.deepEqual(review.analysis, before); assert.deepEqual(raw, before);
  validateResult(review.result, p);
  for (const observation of review.result.checks[0].observations) {
    const e = registry.entries.find(e => review.evidence_ids.includes(e.id) && e.document_id === observation.document_id);
    assert.equal(observation.quote, e.quote);
  }
  review.analysis.criteria.coverage.reason = 'Mutated returned clone';
  assert.deepEqual(raw, before);
  assert.equal(verifyObligations(p).status, 'CHUA_XAC_MINH', 'Prose and citations cannot register their own proof policy');
});

test('v2 missing required-kind observations remain unknown despite model support', () => {
  const p = packet(), raw = analysis(p); raw.criteria.coverage.observations.runtime = [];
  const review = evaluateReview(p, raw);
  assert.equal(review.result.status, 'CHUA_XAC_MINH');
  assert.ok(review.missing_evidence.includes('coverage:runtime'));
  assert.ok(!review.result.evidence.includes('runtime'));
  for (const kind of KINDS) raw.criteria.coverage.observations[kind] = [];
  const empty = evaluateReview(p, raw);
  assert.equal(empty.result.status, 'CHUA_XAC_MINH'); assert.deepEqual(empty.evidence_ids, []);
  for (const kind of KINDS) assert.ok(empty.missing_evidence.includes(`coverage:${kind}`));
});

test('v2 explicit uncertainty and model-reported missing evidence cannot be upgraded', () => {
  const p = packet(), raw = analysis(p); raw.criteria.coverage.assessment = 'UNKNOWN';
  const unknown = evaluateReview(p, raw);
  assert.equal(unknown.result.status, 'CHUA_XAC_MINH'); assert.ok(unknown.missing_evidence.includes('coverage:unresolved-review'));
  raw.criteria.coverage.assessment = 'SUPPORTS'; raw.criteria.coverage.missing_evidence = ['caller execution receipt'];
  const missing = evaluateReview(p, raw);
  assert.equal(missing.result.status, 'CHUA_XAC_MINH'); assert.ok(missing.missing_evidence.includes('coverage:caller execution receipt'));
});

test('v2 contradictory analysis retains actionable failure without positive observations', () => {
  const p = packet(), raw = analysis(p), c = raw.criteria.coverage, source = buildRegistry(p).entries.find(e => e.kind === 'source');
  c.assessment = 'CONTRADICTS'; for (const kind of KINDS) c.observations[kind] = [];
  c.findings = [{ severity: 'ERROR', file: source.file, message: 'The fixture caller bypasses a required guard.', root_cause: 'The guard runs only after data is consumed.', required_fix: 'Move validation before the consume call.', evidence_ids: [source.id] }];
  const review = evaluateReview(p, raw);
  assert.equal(review.result.status, 'FAIL'); assert.equal(review.result.findings[0].message, c.findings[0].message);
  assert.equal(review.result.root_causes[0].explanation, c.findings[0].root_cause);
  assert.equal(review.result.required_fixes[0].action, c.findings[0].required_fix);
  assert.deepEqual(review.evidence_ids, [source.id]); validateResult(review.result, p);
  c.assessment = 'SUPPORTS';
  assert.equal(evaluateReview(p, raw).result.status, 'FAIL', 'A positive assessment cannot override an explicit error finding');
});

test('v2 unsupported contradiction remains unknown and needs a counterexample', () => {
  const p = packet(), raw = analysis(p); raw.criteria.coverage.assessment = 'CONTRADICTS';
  const review = evaluateReview(p, raw);
  assert.equal(review.result.status, 'CHUA_XAC_MINH');
  assert.ok(review.missing_evidence.includes('coverage:counterexample-and-root-cause'));
});

test('v2 genuine error stays failed when another criterion has no evidence', () => {
  const p = packet();
  p.criteria.push({ id: 'second', requirement: 'Verify a separately required runtime claim.', evidenceKinds: ['runtime'] });
  const raw = analysis(p), source = buildRegistry(p).entries.find(e => e.kind === 'source');
  raw.criteria.coverage.assessment = 'CONTRADICTS';
  raw.criteria.coverage.findings.push({ severity: 'ERROR', file: source.file, message: 'The caller consumes unvalidated input.', root_cause: 'Validation occurs after consumption.', required_fix: 'Validate before consuming input.', evidence_ids: [source.id] });
  raw.criteria.second.assessment = 'UNKNOWN'; raw.criteria.second.observations.runtime = [];
  const result = evaluateReview(p, raw);
  assert.equal(result.result.status, 'FAIL');
  assert.ok(result.result.findings.some(f => f.severity === 'ERROR' && f.message === 'The caller consumes unvalidated input.'));
  assert.ok(result.missing_evidence.includes('second:runtime'));
  assert.equal(result.analysis.criteria.second.assessment, 'UNKNOWN');
});

test('v2 duplicate selections and requirement echoes cannot stand in for analysis', () => {
  const p = packet(), duplicate = analysis(p); duplicate.criteria.coverage.observations.source.push(duplicate.criteria.coverage.observations.source[0]);
  assert.throws(() => evaluateReview(p, duplicate), /INVALID_AUDIT_OBSERVATION/);
  const reason = analysis(p); reason.criteria.coverage.reason = p.criteria[0].requirement;
  assert.throws(() => evaluateReview(p, reason), /INVALID_CRITERION_ANALYSIS/);
  const explanation = analysis(p); explanation.criteria.coverage.observations.source[0].explanation = p.criteria[0].requirement;
  assert.throws(() => evaluateReview(p, explanation), /INVALID_AUDIT_OBSERVATION/);
});

test('v2 unsupported or uncovered obligations cannot be accepted', () => {
  assert.equal(verifyObligations(packet()).status, 'CHUA_XAC_MINH');
  const altered = proofPacket(); altered.criteria[0].requirement += ' Model grants exemption.';
  assert.deepEqual(verifyObligations(altered).missing_evidence, ['UNREGISTERED_CRITERION_POLICY']);
  const missing = proofPacket(); missing.documents = missing.documents.filter(d => d.kind !== 'runtime');
  assert.deepEqual(verifyObligations(missing).missing_evidence, ['RUNTIME_RECEIPT_REQUIRED']);
  const absent = proofPacket(); editRuntime(absent, r => { r.output = 'TAP version 13\nok 1 - Unrelated passing check\n1..1'; });
  const result = verifyObligations(absent);
  assert.equal(result.status, 'CHUA_XAC_MINH'); assert.ok(result.outcomes.length > 0);
  assert.ok(result.outcomes.every(o => o.status === 'UNKNOWN')); assert.ok(result.missing_evidence.length > 0);
});

test('v2 registered proof policy rejects wrong omitted extra and duplicate source files', () => {
  for (const mutate of [
    p => { p.documents.find(d => d.kind === 'source').file = 'services/unrelated.cjs'; },
    p => { p.documents = p.documents.filter(d => d.id !== 'source-1'); },
    p => { p.documents.push({ ...p.documents[0], id: 'source-extra', file: 'services/additional.cjs' }); },
    p => { p.documents.push({ ...p.documents[0], id: 'source-duplicate' }); }
  ]) {
    const p = proofPacket(); mutate(p);
    const result = verifyObligations(p);
    assert.equal(result.status, 'CHUA_XAC_MINH');
    assert.ok(result.missing_evidence.includes('PROFILE_SOURCE_SET_MISMATCH'));
  }
});

test('v2 fixed obligations consume exact actual TAP records and preserve failed proofs', () => {
  const p = proofPacket();
  const positive = verifyObligations(p);
  assert.equal(positive.status, 'PASS'); // Parser fixture only; not a collected or accepted receipt.
  assert.ok(positive.outcomes.every(o => o.status === 'SATISFIED'));
  editRuntime(p, r => { r.output = r.output.replace('ok 1 - ', 'not ok 1 - '); r.exitCode = 1; });
  const failure = verifyObligations(p);
  assert.equal(failure.status, 'FAIL'); assert.equal(failure.outcomes[0].status, 'FAILED');
});

test('v2 runtime check identity digest and success are required for obligations', () => {
  const wrongCheck = proofPacket(); editRuntime(wrongCheck, r => { r.check = 'unapproved-command'; });
  assert.deepEqual(verifyObligations(wrongCheck).missing_evidence, ['RUNTIME_PROOF_BINDING_INVALID']);
  const wrongHash = proofPacket(), doc = wrongHash.documents.find(d => d.kind === 'runtime'), runtime = JSON.parse(doc.content);
  runtime.outputSha256 = sha256('different output'); writeRuntime(wrongHash, runtime);
  assert.deepEqual(verifyObligations(wrongHash).missing_evidence, ['RUNTIME_PROOF_BINDING_INVALID']);
  for (const mutate of [r => { r.exitCode = 1; }, r => { r.problem = 'PROCESS_TIMED_OUT'; }]) {
    const p = proofPacket(); editRuntime(p, mutate);
    const result = verifyObligations(p); assert.notEqual(result.status, 'PASS'); assert.ok(result.missing_evidence.includes('RUNTIME_CHECK_UNSUCCESSFUL'));
  }
});

test('v2 skipped duplicate nested and diagnostic TAP lines cannot satisfy obligations', () => {
  const name = 'Exact proof name';
  for (const output of [`ok 1 - ${name} # SKIP unavailable`, `ok 1 - ${name} # TODO pending`, `ok 1 - ${name}\nok 2 - ${name}`]) {
    assert.equal(parseTests(output).get(name), 'UNKNOWN');
  }
  assert.equal(parseTests(`    ok 1 - ${name}\n# ok 1 - ${name}\nmessage: ok 1 - ${name}`).has(name), false);
  const p = proofPacket(); editRuntime(p, r => { r.output = r.output.replace(/^(ok 1 - .+)$/m, '$1 # SKIP missing dependency'); });
  assert.equal(verifyObligations(p).status, 'CHUA_XAC_MINH');
});

test('v2 criterion views retain parent registry identity full source and declared exclusions', () => {
  const p = viewPacket(), before = canonical(p), parent = buildRegistry(p);
  const allSeenSources = new Set();
  for (const c of p.criteria) {
    const view = criterionView(p, c.id), rendered = renderView(p, c.id);
    assert.equal(view.registry_hash, parent.registry_hash); assert.equal(view.manifest.packet_hash, parent.packet_hash);
    assert.deepEqual(view.manifest.allowed_evidence_ids, view.entries.map(e => e.id));
    for (const entry of view.entries) assert.deepEqual(entry, parent.entries.find(e => e.id === entry.id));
    for (const doc of p.documents.filter(d => d.kind === 'source')) {
      assert.ok(view.documents.some(d => d.id === doc.id)); allSeenSources.add(doc.id);
      for (const line of doc.content.split('\n')) assert.ok(rendered.includes(line), 'Caller/callee source cannot be silently truncated');
    }
    const architecture = p.documents.find(d => d.file === 'docs/JEV-AUDITOR.md');
    assert.ok(view.documents.some(d => d.id === architecture.id));
    for (const line of architecture.content.split('\n')) assert.ok(rendered.includes(line));
    const declared = [...view.manifest.included, ...view.manifest.excluded];
    assert.deepEqual(declared.map(d => d.id).sort(), p.documents.map(d => d.id).sort());
    for (const exclusion of view.manifest.excluded) {
      assert.equal(exclusion.sha256, p.documents.find(d => d.id === exclusion.id).sha256);
      assert.ok(exclusion.reason.trim()); assert.ok(rendered.includes(exclusion.file));
    }
    assert.ok(view.manifest.excluded.some(d => d.id === 'diff'));
    assert.ok(view.manifest.excluded.some(d => d.id === 'autonomy'));
  }
  assert.equal(allSeenSources.size, p.documents.filter(d => d.kind === 'source').length);
  assert.equal(canonical(p), before);
});

test('v2 view runtime enum includes required pass and fail records but excludes metadata and other criteria', () => {
  const p = viewPacket();
  editRuntime(p, r => { r.output = r.output.replace('ok 1 - ', 'not ok 1 - ') + '\n  ---\n  error: Actual failed verifier diagnostic remains visible\n  ...'; r.exitCode = 1; });
  const parent = buildRegistry(p), view = criterionView(p, 'contract'), runtime = view.entries.filter(e => e.kind === 'runtime');
  assert.ok(runtime.some(e => e.quote.startsWith('not ok 1 - ')));
  assert.ok(runtime.some(e => e.quote.startsWith('ok 2 - ')));
  assert.ok(runtime.every(e => e.anchor.startsWith('R')));
  for (const name of OBLIGATIONS.contract) assert.ok(runtime.some(e => e.quote.endsWith(name)));
  for (const name of OBLIGATIONS.secrets) assert.ok(!runtime.some(e => e.quote.endsWith(name)));
  const schema = schemaFor(p, ['contract']);
  assert.deepEqual(schema.properties.criteria.required, ['contract']);
  assert.deepEqual(schema.properties.criteria.properties.contract.properties.observations.properties.runtime.items.properties.evidence_id.enum, runtime.map(e => e.id));
  const rendered = renderView(p, 'contract');
  assert.ok(rendered.includes('Actual failed verifier diagnostic remains visible'));
  assert.ok(rendered.includes('RUNTIME METADATA (not a verifier result)'));
  for (const name of OBLIGATIONS.secrets) assert.ok(rendered.includes(name), 'Unselected verifier logs remain visible context');
  const other = parent.entries.find(e => e.kind === 'runtime' && e.anchor.startsWith('R') && e.quote.endsWith(OBLIGATIONS.secrets[0]));
  assert.ok(!rendered.includes('[' + other.id + ']'));
  const raw = viewAnalysis(p); raw.criteria.contract.observations.runtime[0].evidence_id = other.id;
  assert.throws(() => evaluateReview(p, raw), /INVALID_CRITERION_EVIDENCE/);
});

test('v2 partial criterion analysis cannot satisfy the complete review contract', () => {
  const p = viewPacket(), raw = viewAnalysis(p), partial = { criteria: { contract: raw.criteria.contract } };
  const projected = evaluateReview(p, partial, ['contract']);
  assert.equal(projected.result.status, 'PASS'); // Only the explicitly requested partial projection.
  assert.equal(projected.registry_hash, buildRegistry(p).registry_hash);
  assert.throws(() => evaluateReview(p, partial), /INVALID_REVIEW_SCHEMA/);
  for (const ids of [[], ['contract', 'contract'], ['nonexistent']]) assert.throws(() => evaluateReview(p, partial, ids), /INVALID_REVIEW_SCHEMA/);
  assert.throws(() => criterionView(p, 'nonexistent'), /INVALID_CRITERION_VIEW/);
});

test('v2 findings require evidence from their actual target file', () => {
  const p = viewPacket(), raw = viewAnalysis(p), source = buildRegistry(p).entries.filter(e => e.kind === 'source');
  raw.criteria.secrets.assessment = 'CONTRADICTS';
  raw.criteria.secrets.findings = [{ severity: 'ERROR', file: source.find(e => e.document_id === 'source-1').file, message: 'The target fixture omits validation.', root_cause: 'A guard is absent from the inspected target.', required_fix: 'Validate the target before consumption.', evidence_ids: [source.find(e => e.document_id === 'source-0').id] }];
  assert.throws(() => evaluateReview(p, raw), /INVALID_FINDING_TARGET_EVIDENCE/);
  raw.criteria.secrets.findings[0].evidence_ids = [source.find(e => e.document_id === 'source-1').id];
  assert.equal(evaluateReview(p, raw).result.status, 'FAIL');
});

test('v2 criterion reviewer stops on genuine ERROR and never retries it into support', async () => {
  const p = viewPacket(), raw = viewAnalysis(p), source = criterionView(p, 'contract').entries.find(e => e.kind === 'source');
  raw.criteria.contract.findings = [{ severity: 'ERROR', file: source.file, message: 'Concrete source counterexample blocks this fixture.', root_cause: 'The inspected branch bypasses a required guard.', required_fix: 'Validate before this branch executes.', evidence_ids: [source.id] }];
  let requests = 0, retryCalls = 0;
  const reviewer = new OllamaReviewer({ fetcher: async (_url, options) => {
    requests++;
    const body = JSON.parse(options.body);
    assert.deepEqual(body.format.properties.criteria.required, ['contract']);
    return new Response(JSON.stringify({ done: true, done_reason: 'stop', model: 'qwen3:14b', message: { role: 'assistant', content: JSON.stringify({ criteria: { contract: raw.criteria.contract } }) } }));
  } });
  const retry = { model: 'qwen3:14b', async review() { retryCalls++; throw Error('UNEXPECTED_RETRY'); } };
  const result = await new JevAuditor({ reviewer, escalationReviewer: retry }).audit(p);
  assert.equal(requests, 1); assert.equal(retryCalls, 0); assert.equal(result.status, 'FAIL');
  assert.equal(result.analysis.criteria.contract.assessment, 'SUPPORTS');
  assert.ok(result.findings.some(f => f.severity === 'ERROR' && f.message === 'Concrete source counterexample blocks this fixture.'));
  assert.equal(result.analysis.criteria.secrets.assessment, 'UNKNOWN');
  assert.deepEqual(result.analysis.criteria.secrets.observations, { source: [], runtime: [] });
  assert.deepEqual(result.source.attempts[0].notReviewedCriteria, ['secrets']);
  assert.equal(result.source.attempts[0].views.length, 1);
});

test('v2 attribution bundle preserves exact selected quotes claims and overview under one immutable hash', () => {
  const p = packet(), raw = analysis(p), before = canonical({ p, raw }), input = buildAttributionInput(p, raw, 'coverage'), registry = buildRegistry(p);
  assert.equal(input.packet_hash, registry.packet_hash); assert.equal(input.registry_hash, registry.registry_hash);
  assert.equal(input.requirement, p.criteria[0].requirement); assert.equal(input.overview.statement, raw.criteria.coverage.reason);
  assert.deepEqual(input.overview.evidence_ids, input.observations.map(o => o.evidence_id));
  for (const observation of input.observations) {
    const entry = registry.entries.find(e => e.id === observation.evidence_id);
    assert.equal(observation.quote, entry.quote); assert.equal(observation.file, entry.file); assert.equal(observation.document_id, entry.document_id);
    assert.equal(observation.explanation, raw.criteria.coverage.observations[entry.kind][0].explanation);
    assert.ok(Object.isFrozen(observation));
  }
  const { bundle_hash, ...contents } = input;
  assert.equal(bundle_hash, sha256(canonical(contents))); assert.ok(Object.isFrozen(input)); assert.ok(Object.isFrozen(input.overview.evidence_ids));
  assert.equal(canonical({ p, raw }), before);
});

test('v2 attribution schema requires original criterion hash overview and every exact evidence ID', () => {
  const p = packet(), input = buildAttributionInput(p, analysis(p), 'coverage'), schema = attributionSchema(input);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['criterion_id', 'bundle_hash', 'overview', 'observations']);
  assert.deepEqual(schema.properties.criterion_id.enum, ['coverage']); assert.deepEqual(schema.properties.bundle_hash.enum, [input.bundle_hash]);
  assert.deepEqual(schema.properties.observations.required, input.observations.map(o => o.evidence_id));
  assert.equal(schema.properties.observations.additionalProperties, false);
  assert.deepEqual(schema.properties.overview.properties.relation.enum, ['SUPPORTED', 'CONTRADICTED', 'UNKNOWN']);
  assert.equal(Object.hasOwn(schema.properties, 'status'), false);
  schema.properties.overview.properties.relation.enum.push('PASS');
  assert.deepEqual(attributionSchema(input).properties.overview.properties.relation.enum, ['SUPPORTED', 'CONTRADICTED', 'UNKNOWN']);
});

test('v2 attribution rejects wrong hashes invented IDs incomplete coverage and model acceptance fields', () => {
  const p = packet(), input = buildAttributionInput(p, analysis(p), 'coverage');
  for (const mutate of [r => { r.criterion_id = 'foreign'; }, r => { r.bundle_hash = '0'.repeat(64); }, r => { r.status = 'PASS'; }, r => { delete r.overview; }]) {
    const raw = attributionReply(input); mutate(raw);
    assert.throws(() => validateAttribution(input, raw), /INVALID_ATTRIBUTION_REVIEW/);
  }
  for (const mutate of [r => { delete r.observations[input.observations[0].evidence_id]; }, r => { r.observations.invented = { relation: 'SUPPORTED', reason: 'Invented reference.' }; }]) {
    const raw = attributionReply(input); mutate(raw);
    assert.throws(() => validateAttribution(input, raw), /INCOMPLETE_ATTRIBUTION_COVERAGE/);
  }
  for (const mutate of [r => { r.overview.relation = 'PASS'; }, r => { r.overview.reason = ' '; }, r => { r.overview.probability = 1; }]) {
    const raw = attributionReply(input); mutate(raw);
    assert.throws(() => validateAttribution(input, raw), /INVALID_ATTRIBUTION_RELATION/);
  }
  const changed = structuredClone(input); changed.observations[0].quote += ' Tampered.';
  assert.throws(() => validateAttribution(changed, attributionReply(changed)), /INVALID_ATTRIBUTION_BUNDLE_HASH/);
});

test('v2 attribution is veto only with UNKNOWN and contradiction dominating positive judgments', () => {
  const p = packet(), input = buildAttributionInput(p, analysis(p), 'coverage'), raw = attributionReply(input), id = input.observations[0].evidence_id;
  const support = validateAttribution(input, raw);
  assert.equal(support.status, 'SUPPORTED'); assert.notEqual(support.status, 'PASS');
  assert.equal(support.proof_hash, sha256(canonical(raw)));
  raw.overview.relation = 'UNKNOWN'; assert.equal(validateAttribution(input, raw).status, 'UNKNOWN'); raw.overview.relation = 'SUPPORTED';
  raw.observations[id].relation = 'UNKNOWN'; assert.equal(validateAttribution(input, raw).status, 'UNKNOWN');
  raw.observations[id].relation = 'CONTRADICTED'; raw.overview.relation = 'UNKNOWN';
  assert.equal(validateAttribution(input, raw).status, 'CONTRADICTED');
  raw.observations[id].relation = 'SUPPORTED'; raw.overview.relation = 'CONTRADICTED';
  assert.equal(validateAttribution(input, raw).status, 'CONTRADICTED', 'Unsupported overview claims must also veto');
  assert.equal(support.observations[id].relation, 'SUPPORTED', 'Returned proof must not share mutable reviewer objects');
});

test('v2 attribution never upgrades primary unknown contradiction or genuine ERROR', () => {
  const p = packet();
  for (const assessment of ['UNKNOWN', 'CONTRADICTS']) {
    const raw = analysis(p); raw.criteria.coverage.assessment = assessment;
    assert.throws(() => buildAttributionInput(p, raw, 'coverage'), /ATTRIBUTION_REQUIRES_POSITIVE_ANALYSIS/);
  }
  const raw = analysis(p), source = buildRegistry(p).entries.find(e => e.kind === 'source');
  raw.criteria.coverage.findings = [{ severity: 'ERROR', file: source.file, message: 'A genuine error exists in the source.', root_cause: 'The guard is missing in this inspected branch.', required_fix: 'Add the missing guard.', evidence_ids: [source.id] }];
  assert.throws(() => buildAttributionInput(p, raw, 'coverage'), /ATTRIBUTION_REQUIRES_POSITIVE_ANALYSIS/);
});

test('v2 attribution receipt must match recomputed current packet analysis and 14B reviewer identity', () => {
  const p = packet(), raw = analysis(p), input = buildAttributionInput(p, raw, 'coverage'), parts = attributionParts(input).map(part => ({ model: 'qwen3:14b', input: part, review: { input_hash: part.input_hash, relation: 'SUPPORTED', reason: 'Synthetic isolated protocol judgment.' } })), receipt = { model: 'qwen3:14b', review: assembleAttribution(input, parts), parts };
  assert.equal(assertAttribution(p, raw, 'coverage', receipt).status, 'SUPPORTED');
  assert.throws(() => assertAttribution(p, raw, 'coverage', { ...receipt, model: 'qwen3:8b' }), /INVALID_ATTRIBUTION_REVIEWER/);
  assert.throws(() => assertAttribution(p, raw, 'coverage', { ...receipt, status: 'PASS' }), /INVALID_ATTRIBUTION_REVIEWER/);
  const differentClaim = structuredClone(raw); differentClaim.criteria.coverage.observations.source[0].explanation += ' Changed claim.';
  assert.throws(() => assertAttribution(p, differentClaim, 'coverage', receipt), /INVALID_ATTRIBUTION_PART_BINDING/);
  const differentOverview = structuredClone(raw); differentOverview.criteria.coverage.reason += ' All branches have 100% coverage.';
  assert.throws(() => assertAttribution(p, differentOverview, 'coverage', receipt), /INVALID_ATTRIBUTION_PART_BINDING/);
  const other = packet(); other.scope += '-different';
  assert.throws(() => assertAttribution(other, analysis(other), 'coverage', receipt), /INVALID_ATTRIBUTION_PART_BINDING/);
});

test('v2 actual revoked-receipt counterexamples reach attribution unchanged and retain a semantic veto', () => {
  // Verbatim claim/quote relationships from real rejected/revoked receipts.
  // The judgments below are protocol fixtures, NOT actual semantic-model proof.
  const cases = [
    { receipt: '6b410dfd-0c95-4433-b5db-70958345a48a', quote: "const id = value => typeof value === 'string' && /^[a-zA-Z0-9._:/-]{1,160}$/.test(value);", explanation: 'validateResult ensures criteria coverage via seen.size !== criteria.size and rejects missing/unknown references through exact(result, Object.keys(RESULT_SCHEMA.properties)) and refs/values checks.' },
    { receipt: '6b410dfd-0c95-4433-b5db-70958345a48a', quote: "  for (const cause of result.root_causes) if (!exact(cause, ['finding_id', 'explanation', 'evidence_ids']) || !findings.has(cause.finding_id) || !text(cause.explanation) || !refs(cause.evidence_ids)) fail('INVALID_ROOT_CAUSE');", explanation: 'The regex /api_key\\s*[:=]\\s*([A-Za-z0-9_~+\\/\\-]{16,})/ matches unquoted API keys with 16+ characters, fulfilling the requirement to reject unquoted credentials.' },
    { receipt: 'c376210a-188c-4fd2-8df9-d645d27883e7', quote: '        answer = await reviewer.review(freeze(structuredClone(packet)), { previousError });', explanation: 'Verifies model identity by rejecting responses with mismatched provider/model/protocol attributes.' }
  ];
  for (const calibration of cases) {
    const p = packet(); setContent(p.documents[0], calibration.quote);
    const raw = analysis(p); raw.criteria.coverage.observations.source[0].explanation = calibration.explanation;
    const input = buildAttributionInput(p, raw, 'coverage'), observation = input.observations.find(o => o.kind === 'source');
    assert.equal(observation.quote, calibration.quote, calibration.receipt); assert.equal(observation.explanation, calibration.explanation, calibration.receipt);
    const veto = attributionReply(input); veto.observations[observation.evidence_id] = { relation: 'UNKNOWN', reason: 'The selected exact quote does not establish this claimed behavior.' };
    assert.equal(validateAttribution(input, veto).status, 'UNKNOWN', calibration.receipt);
  }
});


test('v2 attribution isolated parts bind exact observation inputs and complete immutable assembly', () => {
  const p = packet(), raw = analysis(p), input = buildAttributionInput(p, raw, 'coverage'), inputs = attributionParts(input);
  assert.equal(inputs.length, input.observations.length + 1);
  inputs.slice(0, -1).forEach((part, index) => {
    assert.equal(part.kind, 'observation');
    assert.equal(part.quote, input.observations[index].quote);
    assert.equal(part.explanation, input.observations[index].explanation);
    assert.equal(Object.hasOwn(part, 'observations'), false, 'Other claims must not enter isolated observation context');
    const { input_hash, ...contents } = part; assert.equal(input_hash, sha256(canonical(contents)));
  });
  assert.equal(inputs.at(-1).kind, 'overview');
  const parts = inputs.map(part => ({ model: 'qwen3:14b', input: part, review: { input_hash: part.input_hash, relation: 'SUPPORTED', reason: 'Protocol isolation fixture.' } }));
  for (const mutate of [
    ps => { ps.pop(); }, ps => { ps.push(ps[0]); },
    ps => { ps[0].model = 'qwen3:8b'; },
    ps => { ps[0].input.quote += ' changed'; },
    ps => { ps[0].review.input_hash = '0'.repeat(64); },
    ps => { [ps[0], ps[1]] = [ps[1], ps[0]]; },
    ps => { ps[0].review.status = 'PASS'; }
  ]) {
    const altered = structuredClone(parts); mutate(altered);
    assert.throws(() => assembleAttribution(input, altered), /ATTRIBUTION_/);
  }
  const receipt = { model: 'qwen3:14b', parts, review: assembleAttribution(input, parts) };
  receipt.review.observations[input.observations[0].evidence_id].reason += ' replaced';
  assert.throws(() => assertAttribution(p, raw, 'coverage', receipt), /INVALID_ATTRIBUTION_ASSEMBLY/);
});


test('v2 incomplete source headers remain findings evidence but cannot support positive observations', () => {
  const p = packet(); p.documents[0].file = 'tests/fixtures/guard.cjs';
  setContent(p.documents[0], "for (const value of values) {\n  consume(value);\n}");
  const view = criterionView(p, 'coverage'), header = view.entries.find(e => e.kind === 'source' && e.quote.startsWith('for ('));
  assert.ok(header, 'The source header remains in the original criterion view');
  const schema = readbackSchema(p).properties.criteria.properties.coverage;
  assert.ok(schema.properties.findings.items.properties.evidence_ids.items.enum.includes(header.id), 'Criticism may cite incomplete source context');
  assert.ok(!schema.properties.observations.properties.source.items.oneOf.some(branch => branch.properties.evidence_id.const === header.id));
  const raw = analysis(p), entries = new Map(buildRegistry(p).entries.map(e => [e.id, e]));
  for (const [kind, observations] of Object.entries(raw.criteria.coverage.observations)) for (const observation of observations) {
    const entry = entries.get(observation.evidence_id); observation.quote = entry.quote;
    if (kind === 'runtime') observation.explanation = runtimeExplanation(entry);
  }
  assert.equal(raw.criteria.coverage.observations.source[0].evidence_id, header.id);
  assert.throws(() => decodeReadback(p, raw), /INVALID_INCOMPLETE_SOURCE_OBSERVATION/);
  raw.criteria.coverage.assessment = 'CONTRADICTS';
  raw.criteria.coverage.findings = [{ severity: 'ERROR', file: header.file, message: 'The selected loop requires missing caller evidence.', root_cause: 'Loop inputs have no supplied provenance.', required_fix: 'Supply the caller evidence.', evidence_ids: [header.id] }];
  assert.equal(decodeReadback(p, raw).projected.result.status, 'FAIL', 'A negative finding is not discarded by observation eligibility');
});
