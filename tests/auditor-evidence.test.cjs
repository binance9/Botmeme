'use strict';
// Real filesystem/registry protocol checks. Synthetic review receipts below are
// isolated fixtures, not model reviews or actual module acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { sha256, canonical, KINDS } = require('../services/jev/auditor/contract.cjs');
const { buildRegistry } = require('../services/jev/auditor/evidence-registry.cjs');
const { criterionView } = require('../services/jev/auditor/views.cjs');
const { OBLIGATIONS, verifyObligations } = require('../services/jev/auditor/proofs.cjs');
const { profiles } = require('../services/jev/auditor/profiles.cjs');
const { ROOT, CHECKS, readInside, unchanged, document, runCheck, collect } = require('../services/jev/auditor/evidence.cjs');
const { describeDiff, lineHunks } = require('../services/jev/auditor/diff.cjs');
const { graph } = require('../services/jev/auditor/dependencies.cjs');
const { policyRevision } = require('../services/jev/auditor/history.cjs');
const { evaluateReview } = require('../services/jev/auditor/evaluation.cjs');
const { buildAttributionInput, validateAttribution, attributionParts } = require('../services/jev/auditor/attribution.cjs');
const { runtimeExplanation } = require('../services/jev/auditor/readback.cjs');
// Positive acceptance fixtures execute byte-identical copies of the official
// implementation under a temporary project root. No production root override.
const { invoke } = require('./auditor-fixture.cjs');
const receiptRoot = file => JSON.parse(fs.readFileSync(file, 'utf8')).binding.root;
const recordAudit = f => invoke(f.binding.root, 'recordAudit', f);
const recordOutcome = f => invoke(f.binding.root, 'recordOutcome', f);
const assertFrozen = (file, packet) => invoke(receiptRoot(file), 'assertFrozen', { file, packet });
const revokeAudit = (file, evidence) => invoke(receiptRoot(file), 'revokeAudit', { file, evidence });
const decide = (packet, result, binding) => invoke(binding.root, 'decide', { packet, result, binding });

function refreshAttributions(f) {
  const byId = new Map(buildRegistry(f.packet).entries.map(e => [e.id, e]));
  const attempt = f.result.source.attempts.at(-1);
  attempt.readback_protocol = 'evidence-readback/1';
  attempt.readbacks = f.packet.criteria.map(c => {
    const raw = { criteria: { [c.id]: structuredClone(f.result.analysis.criteria[c.id]) } };
    for (const list of Object.values(raw.criteria[c.id].observations)) {
      for (const observation of list) observation.quote = byId.get(observation.evidence_id)?.quote;
    }
    return raw;
  });
  // Explicit synthetic protocol relations, never an independent critic verdict.
  f.result.source.attempts.at(-1).attributions = f.packet.criteria.flatMap(criterion => {
    const partial = { criteria: { [criterion.id]: f.result.analysis.criteria[criterion.id] } };
    if (evaluateReview(f.packet, partial, [criterion.id]).result.status !== 'PASS') return [];
    const input = buildAttributionInput(f.packet, partial, criterion.id);
    const relation = () => ({ relation: 'SUPPORTED', reason: 'Synthetic protocol relation fixture tests immutable attribution binding only; no model review is claimed.' });
    const review = { criterion_id: criterion.id, bundle_hash: input.bundle_hash, overview: relation(), observations: Object.fromEntries(input.observations.map(item => [item.evidence_id, relation()])) };
    assert.equal(validateAttribution(input, review).status, 'SUPPORTED');
    const parts = attributionParts(input).map(part => ({ model: 'qwen3:14b', input: part, review: { input_hash: part.input_hash, ...(part.kind === 'overview' ? review.overview : review.observations[part.evidence_id]) } }));
    return [{ model: 'qwen3:14b', review, parts }];
  });
  return f;
}

function refreshReview(f) {
  f.result.packetHash = sha256(canonical(f.packet));
  const views = f.packet.criteria.map(c => criterionView(f.packet, c.id));
  f.result.source.attempts.at(-1).views = views.map(view => view.manifest);
  f.result.analysis = { criteria: Object.fromEntries(views.map(({ criterion: c, entries }) => [c.id, {
    assessment: 'SUPPORTS', reason: 'Protocol fixture supplies bound source and successful named verifier records.',
    observations: Object.fromEntries(c.evidenceKinds.map(kind => {
      const entry = entries.find(e => e.kind === kind);
      return [kind, entry ? [{ evidence_id: entry.id, explanation: kind === 'runtime' ? runtimeExplanation(entry) : `The ${kind} record is selected from this criterion view of the packet registry for the protocol fixture.` }] : []];
    })),
    findings: [], missing_evidence: []
  }])) };
  return refreshAttributions(f);
}

function recordProtocolFailure(f) {
  const failed = structuredClone(f), id = randomUUID();
  failed.result.id = id; failed.result.receipt_id = id; failed.result.status = 'FAIL';
  const criterion = failed.result.analysis.criteria.contract;
  criterion.assessment = 'CONTRADICTS';
  criterion.findings = [{
    severity: 'ERROR', file: failed.packet.documents.find(d => d.kind === 'source').file,
    message: 'The protocol review records an unresolved contract counterexample.',
    root_cause: 'This synthetic protocol failure remains unresolved for the captured source revision.',
    required_fix: 'Resolve the counterexample and collect a new source revision before re-review.',
    evidence_ids: [criterion.observations.source[0].evidence_id]
  }];
  refreshAttributions(failed);
  const outcome = recordAudit(failed);
  assert.equal(outcome.result.status, 'FAIL'); assert.equal(outcome.frozen, false);
  assert.ok(outcome.result.findings.some(finding => finding.severity === 'ERROR'));
  return outcome;
}

function fixture(t, { exitCode = 0, problem = null, unresolved = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botmeme-audit-protocol-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(ROOT, 'services/jev/auditor'), path.join(root, 'services/jev/auditor'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'node_modules/acorn'), path.join(root, 'node_modules/acorn'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'));
  fs.copyFileSync(path.join(ROOT, 'tests/auditor-fixture.cjs'), path.join(root, 'tests/auditor-fixture.cjs'));
  const source = "'use strict';\nmodule.exports = require('./dep.cjs');\n", dep = 'module.exports = 7;\n';
  fs.writeFileSync(path.join(root, 'main.cjs'), source);
  fs.writeFileSync(path.join(root, 'dep.cjs'), dep);
  const protectedFiles = [
    ['architecture.md', 'Bounded protocol fixture.'],
    ['rules.cjs', 'module.exports = { version: 1 };'],
    ['check.cjs', 'process.exitCode = 0;'],
    ['transitive.cjs', 'module.exports = 11;']
  ].map(([file, content]) => { fs.writeFileSync(path.join(root, file), content); return { root, file, sha256: sha256(content) }; });
  const profile = profiles['auditor-contract'];
  const sources = profile.files.map((file, index) => document('source-' + index, 'source', file, fs.readFileSync(path.join(root, file), 'utf8')));
  const sourceHashes = sources.map(({ file, sha256 }) => ({ file, sha256 }));
  const sourceDigest = sha256(canonical(sourceHashes));
  const protectedDigest = sha256(canonical(protectedFiles));
  const dependency = { sourceDigest, protectedDigest, entrypoints: ['main.cjs'], unresolved, imports: [{ file: 'main.cjs', imports: ['./dep.cjs'], resolved: [{ spec: './dep.cjs', file: 'dep.cjs', sha256: sha256(dep) }] }] };
  // Synthetic TAP input tests parsing and binding only; this fixture does not
  // claim these verifiers or a model reviewed the copied implementation.
  const output = ['TAP version 13', ...profile.criteria.flatMap(c => OBLIGATIONS[c.id]).map((name, index) => `ok ${index + 1} - ${name}`)].join('\n');
  const runtime = { check: profile.check, command: [process.execPath, '--test-reporter=tap', ...CHECKS[profile.check]], cwd: root, exitCode, problem, sourceDigest, protectedDigest, output, outputSha256: sha256(output) };
  const packet = {
    scope: profile.scope, criteria: structuredClone(profile.criteria),
    documents: [...sources, document('diff', 'diff', 'diff.json', '{"baseline":null}'), document('architecture', 'architecture', 'architecture.md', 'Bounded protocol fixture.'), document('runtime', 'runtime', 'runtime.json', canonical(runtime)), document('dependency', 'dependency', 'dependency.json', canonical(dependency))]
  };
  const result = { id: randomUUID(), producer: 'JEV_AUDITOR', source: { kind: 'internal-review-agent', attempts: [{ provider: 'ollama-local', model: 'qwen3:14b', result: 'VALID_STRUCTURED_REVIEW', protocol: 'evidence-first/2' }] }, packetHash: sha256(canonical(packet)), scope: packet.scope, status: 'PASS' };
  result.receipt_id = result.id;
  const binding = { root, files: [...profile.files], sourceDigest, protectedDigest, sourceHashes, dependency, check: profile.check, protectedFiles, runtimeDigest: sha256(canonical(runtime)), packetHash: sha256(canonical(packet)) };
  binding.policyRevision = policyRevision(packet, binding);
  return refreshReview({ root, directory: path.join(root, 'data/audits'), packet, result, binding });
}

function collectionFixture(t) {
  const f = fixture(t);
  for (const file of ['package.json', 'package-lock.json', 'docs/JEV-AUDITOR.md', 'docs/AUTONOMOUS-INTELLIGENCE.md', 'tests/auditor.test.cjs']) {
    fs.mkdirSync(path.dirname(path.join(f.root, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(f.root, file));
  }
  return f;
}

function collectedRevision(f, baselineFile = null) {
  const profile = profiles['auditor-contract'];
  const captured = invoke(f.root, 'collect', { ...profile, architecture: readInside(f.root, 'docs/JEV-AUDITOR.md'), baselineFile });
  assert.equal(JSON.parse(captured.packet.documents.find(doc => doc.kind === 'runtime').content).exitCode, 0, 'Actual fixed verifier checks must succeed in the copied project.');
  assert.equal(verifyObligations(captured.packet).status, 'PASS', 'Exit code zero alone must not mask skipped nested verifier execution.');
  assert.deepEqual(captured.binding.dependency.unresolved, []);
  const id = randomUUID();
  return refreshReview({ ...f, ...captured, result: { ...structuredClone(f.result), id, receipt_id: id, status: 'PASS' } });
}

test('readInside denies lexical traversal, absolute path and NTFS stream syntax', t => {
  const f = fixture(t);
  assert.match(readInside(f.root, 'main.cjs'), /module.exports/);
  for (const file of ['../main.cjs', '..\\main.cjs', path.join(f.root, 'main.cjs'), 'main.cjs:stream', '']) {
    assert.throws(() => readInside(f.root, file), /AUDIT_PATH_DENIED/);
  }
});

test('readInside resolves junction/symlink destinations and rejects an outside root', t => {
  const f = fixture(t), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'botmeme-audit-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'outside.cjs'), 'module.exports = 1;');
  fs.symlinkSync(outside, path.join(f.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readInside(f.root, 'escape/outside.cjs'), /AUDIT_PATH_DENIED/);
});

test('source and resolved dependency changes independently invalidate evidence', t => {
  const f = fixture(t);
  assert.equal(unchanged(f.binding), true);
  fs.appendFileSync(path.join(f.root, 'dep.cjs'), '// changed dependency');
  assert.equal(unchanged(f.binding), false);
  fs.writeFileSync(path.join(f.root, 'dep.cjs'), 'module.exports = 7;\n');
  assert.equal(unchanged(f.binding), true);
  fs.appendFileSync(path.join(f.root, f.binding.files[0]), '// changed source');
  assert.equal(unchanged(f.binding), false);
});

test('freeze rejects source and dependency changes after its original receipt', t => {
  const f = fixture(t), record = recordAudit(f);
  assert.equal(record.frozen, true);
  assert.equal(assertFrozen(record.file, f.packet), true);
  fs.appendFileSync(path.join(f.root, 'dep.cjs'), '// changed dependency');
  assert.throws(() => assertFrozen(record.file, f.packet));
});

test('receipt cannot be recorded against another scope or packet digest', t => {
  const f = fixture(t);
  f.result.scope = 'unrelated-scope';
  assert.throws(() => recordAudit(f), /AUDIT_RECEIPT_MISMATCH/);
  f.result.scope = f.packet.scope; f.result.packetHash = '0'.repeat(64);
  assert.throws(() => recordAudit(f), /AUDIT_RECEIPT_MISMATCH/);
});

test('receipt freeze requires complete unmodified criterion view manifests', t => {
  for (const alter of [
    attempt => { delete attempt.views; },
    attempt => { attempt.views.pop(); },
    attempt => { attempt.views[0].allowed_evidence_ids.push('E000000000000'); }
  ]) {
    const f = fixture(t); alter(f.result.source.attempts.at(-1));
    const derived = decide(f.packet, f.result, f.binding);
    assert.equal(derived.status, 'CHUA_XAC_MINH');
    assert.ok(derived.missing_evidence.includes('REVIEW_VIEW_COVERAGE_INCOMPLETE'));
    assert.throws(() => recordAudit(f), /PASS_CONTRADICTS_RUNTIME_OR_DEPENDENCIES/);
  }
});

test('receipt freeze rejects missing forged or foreign attribution evidence', t => {
  for (const change of [
    (f, attempt) => { delete attempt.attributions; },
    (f, attempt) => { attempt.attributions.pop(); },
    (f, attempt) => { attempt.attributions[0].review.bundle_hash = '0'.repeat(64); },
    (f, attempt) => {
      const observations = attempt.attributions[0].review.observations;
      const foreign = buildRegistry(f.packet).entries.find(entry => !Object.hasOwn(observations, entry.id));
      assert.ok(foreign, 'The foreign attribution ID must exist in the full registry but not the selected bundle.');
      const previous = Object.keys(observations)[0], relation = observations[previous];
      delete observations[previous]; observations[foreign.id] = relation;
    }
  ]) {
    const f = fixture(t); change(f, f.result.source.attempts.at(-1));
    const result = decide(f.packet, f.result, f.binding);
    assert.equal(result.status, 'CHUA_XAC_MINH');
    assert.ok(result.missing_evidence.some(item => item.startsWith('ATTRIBUTION_')));
    assert.throws(() => recordAudit(f), /PASS_CONTRADICTS_RUNTIME_OR_DEPENDENCIES/);
  }
});

test('receipt attribution veto cannot be upgraded by a supporting primary review', t => {
  for (const relation of ['CONTRADICTED', 'UNKNOWN']) {
    const f = fixture(t), primary = structuredClone(f.result.analysis);
    f.result.source.attempts.at(-1).attributions[0].review.overview.relation = relation;
    f.result.source.attempts.at(-1).attributions[0].parts.at(-1).review.relation = relation;
    const result = decide(f.packet, f.result, f.binding);
    assert.equal(result.status, 'CHUA_XAC_MINH');
    assert.ok(result.missing_evidence.includes('ATTRIBUTION_VETO:contract:' + relation));
    assert.deepEqual(result.analysis, primary);
    assert.throws(() => recordAudit(f), /PASS_CONTRADICTS_RUNTIME_OR_DEPENDENCIES/);
    const recorded = recordOutcome({ ...f, result });
    assert.equal(recorded.frozen, false); assert.equal(recorded.result.status, 'CHUA_XAC_MINH');
    assert.throws(() => assertFrozen(recorded.file, f.packet), /AUDIT_FREEZE_INVALID/);
  }
});

test('receipt freeze rejects attribution reasoning tampered after acceptance', t => {
  const f = fixture(t), accepted = recordAudit(f);
  assert.equal(assertFrozen(accepted.file, f.packet), true);
  const saved = JSON.parse(fs.readFileSync(accepted.file, 'utf8'));
  saved.result.source.attempts.at(-1).attributions[0].review.overview.reason += ' Unreviewed replacement reasoning.';
  fs.writeFileSync(accepted.file, JSON.stringify(saved));
  assert.throws(() => assertFrozen(accepted.file, f.packet), /AUDIT_FREEZE_INVALID/);
});

test('receipt final acceptance rejects an 8B-only reviewer attribution', t => {
  const f = fixture(t); f.result.source.attempts.at(-1).model = 'qwen3:8b';
  assert.throws(() => recordAudit(f), /PASS_CONTRADICTS_RUNTIME_OR_DEPENDENCIES/);
  const result = decide(f.packet, f.result, f.binding);
  assert.equal(result.status, 'CHUA_XAC_MINH');
  assert.ok(result.missing_evidence.includes('ATTRIBUTED_ANALYSIS_REQUIRED'));
});

test('receipt freeze rejects missing mismatched and tampered raw readbacks', t => {
  for (const mutate of [
    attempt => { delete attempt.readbacks; },
    attempt => { delete attempt.readback_protocol; },
    attempt => { attempt.readbacks.push(attempt.readbacks[0]); },
    attempt => { attempt.readbacks[0].criteria.contract.observations.source[0].quote += ' changed'; },
    attempt => { attempt.readbacks[0].criteria.contract.observations.source[0].explanation += ' changed'; }
  ]) {
    const f = fixture(t); mutate(f.result.source.attempts.at(-1));
    const result = decide(f.packet, f.result, f.binding);
    assert.equal(result.status, 'CHUA_XAC_MINH');
    assert.ok(result.missing_evidence.some(e => e.startsWith('READBACK_')));
    assert.throws(() => recordAudit(f), /PASS_CONTRADICTS_RUNTIME_OR_DEPENDENCIES/);
  }
  const f = fixture(t), accepted = recordAudit(f);
  assert.equal(assertFrozen(accepted.file, f.packet), true);
  const saved = JSON.parse(fs.readFileSync(accepted.file, 'utf8'));
  saved.result.source.attempts.at(-1).readbacks[0].criteria.contract.reason += ' tampered';
  fs.writeFileSync(accepted.file, JSON.stringify(saved));
  assert.throws(() => assertFrozen(accepted.file, f.packet), /AUDIT_FREEZE_INVALID/);
});

test('receipt runtime observations cannot cite metadata or another criterion verifier', t => {
  const f = fixture(t), entries = buildRegistry(f.packet).entries;
  const metadata = entries.find(e => e.kind === 'runtime' && e.anchor.startsWith('L'));
  const foreignVerifier = criterionView(f.packet, 'secrets').entries.find(e => e.kind === 'runtime');
  assert.ok(metadata && foreignVerifier);
  const permitted = new Set(criterionView(f.packet, 'contract').entries.map(e => e.id));
  for (const selection of [metadata, foreignVerifier]) {
    assert.ok(entries.some(e => e.id === selection.id), 'The attack uses a real immutable registry entry.');
    assert.equal(permitted.has(selection.id), false);
    const changed = structuredClone(f);
    changed.result.analysis.criteria.contract.observations.runtime[0].evidence_id = selection.id;
    assert.throws(() => recordAudit(changed), /INVALID_CRITERION_EVIDENCE/);
  }
});

test('freeze cannot be reused with changed criteria or architecture document', t => {
  const f = fixture(t), record = recordAudit(f);
  const changedCriteria = structuredClone(f.packet); changedCriteria.criteria[0].requirement += ' Additional rule.';
  assert.throws(() => assertFrozen(record.file, changedCriteria), /AUDIT_FREEZE_INVALID/);
  const changedArchitecture = structuredClone(f.packet), doc = changedArchitecture.documents.find(d => d.kind === 'architecture');
  doc.content += ' Additional boundary.'; doc.sha256 = sha256(doc.content);
  assert.throws(() => assertFrozen(record.file, changedArchitecture), /AUDIT_FREEZE_INVALID/);
});

test('collected packet binding rejects replacement architecture or diff despite refreshed review references', t => {
  for (const kind of ['architecture', 'diff']) {
    const f = fixture(t), originalPacketHash = f.binding.packetHash;
    const doc = f.packet.documents.find(d => d.kind === kind);
    doc.content = kind === 'diff' ? '{"baseline":null,"replacement":true}' : 'An uncollected replacement architecture policy.';
    doc.sha256 = sha256(doc.content); refreshReview(f);
    assert.equal(f.binding.packetHash, originalPacketHash, 'Refreshing review references must not rebind collected evidence.');
    const result = decide(f.packet, f.result, f.binding);
    assert.equal(result.status, 'CHUA_XAC_MINH');
    assert.ok(result.missing_evidence.includes('COLLECTED_PACKET_BINDING_MISMATCH'));
    assert.throws(() => recordAudit(f), /PASS_CONTRADICTS_RUNTIME_OR_DEPENDENCIES/);
  }
});

test('acceptance requires architecture and diff even when their kind is not a criterion observation', t => {
  for (const kind of ['architecture', 'diff']) {
    const f = fixture(t);
    f.packet.documents = f.packet.documents.filter(d => d.kind !== kind); refreshReview(f);
    // Model references alone cannot authorize altered collected packets.
    assert.throws(() => recordAudit(f), /PASS_CONTRADICTS_RUNTIME_OR_DEPENDENCIES/);
    // A freshly bound but incomplete collection must still fail the kind gate.
    f.binding.packetHash = sha256(canonical(f.packet));
    const result = decide(f.packet, f.result, f.binding);
    assert.equal(result.status, 'CHUA_XAC_MINH');
    assert.ok(result.missing_evidence.includes('MISSING_EVIDENCE_KIND:' + kind));
    assert.throws(() => recordAudit(f), /PASS_CONTRADICTS_RUNTIME_OR_DEPENDENCIES/);
  }
});

test('architecture, auditor rules, check code and transitive dependency changes invalidate a freeze', t => {
  for (const file of ['architecture.md', 'rules.cjs', 'check.cjs', 'transitive.cjs']) {
    const f = fixture(t), record = recordAudit(f);
    assert.equal(assertFrozen(record.file, f.packet), true);
    fs.appendFileSync(path.join(f.root, file), '\nchanged after acceptance');
    assert.equal(unchanged(f.binding), false, `${file} must be bound to acceptance`);
    assert.throws(() => assertFrozen(record.file, f.packet));
  }
});

test('nonzero checks, check failure and unresolved dependencies cannot be frozen', t => {
  for (const config of [{ exitCode: 1 }, { exitCode: null }, { problem: 'CHECK_TIMEOUT' }, { unresolved: ['main.cjs:missing-module'] }]) {
    const f = fixture(t, config);
    assert.throws(() => recordAudit(f), /PASS_CONTRADICTS_RUNTIME_OR_DEPENDENCIES/);
    assert.equal(fs.existsSync(f.directory), false);
  }
});

test('sourceDigest mismatch between runtime and binding cannot be frozen', t => {
  const f = fixture(t), runtime = f.packet.documents.find(d => d.kind === 'runtime');
  runtime.content = canonical({ exitCode: 0, problem: null, sourceDigest: '0'.repeat(64) }); runtime.sha256 = sha256(runtime.content);
  refreshReview(f);
  assert.throws(() => recordAudit(f), /PASS_CONTRADICTS_RUNTIME_OR_DEPENDENCIES/);
});

test('recordAudit detects invalid individual document hashes even when whole-packet hash matches', t => {
  const f = fixture(t);
  f.packet.documents.find(d => d.kind === 'architecture').content += ' Tampered without updating hash.';
  f.result.packetHash = sha256(canonical(f.packet));
  assert.throws(() => recordAudit(f), /INVALID_EVIDENCE_DOCUMENT|AUDIT_RECEIPT_MISMATCH/);
});

test('modified runtime output is rejected even when document and packet digests are recomputed', t => {
  const f = fixture(t), doc = f.packet.documents.find(d => d.kind === 'runtime');
  const runtime = JSON.parse(doc.content); runtime.output = 'Changed check result';
  doc.content = canonical(runtime); doc.sha256 = sha256(doc.content);
  refreshReview(f);
  assert.throws(() => recordAudit(f), /PASS_CONTRADICTS_RUNTIME_OR_DEPENDENCIES|INVALID_RUNTIME_EVIDENCE|AUDIT_RECEIPT_MISMATCH/);
});

test('runtime binding rejects altered logs even when their output digest is also recomputed', t => {
  const f = fixture(t), doc = f.packet.documents.find(d => d.kind === 'runtime');
  const runtime = JSON.parse(doc.content);
  runtime.output += '\n# changed after collection'; runtime.outputSha256 = sha256(runtime.output);
  doc.content = canonical(runtime); doc.sha256 = sha256(doc.content);
  refreshReview(f);
  assert.notEqual(sha256(canonical(runtime)), f.binding.runtimeDigest);
  assert.throws(() => recordAudit(f), /PASS_CONTRADICTS_RUNTIME_OR_DEPENDENCIES|INVALID_RUNTIME_EVIDENCE|AUDIT_RECEIPT_MISMATCH/);
});

test('runtime receipt cannot substitute an arbitrary command or working directory for the fixed verifier', t => {
  for (const change of [runtime => { runtime.command = [process.execPath, '-e', 'process.exit(0)']; }, runtime => { runtime.cwd = os.tmpdir(); }]) {
    const f = fixture(t), doc = f.packet.documents.find(d => d.kind === 'runtime'), runtime = JSON.parse(doc.content);
    change(runtime);
    doc.content = canonical(runtime); doc.sha256 = sha256(doc.content);
    f.binding.runtimeDigest = sha256(canonical(runtime)); refreshReview(f);
    f.binding.packetHash = sha256(canonical(f.packet));
    assert.throws(() => recordAudit(f), /PASS_CONTRADICTS_RUNTIME_OR_DEPENDENCIES|INVALID_RUNTIME_EVIDENCE|AUDIT_RECEIPT_MISMATCH/);
  }
});

test('v1 historical receipts cannot authorize the v2 deterministic gate', t => {
  const f = fixture(t), record = recordAudit(f), saved = JSON.parse(fs.readFileSync(record.file, 'utf8'));
  saved.version = 'jev-auditor/1';
  fs.writeFileSync(record.file, JSON.stringify(saved));
  assert.throws(() => assertFrozen(record.file, f.packet), /AUDIT_FREEZE_INVALID/);
});

test('persisted acceptance fields are recomputed instead of trusting a forged public result', t => {
  const f = fixture(t), record = recordAudit(f), saved = JSON.parse(fs.readFileSync(record.file, 'utf8'));
  saved.result.evidence_ids.push('E000000000000');
  fs.writeFileSync(record.file, JSON.stringify(saved));
  assert.throws(() => assertFrozen(record.file, f.packet), /AUDIT_FREEZE_INVALID|AUDIT_RECEIPT_MISMATCH/);
});

test('synthetic model support cannot freeze a receipt without required host verifier records', t => {
  const f = fixture(t), doc = f.packet.documents.find(d => d.kind === 'runtime');
  const runtime = JSON.parse(doc.content);
  runtime.output = 'TAP version 13\nok 1 - unrelated fixture check';
  runtime.outputSha256 = sha256(runtime.output);
  doc.content = canonical(runtime); doc.sha256 = sha256(doc.content);
  f.binding.runtimeDigest = sha256(canonical(runtime)); refreshReview(f);
  f.binding.packetHash = sha256(canonical(f.packet));
  const outcome = recordOutcome(f);
  assert.equal(outcome.frozen, false); assert.equal(outcome.result.status, 'CHUA_XAC_MINH');
  assert.ok(outcome.result.missing_evidence.length > 0);
  assert.throws(() => assertFrozen(outcome.file, f.packet), /AUDIT_FREEZE_INVALID/);
});

test('assertFrozen independently rechecks failed runtime instead of trusting persisted frozen flag', t => {
  const f = fixture(t), record = recordAudit(f), saved = JSON.parse(fs.readFileSync(record.file, 'utf8'));
  const runtime = saved.packet.documents.find(d => d.kind === 'runtime');
  runtime.content = canonical({ exitCode: 1, problem: null, sourceDigest: f.binding.sourceDigest }); runtime.sha256 = sha256(runtime.content);
  refreshReview(saved);
  fs.writeFileSync(record.file, JSON.stringify(saved));
  assert.throws(() => assertFrozen(record.file, saved.packet), /AUDIT_FREEZE_INVALID|PASS_CONTRADICTS_RUNTIME_OR_DEPENDENCIES/);
});

test('audit receipt uses exclusive creation and never overwrites a previous verdict', t => {
  const f = fixture(t), record = recordAudit(f), before = fs.readFileSync(record.file, 'utf8');
  assert.throws(() => recordAudit(f), /EEXIST/);
  assert.equal(fs.readFileSync(record.file, 'utf8'), before);
});

test('revocation permanently invalidates an accepted receipt without rewriting its historical result', t => {
  const f = fixture(t), record = recordAudit(f), original = fs.readFileSync(record.file, 'utf8');
  assert.equal(assertFrozen(record.file, f.packet), true);
  const revocationFile = revokeAudit(record.file, { reason: 'Concrete security counterexample invalidates the earlier result.', evidence: ['tests/security-counterexample.json'] });
  const revocation = JSON.parse(fs.readFileSync(revocationFile, 'utf8'));
  assert.equal(revocation.receipt_id, f.result.receipt_id);
  assert.equal(fs.readFileSync(record.file, 'utf8'), original);
  assert.throws(() => assertFrozen(record.file, f.packet), /AUDIT_FREEZE_REVOKED/);
  const sourcePath = path.join(f.root, f.binding.files[0]), source = fs.readFileSync(sourcePath, 'utf8');
  fs.appendFileSync(sourcePath, '// temporary fix'); fs.writeFileSync(sourcePath, source);
  assert.equal(unchanged(f.binding), true);
  assert.throws(() => assertFrozen(record.file, f.packet), /AUDIT_FREEZE_REVOKED/, 'Reverting code cannot revive a disproven receipt');
  const firstRevocation = fs.readFileSync(revocationFile, 'utf8');
  assert.throws(() => revokeAudit(record.file, { reason: 'Replacement reason', evidence: ['other.json'] }), /EEXIST/);
  assert.equal(fs.readFileSync(revocationFile, 'utf8'), firstRevocation);
});

test('revocation requires evidence and screens its reason before persisting', t => {
  const f = fixture(t), record = recordAudit(f);
  assert.throws(() => revokeAudit(record.file, { reason: '', evidence: ['counterexample.json'] }), /REVOCATION_EVIDENCE_REQUIRED/);
  assert.throws(() => revokeAudit(record.file, { reason: 'Missing evidence', evidence: [] }), /REVOCATION_EVIDENCE_REQUIRED/);
  assert.throws(() => revokeAudit(record.file, { reason: 'Authorization: Bearer ' + 'x'.repeat(32), evidence: ['counterexample.json'] }), /SECRET_LITERAL_DENIED/);
  assert.equal(fs.existsSync(record.file.replace(/\.json$/, '.revoked.json')), false);
  assert.equal(assertFrozen(record.file, f.packet), true);
});

test('receipt_id must match the storage identity when recording a result', t => {
  const f = fixture(t); f.result.receipt_id = randomUUID();
  assert.throws(() => recordAudit(f), /AUDIT_RECEIPT_MISMATCH/);
});

test('assertFrozen rejects a persisted receipt whose public identity was changed', t => {
  const f = fixture(t), record = recordAudit(f), saved = JSON.parse(fs.readFileSync(record.file, 'utf8'));
  saved.result.receipt_id = randomUUID();
  fs.writeFileSync(record.file, JSON.stringify(saved));
  assert.throws(() => assertFrozen(record.file, f.packet), /AUDIT_FREEZE_INVALID|AUDIT_RECEIPT_MISMATCH/);
});

test('receipt filename identity cannot bypass revocation through a renamed copy', t => {
  const f = fixture(t), record = recordAudit(f);
  revokeAudit(record.file, { reason: 'A concrete counterexample invalidated the prior acceptance.', evidence: ['counterexample.json'] });
  const alias = path.join(f.directory, randomUUID() + '.json');
  fs.copyFileSync(record.file, alias);
  assert.throws(() => assertFrozen(alias, f.packet), /AUDIT_FREEZE_INVALID|AUDIT_RECEIPT_MISMATCH|AUDIT_FREEZE_REVOKED/);
});

test('revoked receipt cannot bypass its registry through a same-name copy in another directory', t => {
  const f = fixture(t), record = recordAudit(f);
  revokeAudit(record.file, { reason: 'The accepted result was disproven by a concrete counterexample.', evidence: ['counterexample.json'] });
  const alternateDirectory = path.join(f.root, 'alternate-audits');
  fs.mkdirSync(alternateDirectory);
  const copy = path.join(alternateDirectory, path.basename(record.file));
  fs.copyFileSync(record.file, copy);
  assert.throws(() => assertFrozen(copy, f.packet), /AUDIT_REGISTRY_PATH_DENIED/);
  assert.throws(() => revokeAudit(copy, { reason: 'Do not create an alternative revocation registry.', evidence: ['counterexample.json'] }), /AUDIT_REGISTRY_PATH_DENIED/);
  const next = fixture(t); next.directory = path.join(next.root, 'alternate-audits');
  assert.throws(() => recordAudit(next), /AUDIT_REGISTRY_PATH_DENIED/);
  assert.equal(fs.existsSync(next.directory), false);
});

test('receipt failures cannot be erased by a new supporting review of the same revision', t => {
  const f = fixture(t), failed = recordProtocolFailure(f);
  const expectedMissing = 'UNRESOLVED_PRIOR_FAIL:' + failed.result.receipt_id;
  const derived = decide(f.packet, f.result, f.binding);
  assert.equal(derived.status, 'CHUA_XAC_MINH');
  assert.ok(derived.missing_evidence.includes(expectedMissing));
  assert.throws(() => recordAudit(f), /PASS_CONTRADICTS_RUNTIME_OR_DEPENDENCIES/);
  const outcome = recordOutcome({ ...f, result: derived });
  assert.equal(outcome.result.status, 'CHUA_XAC_MINH'); assert.equal(outcome.frozen, false);
  assert.ok(outcome.result.missing_evidence.includes(expectedMissing));
  assert.throws(() => assertFrozen(outcome.file, f.packet), /AUDIT_FREEZE_INVALID/);
  revokeAudit(failed.file, { reason: 'Revocation cannot resolve the underlying recorded source failure.', evidence: ['counterexample.json'] });
  assert.ok(decide(f.packet, f.result, f.binding).missing_evidence.includes(expectedMissing));
});

test('receipt failure history cannot be bypassed by changing only the comparison baseline', t => {
  const original = collectedRevision(collectionFixture(t)), failed = recordProtocolFailure(original);
  const originalRevision = original.binding.policyRevision;
  const first = collectedRevision(original, path.relative(original.root, failed.file).replaceAll('\\', '/'));
  assert.notEqual(first.binding.protectedDigest, original.binding.protectedDigest);
  assert.equal(first.binding.policyRevision, originalRevision);
  const firstDecision = decide(first.packet, first.result, first.binding);
  assert.equal(firstDecision.status, 'CHUA_XAC_MINH');
  assert.ok(firstDecision.missing_evidence.includes('UNRESOLVED_PRIOR_FAIL:' + failed.result.receipt_id));
  const intermediate = recordOutcome({ ...first, result: firstDecision });
  const second = collectedRevision(original, path.relative(original.root, intermediate.file).replaceAll('\\', '/'));
  assert.equal(second.binding.policyRevision, originalRevision);
  const secondDecision = decide(second.packet, second.result, second.binding);
  assert.equal(secondDecision.status, 'CHUA_XAC_MINH');
  assert.ok(secondDecision.missing_evidence.includes('UNRESOLVED_PRIOR_FAIL:' + failed.result.receipt_id));
  assert.throws(() => recordAudit(second), /PASS_CONTRADICTS_RUNTIME_OR_DEPENDENCIES/);
});

test('receipt history permits reconsideration only after a collected source or policy revision', t => {
  for (const file of ['services/jev/auditor/contract.cjs', 'docs/JEV-AUDITOR.md']) {
    const original = collectedRevision(collectionFixture(t)), failed = recordProtocolFailure(original);
    assert.equal(decide(original.packet, original.result, original.binding).status, 'CHUA_XAC_MINH');
    fs.appendFileSync(path.join(original.root, file), file.endsWith('.cjs') ? '\nmodule.exports.isolatedRevisionMarker = true;\n' : '\nProtocol fixture introduces an additional documented revision constraint.\n');
    assert.throws(() => recordAudit(original), /SOURCE_CHANGED_DURING_REVIEW/);
    const next = collectedRevision(original, path.relative(original.root, failed.file).replaceAll('\\', '/'));
    assert.notEqual(next.binding.policyRevision, original.binding.policyRevision);
    const result = decide(next.packet, next.result, next.binding);
    assert.equal(result.status, 'PASS', 'A new collected revision can be considered by the other acceptance checks. Protocol-only missing evidence: ' + JSON.stringify(result.missing_evidence));
    assert.equal(result.missing_evidence.some(item => item.startsWith('UNRESOLVED_PRIOR_FAIL:')), false);
    const outcome = recordAudit(next);
    assert.equal(assertFrozen(outcome.file, next.packet), true);
    fs.appendFileSync(failed.file, ' ');
    assert.equal(unchanged(next.binding), false, 'The excluded comparison receipt must remain tamper-bound.');
    assert.throws(() => assertFrozen(outcome.file, next.packet), /AUDIT_FREEZE_INVALID/);
  }
});

test('receipt history preserves older failures with missing revision metadata', t => {
  const original = collectedRevision(collectionFixture(t)), failed = recordProtocolFailure(original);
  const historical = JSON.parse(fs.readFileSync(failed.file, 'utf8'));
  delete historical.binding.policyRevision;
  fs.writeFileSync(failed.file, JSON.stringify(historical));
  const next = collectedRevision(original, path.relative(original.root, failed.file).replaceAll('\\', '/'));
  assert.ok(decide(next.packet, next.result, next.binding).missing_evidence.includes('UNRESOLVED_PRIOR_FAIL:' + failed.result.receipt_id));
  // An older FAIL whose policy provenance cannot be reconstructed is not erased.
  delete historical.binding.protectedFiles;
  fs.writeFileSync(failed.file, JSON.stringify(historical));
  fs.appendFileSync(path.join(original.root, 'docs/JEV-AUDITOR.md'), '\nChanged policy cannot resolve unknown historical policy provenance.\n');
  const unknownRevision = collectedRevision(original, path.relative(original.root, failed.file).replaceAll('\\', '/'));
  const result = decide(unknownRevision.packet, unknownRevision.result, unknownRevision.binding);
  assert.equal(result.status, 'CHUA_XAC_MINH');
  assert.ok(result.missing_evidence.includes('UNRESOLVED_PRIOR_FAIL:' + failed.result.receipt_id));
});

test('receipt freeze rejects missing or forged current policy revision identity', t => {
  for (const change of [binding => { delete binding.policyRevision; }, binding => { binding.policyRevision = '0'.repeat(64); }]) {
    const f = fixture(t); change(f.binding);
    const result = decide(f.packet, f.result, f.binding);
    assert.equal(result.status, 'CHUA_XAC_MINH');
    assert.ok(result.missing_evidence.includes('POLICY_REVISION_BINDING_INVALID'));
    assert.throws(() => recordAudit(f), /PASS_CONTRADICTS_RUNTIME_OR_DEPENDENCIES/);
  }
});

test('receipt policy identity cannot exclude a baseline that is also a dependency', t => {
  const original = collectedRevision(collectionFixture(t)), baseline = recordAudit(original);
  const relative = path.relative(original.root, baseline.file).replaceAll('\\', '/');
  const f = collectedRevision(original, relative);
  const baselineEvidence = f.binding.protectedFiles.find(item => item.root === f.root && item.file === relative);
  assert.ok(baselineEvidence);
  f.binding.dependency.imports[0].resolved.push({ spec: './comparison-as-config.json', ...baselineEvidence });
  const doc = f.packet.documents.find(item => item.kind === 'dependency');
  doc.content = canonical(f.binding.dependency); doc.sha256 = sha256(doc.content);
  f.binding.packetHash = sha256(canonical(f.packet)); refreshReview(f);
  const result = decide(f.packet, f.result, f.binding);
  assert.equal(result.status, 'CHUA_XAC_MINH');
  assert.ok(result.missing_evidence.includes('POLICY_REVISION_BINDING_INVALID'));
  assert.throws(() => recordAudit(f), /PASS_CONTRADICTS_RUNTIME_OR_DEPENDENCIES/);
});

test('a later failure invalidates an existing receipt freeze for the unchanged revision', t => {
  const f = fixture(t), accepted = recordAudit(f);
  assert.equal(assertFrozen(accepted.file, f.packet), true);
  recordProtocolFailure(f);
  assert.throws(() => assertFrozen(accepted.file, f.packet), /AUDIT_FREEZE_INVALID/);
});

test('unreadable receipt history blocks acceptance and reuse of an existing freeze', t => {
  const f = fixture(t), accepted = recordAudit(f);
  fs.writeFileSync(path.join(f.directory, randomUUID() + '.json'), '{invalid json');
  const derived = decide(f.packet, f.result, f.binding);
  assert.equal(derived.status, 'CHUA_XAC_MINH');
  assert.ok(derived.missing_evidence.includes('AUDIT_HISTORY_UNREADABLE'));
  assert.throws(() => assertFrozen(accepted.file, f.packet), /AUDIT_FREEZE_INVALID/);
});

test('host runtime gate persists structured unknown and preserves the rejected model analysis as evidence', t => {
  const f = fixture(t, { exitCode: 1 }), original = structuredClone(f.result), outcome = recordOutcome(f);
  assert.equal(outcome.frozen, false); assert.equal(outcome.result.status, 'CHUA_XAC_MINH');
  assert.equal(outcome.result.receipt_id, original.receipt_id);
  assert.equal(outcome.result.id, original.id);
  assert.equal(outcome.result.authority, 'deterministic-acceptance/2');
  assert.equal(outcome.result.source_hash, sha256(canonical({ root: f.binding.root, files: f.packet.documents.filter(d => d.kind === 'source').map(d => ({ file: d.file, sha256: d.sha256 })) })));
  assert.ok(outcome.result.missing_evidence.some(v => /RUNTIME|PASS_CONTRADICTS/.test(v)));
  assert.ok(outcome.result.findings.some(f => f.severity === 'UNKNOWN'));
  const saved = JSON.parse(fs.readFileSync(outcome.file, 'utf8'));
  assert.equal(saved.frozen, false); assert.deepEqual(saved.reviewed_result, original);
  assert.deepEqual(saved.result, outcome.result);
  assert.throws(() => assertFrozen(outcome.file, f.packet), /AUDIT_FREEZE_INVALID/);
});

test('source changing during review produces a persisted host rejection instead of losing the receipt', t => {
  const f = fixture(t); fs.appendFileSync(path.join(f.root, f.binding.files[0]), '\n// source changed after evidence');
  const outcome = recordOutcome(f), saved = JSON.parse(fs.readFileSync(outcome.file, 'utf8'));
  assert.equal(outcome.result.status, 'CHUA_XAC_MINH'); assert.equal(outcome.frozen, false);
  assert.equal(outcome.result.source_hash, sha256(canonical({ root: f.binding.root, files: f.packet.documents.filter(d => d.kind === 'source').map(d => ({ file: d.file, sha256: d.sha256 })) })));
  assert.match(outcome.result.findings[0].message, /SOURCE_CHANGED_DURING_REVIEW/);
  assert.equal(saved.reviewed_result.status, 'PASS');
  assert.equal(saved.result.receipt_id, f.result.receipt_id);
  assert.throws(() => assertFrozen(outcome.file, f.packet), /AUDIT_FREEZE_INVALID/);
});

test('host outcome wrapper derives acceptance from analysis and obligations rather than trusting a model verdict', t => {
  const f = fixture(t), expected = decide(f.packet, f.result, f.binding), outcome = recordOutcome(f);
  assert.equal(outcome.frozen, true); assert.deepEqual(outcome.result, expected);
  assert.equal(outcome.result.authority, 'deterministic-acceptance/2');
  assert.deepEqual(outcome.result.analysis, f.result.analysis);
  assert.equal(outcome.result.source_hash.length, 64);
  assert.equal(assertFrozen(outcome.file, f.packet), true);
});

test('runCheck rejects arbitrary command names before launching a process', () => {
  assert.throws(() => runCheck('node -e process.exit(0)', '0'.repeat(64)), /UNKNOWN_AUDIT_CHECK/);
});

test('runCheck rejects mutation of named arguments and preserves fixed command provenance', t => {
  const before = structuredClone(CHECKS);
  assert.equal(Object.isFrozen(CHECKS), true);
  for (const [name, args] of Object.entries(CHECKS)) {
    assert.equal(Object.isFrozen(args), true, name + ' arguments must also be frozen.');
    assert.throws(() => args.push('--test-reporter=tap'), TypeError);
    assert.throws(() => { args[0] = '--version'; }, TypeError);
    assert.throws(() => args.splice(0, 1), TypeError);
  }
  assert.deepEqual(CHECKS, before);
  const f = collectedRevision(collectionFixture(t));
  const runtime = JSON.parse(f.packet.documents.find(doc => doc.kind === 'runtime').content);
  assert.deepEqual(runtime.command, [process.execPath, '--test-reporter=tap', ...before[f.binding.check]]);
  assert.equal(runtime.cwd, f.root);
  assert.equal(runtime.protectedDigest, f.binding.protectedDigest);
  assert.equal(sha256(canonical(runtime)), f.binding.runtimeDigest);
});

test('collector binds recursive dependencies, auditor rules, architecture and exact fixed check code', async t => {
  const directory = fs.mkdtempSync(path.join(ROOT, 'tests', '.audit-collector-protocol-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'main.cjs'), "module.exports = require('./direct.cjs');\nrequire ( './spaced.cjs' );");
  fs.writeFileSync(path.join(directory, 'direct.cjs'), "module.exports = require('./nested.cjs');");
  fs.writeFileSync(path.join(directory, 'nested.cjs'), 'module.exports = 3;');
  fs.writeFileSync(path.join(directory, 'spaced.cjs'), 'module.exports = 4;');
  fs.writeFileSync(path.join(directory, 'main.mjs'), "import './side-effect.mjs';\nawait import('./dynamic.mjs');");
  fs.writeFileSync(path.join(directory, 'side-effect.mjs'), 'export const value = 5;');
  fs.writeFileSync(path.join(directory, 'dynamic.mjs'), 'export const value = 6;');
  const source = path.relative(ROOT, path.join(directory, 'main.cjs')).replaceAll('\\', '/');
  const esmSource = path.relative(ROOT, path.join(directory, 'main.mjs')).replaceAll('\\', '/');
  const evidence = await collect({ scope: 'collector-protocol', files: [source, esmSource], criteria: [{ id: 'coverage', requirement: 'Capture actual evidence with all dependency and reviewer code bindings.', evidenceKinds: [...KINDS] }], architecture: readInside(ROOT, 'docs/JEV-AUDITOR.md'), check: 'state' });
  assert.equal(evidence.binding.packetHash, sha256(canonical(evidence.packet)), 'The original complete packet must be bound at collection time.');
  const protectedPaths = (evidence.binding.protectedFiles ?? []).map(item => path.resolve(item.root, item.file).toLowerCase());
  for (const file of [
    ...['direct.cjs', 'nested.cjs', 'spaced.cjs', 'side-effect.mjs', 'dynamic.mjs'].map(file => path.join(directory, file)),
    path.join(ROOT, 'docs/JEV-AUDITOR.md'), path.join(ROOT, 'tests/state-layer.test.cjs'),
    path.join(ROOT, 'state/store.cjs'),
    ...['contract', 'service', 'ollama', 'evidence', 'registry'].map(name => path.join(ROOT, `services/jev/auditor/${name}.cjs`))
  ]) assert.ok(protectedPaths.includes(file.toLowerCase()), `Missing immutable acceptance dependency: ${file}`);
  fs.appendFileSync(path.join(directory, 'nested.cjs'), '\n// changed after collection');
  assert.equal(unchanged(evidence.binding), false);
});

test('collector rejects nonliteral imports and unresolved dependencies without executing inspected source', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botmeme-dependency-negative-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.cjs'), [
    "require('node:fs').writeFileSync(__dirname + '/executed.txt', 'SOURCE EXECUTED');",
    "const target = './known.cjs'; require(target);",
    "require('./missing.cjs'); require('./known.cjs');"
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'member.cjs'), "module.require('./' + 'known.cjs');");
  fs.writeFileSync(path.join(root, 'main.mjs'), [
    "const target = './known.mjs'; await import(target);",
    "await import('./missing.mjs'); import './known.mjs';",
    "export { value } from './missing-export.mjs';"
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'known.cjs'), "module.exports = require('./missing-transitive.cjs');");
  fs.writeFileSync(path.join(root, 'known.mjs'), 'export const value = 7;');
  const result = graph([{ root, file: 'main.cjs' }, { root, file: 'member.cjs' }, { root, file: 'main.mjs' }], [root], readInside);
  assert.deepEqual([...result.unresolved].sort(), [
    'main.cjs:<DYNAMIC_DEPENDENCY>', 'main.cjs:./missing.cjs',
    'member.cjs:<DYNAMIC_DEPENDENCY>',
    'main.mjs:<DYNAMIC_DEPENDENCY>', 'main.mjs:./missing.mjs',
    'main.mjs:./missing-export.mjs', 'known.cjs:./missing-transitive.cjs'
  ].sort());
  assert.deepEqual(result.protectedFiles.map(item => item.file).sort(), ['main.cjs', 'member.cjs', 'main.mjs', 'known.cjs', 'known.mjs'].sort());
  const resolved = result.imports.flatMap(item => item.resolved);
  assert.deepEqual(resolved.map(item => item.file).sort(), ['known.cjs', 'known.mjs']);
  assert.ok(resolved.every(item => item.sha256 === sha256(readInside(root, item.file))));
  assert.equal(fs.existsSync(path.join(root, 'executed.txt')), false, 'Dependency inspection must never execute subject source.');
});

test('collector cannot label arbitrary architecture text as the actual architecture file', async () => {
  await assert.rejects(collect({ scope: 'collector-protocol', files: ['services/jev/auditor/contract.cjs'], criteria: [{ id: 'architecture', requirement: 'Architecture content must match its claimed file.', evidenceKinds: ['architecture'] }], architecture: 'Fabricated replacement architecture', check: 'state' }), /ARCHITECTURE.*MISMATCH|INVALID_ARCHITECTURE|ARCHITECTURE.*CHANGED/);
});

test('genuine diff identifies exact changed lines plus added and removed files', t => {
  const f = fixture(t), before = 'const a = 1;\nconst b = 2;\nmodule.exports = a + b;', after = 'const a = 1;\nconst b = 3;\nmodule.exports = a + b;';
  f.packet.documents = [document('source-old', 'source', 'main.cjs', before), document('source-removed', 'source', 'removed.cjs', 'module.exports = 2;'), ...f.packet.documents.filter(d => d.kind !== 'source')];
  f.result.packetHash = sha256(canonical(f.packet));
  const current = [document('source-new', 'source', 'main.cjs', after), document('source-added', 'source', 'added.cjs', 'module.exports = 3;')];
  const diff = JSON.parse(describeDiff(current, { packet: f.packet, result: f.result }, f.packet.scope, false));
  assert.equal(diff.mode, 'SOURCE_DELTA'); assert.equal(diff.baseline, f.result.receipt_id);
  const rows = new Map(diff.files.map(row => [row.file, row]));
  assert.deepEqual(rows.get('main.cjs'), { file: 'main.cjs', beforeSha256: sha256(before), afterSha256: sha256(after), sourceDocument: 'source-new', beforeStartLine: 2, afterStartLine: 2, removed: ['const b = 2;'], added: ['const b = 3;'] });
  assert.equal(rows.get('removed.cjs').afterSha256, null);
  assert.equal(rows.get('removed.cjs').sourceDocument, null);
  assert.deepEqual(rows.get('removed.cjs').removed, ['module.exports = 2;']);
  assert.deepEqual(rows.get('removed.cjs').added, []);
  assert.equal(rows.get('added.cjs').beforeSha256, null);
  assert.deepEqual(rows.get('added.cjs').removed, []);
  assert.deepEqual(rows.get('added.cjs').added, ['module.exports = 3;']);
  assert.match(diff.baselineAcceptance, /does not confer current acceptance/);
});

function reconstructHunks(before, hunks) {
  const output = []; let cursor = 0;
  for (const hunk of hunks) {
    const start = hunk.beforeStartLine - 1;
    assert.ok(start >= cursor && start <= before.length, 'Hunks must be ordered and non-overlapping.');
    output.push(...before.slice(cursor, start));
    assert.equal(hunk.afterStartLine, output.length + 1, 'Output coordinates must account for earlier insertions/deletions.');
    assert.deepEqual(before.slice(start, start + hunk.removed.length), hunk.removed, 'Every removed line must match the exact original location.');
    output.push(...hunk.added); cursor = start + hunk.removed.length;
  }
  return [...output, ...before.slice(cursor)];
}

test('genuine diff distant edits preserve exact coordinates and reconstruct all changed lines', t => {
  const f = fixture(t);
  const before = ['header', 'old-a', 'old-b', 'keep-1', 'keep-2', 'old-c', 'footer'];
  const after = ['header', 'new-a', 'keep-1', 'keep-2', 'new-c1', 'new-c2', 'footer'];
  const oldSource = document('source-before', 'source', 'subject.cjs', before.join('\n'));
  f.packet.documents = [oldSource, ...f.packet.documents.filter(d => d.kind !== 'source')];
  f.result.packetHash = sha256(canonical(f.packet));
  const newSource = document('source-after', 'source', 'subject.cjs', after.join('\n'));
  const diff = JSON.parse(describeDiff([newSource], { packet: f.packet, result: f.result }, f.packet.scope, false));
  assert.deepEqual(diff.files[0].hunks, [
    { beforeStartLine: 2, afterStartLine: 2, removed: ['old-a', 'old-b'], added: ['new-a'] },
    { beforeStartLine: 6, afterStartLine: 5, removed: ['old-c'], added: ['new-c1', 'new-c2'] }
  ]);
  assert.equal(diff.files[0].beforeSha256, sha256(before.join('\n')));
  assert.equal(diff.files[0].afterSha256, sha256(after.join('\n')));
  assert.deepEqual(reconstructHunks(before, diff.files[0].hunks), after);
});

test('genuine diff repeated lines insertions deletions and empty inputs reconstruct without omission', () => {
  const inputs = [[], [''], ['', ''], ['A'], ['B'], ['A', 'A'], ['A', 'B'], ['B', 'A'], ['A', 'B', 'A'], ['B', 'A', 'B'], ['A', '', 'A'], ['A', 'B', '']];
  for (const before of inputs) for (const after of inputs) {
    assert.deepEqual(reconstructHunks(before, lineHunks(before, after)), after, `Exact reconstruction: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  }
  assert.deepEqual(lineHunks([], ['A', '']), [{ beforeStartLine: 1, afterStartLine: 1, removed: [], added: ['A', ''] }]);
  assert.deepEqual(lineHunks(['A', ''], []), [{ beforeStartLine: 1, afterStartLine: 1, removed: ['A', ''], added: [] }]);
  assert.deepEqual(lineHunks([], []), []);
});

test('genuine diff bounded fallback retains the complete changed span beyond the LCS limit', () => {
  const before = Array.from({ length: 1000 }, (_, index) => 'line-' + index), after = [...before];
  after[1] = 'changed-near-start'; after[998] = 'changed-near-end';
  const hunks = lineHunks(before, after);
  assert.equal(hunks.length, 1, 'Above one million cells the bounded fallback must use one truthful span.');
  assert.deepEqual(hunks[0], { beforeStartLine: 2, afterStartLine: 2, removed: before.slice(1, 999), added: after.slice(1, 999) });
  assert.deepEqual(reconstructHunks(before, hunks), after);
  const atLimitBefore = before.slice(0, 999), atLimitAfter = [...atLimitBefore];
  atLimitAfter[1] = 'changed-near-start'; atLimitAfter[997] = 'changed-near-end';
  const atLimit = lineHunks(atLimitBefore, atLimitAfter);
  assert.equal(atLimit.length, 2, 'Exactly one million cells remains within the LCS budget.');
  assert.deepEqual(reconstructHunks(atLimitBefore, atLimit), atLimitAfter);
});

test('diff rejects wrong-scope, wrong-packet-hash and corrupt baseline document evidence', t => {
  const f = fixture(t), current = f.packet.documents.filter(d => d.kind === 'source');
  const baseline = { packet: f.packet, result: f.result };
  assert.throws(() => describeDiff(current, baseline, 'another-module', false), /DIFF_BASELINE_MISMATCH/);
  const wrongDigest = structuredClone(baseline); wrongDigest.result.packetHash = '0'.repeat(64);
  assert.throws(() => describeDiff(current, wrongDigest, f.packet.scope, false), /DIFF_BASELINE_MISMATCH/);
  const corruptDocument = structuredClone(baseline); corruptDocument.packet.documents[0].content += 'changed';
  corruptDocument.result.packetHash = sha256(canonical(corruptDocument.packet));
  assert.throws(() => describeDiff(current, corruptDocument, f.packet.scope, false), /INVALID_EVIDENCE_DOCUMENT/);
});

test('initial diff honestly declares absence of baseline while historical FAIL remains only comparison evidence', t => {
  const f = fixture(t), sources = f.packet.documents.filter(d => d.kind === 'source');
  const initial = JSON.parse(describeDiff(sources, null, f.packet.scope, false));
  assert.equal(initial.baseline, null); assert.equal(initial.mode, 'INITIAL_MODULE_REVIEW');
  assert.equal(initial.files[0].beforeSha256, null);
  f.result.status = 'FAIL';
  const diff = JSON.parse(describeDiff(sources, { packet: f.packet, result: f.result }, f.packet.scope, false));
  assert.equal(diff.baselineVerdictAtTime, 'FAIL');
  assert.deepEqual(diff.files[0].removed, []); assert.deepEqual(diff.files[0].added, []);
  assert.match(diff.baselineAcceptance, /does not confer current acceptance/);
});

test('collector reads a pinned baseline receipt and emits real FIX-to-AUDIT source delta', async t => {
  const directory = fs.mkdtempSync(path.join(ROOT, 'tests', '.audit-diff-protocol-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, 'subject.cjs'), baselinePath = path.join(directory, 'baseline.json');
  const file = path.relative(ROOT, sourcePath).replaceAll('\\', '/'), baselineFile = path.relative(ROOT, baselinePath).replaceAll('\\', '/');
  const before = 'module.exports = 1;', after = 'module.exports = 2;';
  fs.writeFileSync(sourcePath, before);
  const args = { scope: 'collector-diff-protocol', files: [file], criteria: [{ id: 'diff', requirement: 'Inspect the exact source change and preserve its baseline identity.', evidenceKinds: ['source', 'diff'] }], architecture: readInside(ROOT, 'docs/JEV-AUDITOR.md'), check: 'state' };
  const first = await collect(args), receiptId = randomUUID();
  fs.writeFileSync(baselinePath, JSON.stringify({ packet: first.packet, result: { id: receiptId, receipt_id: receiptId, status: 'FAIL', packetHash: sha256(canonical(first.packet)) } }));
  fs.writeFileSync(sourcePath, after);
  const second = await collect({ ...args, baselineFile });
  const diff = JSON.parse(second.packet.documents.find(d => d.kind === 'diff').content);
  assert.equal(diff.baseline, receiptId); assert.equal(diff.mode, 'SOURCE_DELTA');
  assert.deepEqual(diff.files[0].removed, [before]); assert.deepEqual(diff.files[0].added, [after]);
  assert.ok(second.binding.protectedFiles.some(item => path.resolve(item.root, item.file) === baselinePath));
  fs.appendFileSync(baselinePath, ' ');
  assert.equal(unchanged(second.binding), false, 'Changing historical comparison evidence invalidates its downstream receipt');
});
