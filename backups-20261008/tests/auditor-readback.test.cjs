'use strict';
// Protocol counterexamples only; these fixtures are not model acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const { sha256, canonical, KINDS } = require('../services/jev/auditor/contract.cjs');
const { buildRegistry } = require('../services/jev/auditor/evidence-registry.cjs');
const { readbackSchema, decodeReadback, assertReadback, runtimeExplanation, observationEligibility } = require('../services/jev/auditor/readback.cjs');
const { JevAuditor } = require('../services/jev/auditor/service.cjs');
const { OllamaReviewer } = require('../services/jev/auditor/ollama.cjs');
const { buildAttributionInput, attributionSchema, attributionParts, assembleAttribution, assertAttribution } = require('../services/jev/auditor/attribution.cjs');
function fixture() {
  const packet = { scope: 'readback-protocol-only', criteria: [{ id: 'guard', requirement: 'Check the selected guard and its actual runtime evidence.', evidenceKinds: ['source', 'runtime'] }], documents: KINDS.map(kind => {
    const content = kind === 'source' ? "if (seen.has(id)) fail('DUPLICATE');\nseen.add(id); // Separate operation" : 'Explicit ' + kind + ' protocol evidence only.';
    return { id: kind, kind, file: 'tests/fixtures/' + kind + '.txt', content, sha256: sha256(content) };
  }) };
  const registry = buildRegistry(packet);
  const raw = { criteria: { guard: {
    observations: Object.fromEntries(['source', 'runtime'].map(kind => {
      const e = registry.entries.find(e => e.kind === kind);
      return [kind, [{ evidence_id: e.id, quote: e.quote, explanation: kind === 'runtime' ? runtimeExplanation(e) : 'Selected ' + kind + ' text for protocol validation only.' }]];
    })), findings: [], missing_evidence: [], reason: 'Only explicitly selected protocol evidence is considered.', assessment: 'SUPPORTS'
  } } };
  return { packet, registry, raw };
}
function response(raw) { return new Response(JSON.stringify({ done: true, done_reason: 'stop', model: 'qwen3:14b', message: { role: 'assistant', content: JSON.stringify(raw) } })); }

test('readback binds exact host quote without altering stored analysis or packet', () => {
  const { packet, raw } = fixture(), before = structuredClone(raw);
  const result = decodeReadback(packet, raw);
  assert.deepEqual(raw, before);
  assert.equal(result.analysis.criteria.guard.observations.source[0].quote, undefined);
  assert.equal(result.analysis.criteria.guard.observations.source[0].explanation, raw.criteria.guard.observations.source[0].explanation);
  assert.doesNotThrow(() => assertReadback(packet, result.analysis, 'guard', raw));
  const item = readbackSchema(packet).properties.criteria.properties.guard.properties.observations.properties.source.items;
  const entries = buildRegistry(packet).entries.filter(e => e.kind === 'source');
  assert.equal(item.oneOf.length, entries.length);
  for (const entry of entries) {
    const branch = item.oneOf.find(b => b.properties.evidence_id.const === entry.id);
    assert.equal(branch.properties.quote.const, entry.quote);
    assert.deepEqual(Object.keys(branch.properties), ['evidence_id', 'quote', 'explanation']);
    assert.ok(branch.required.includes('quote'));
    assert.equal(branch.additionalProperties, false);
  }
});

test('readback rejects neighboring omitted normalized foreign and wrong-kind evidence', () => {
  for (const mutate of [
    (r, p, entries) => { r.criteria.guard.observations.source[0].quote = entries.find(e => e.kind === 'source' && e.anchor === 'L2').quote; },
    r => { delete r.criteria.guard.observations.source[0].quote; },
    r => { r.criteria.guard.observations.source[0].quote += ' '; },
    (r, p) => { p.scope += '-foreign'; },
    r => { r.criteria.guard.observations.source[0] = r.criteria.guard.observations.runtime[0]; },
    r => { r.criteria.guard.observations.source[0].extra = 'unrecognized'; }
  ]) {
    const { packet, raw, registry } = fixture(); mutate(raw, packet, registry.entries);
    assert.throws(() => decodeReadback(packet, raw), /INVALID_/);
  }
});

test('readback raw provenance must match complete final analysis not just selected IDs', () => {
  const { packet, raw } = fixture(), { analysis } = decodeReadback(packet, raw);
  for (const mutate of [
    a => { a.criteria.guard.observations.source[0].explanation = 'A substituted unsupported claim.'; },
    a => { a.criteria.guard.reason = 'A different overview.'; },
    a => { a.criteria.guard.assessment = 'UNKNOWN'; },
    a => { a.criteria.guard.missing_evidence = ['Missing source']; }
  ]) {
    const changed = structuredClone(analysis); mutate(changed);
    assert.throws(() => assertReadback(packet, changed, 'guard', raw), /INVALID_READBACK_BINDING/);
  }
  const extra = structuredClone(raw); extra.criteria.other = extra.criteria.guard;
  assert.throws(() => assertReadback(packet, analysis, 'guard', extra), /INVALID_REVIEW_SCHEMA/);
});

test('readback wrong auxiliary quote preserves valid negative and never retries', async () => {
  for (const negative of ['UNKNOWN', 'CONTRADICTS']) {
    const { packet, raw } = fixture();
    raw.criteria.guard.observations.source[0].quote = 'A wrong neighboring quote.';
    raw.criteria.guard.assessment = negative;
    if (negative === 'CONTRADICTS') raw.criteria.guard.findings = [{ severity: 'ERROR', file: packet.documents[0].file, message: 'Protocol counterexample remains unresolved.', root_cause: 'The supplied fixture contradicts this requirement.', required_fix: 'Resolve the counterexample.', evidence_ids: [raw.criteria.guard.observations.source[0].evidence_id] }];
    let calls = 0, retries = 0;
    const reviewer = new OllamaReviewer({ fetcher: async () => { calls++; return response(raw); } });
    const result = await new JevAuditor({ reviewer, escalationReviewer: { async review() { retries++; throw Error('UNEXPECTED_RETRY'); } } }).audit(packet);
    assert.equal(calls, 1); assert.equal(retries, 0);
    assert.equal(result.status, negative === 'CONTRADICTS' ? 'FAIL' : 'CHUA_XAC_MINH');
  }
});

test('readback positive mismatch retries only once then remains unknown', async () => {
  const { packet, raw } = fixture(); raw.criteria.guard.observations.source[0].quote = 'A different source fragment.';
  let calls = 0;
  const reviewer = new OllamaReviewer({ fetcher: async () => { calls++; return response(raw); } });
  const result = await new JevAuditor({ reviewer, escalationReviewer: reviewer }).audit(packet);
  assert.equal(calls, 2); assert.equal(result.status, 'CHUA_XAC_MINH');
  assert.ok(result.source.attempts.every(a => a.result === 'INVALID_EVIDENCE_READBACK'));
});

test('readback exact copying cannot bypass a semantic attribution veto', async () => {
  const { packet, raw } = fixture(); raw.criteria.guard.observations.source[0].explanation = 'This executes a live market order.';
  let calls = 0;
  const reviewer = new OllamaReviewer({ fetcher: async (url, init) => {
    calls++; const request = JSON.parse(init.body);
    if (request.format.properties.criteria) return response(raw);
    const input = JSON.parse(request.messages[1].content), verdict = { relation: 'CONTRADICTED', reason: 'Duplicate checking does not execute an order.' };
    return response({ input_hash: input.input_hash, ...verdict });
  } });
  const result = await new JevAuditor({ reviewer, escalationReviewer: null }).audit(packet);
  assert.equal(calls, 4); assert.equal(result.status, 'CHUA_XAC_MINH');
  assert.ok(result.missing_evidence.includes('ATTRIBUTION_VETO:guard:CONTRADICTED'));
});

test('readback provider timeout remains a sanitized non-retryable unknown', async () => {
  const { packet } = fixture(); let retries = 0;
  const reviewer = new OllamaReviewer({ timeoutMs: 15, fetcher: (url, { signal }) => new Promise((resolve, reject) => {
    const keepAlive = setTimeout(() => reject(Error('UNEXPECTED_LATE_TIMEOUT')), 1000);
    signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(Error('Sensitive provider detail must not be retained.')); }, { once: true });
  }) });
  const result = await new JevAuditor({ reviewer, escalationReviewer: { async review() { retries++; } } }).audit(packet);
  assert.equal(result.status, 'CHUA_XAC_MINH'); assert.equal(retries, 0);
  assert.equal(result.source.attempts[0].result, 'REVIEW_PROVIDER_TIMEOUT');
  assert.ok(!JSON.stringify(result).includes('Sensitive provider detail'));
});

test('readback request budget includes schema and rejects before provider I/O', async () => {
  let calls = 0;
  const reviewer = new OllamaReviewer({ fetcher: async () => { calls++; throw Error('UNEXPECTED_PROVIDER_CALL'); } });
  await assert.rejects(reviewer.complete({ type: 'string', enum: ['x'.repeat(192001)] }, 'Bounded review', 'Small input'), /REVIEW_REQUEST_TOO_LARGE/);
  assert.equal(calls, 0);
  const { packet } = fixture();
  packet.documents = packet.documents.filter(d => d.kind !== 'runtime');
  assert.equal(readbackSchema(packet).properties.criteria.properties.guard.properties.observations.properties.runtime.items, false, 'No supplied quote means no selectable pair, never fabricated evidence');
});

test('readback runtime descriptions cannot add claims beyond the host record', () => {
  const { packet, raw } = fixture();
  raw.criteria.guard.observations.runtime[0].explanation += ' Therefore the entire module is correct.';
  assert.throws(() => decodeReadback(packet, raw), /INVALID_RUNTIME_OBSERVATION_CLAIM/);
  const eligibility = observationEligibility(packet, 'guard');
  assert.ok(eligibility.rule.includes('exclusion cannot satisfy an obligation'));
});

test('readback registry context preserves exact CRLF Unicode and chunk source spans', () => {
  const { packet } = fixture();
  const source = packet.documents.find(d => d.kind === 'source');
  source.file = 'tests/fixtures/context.cjs';
  source.content = "function verify(input) {\r\n  // 😀 " + 'x'.repeat(450) + "\r\n  if (!input) throw Error('MISSING');\r\n}\r\n";
  source.sha256 = sha256(source.content);
  const registry = buildRegistry(packet);
  const entries = registry.entries.filter(e => e.kind === 'source');
  assert.ok(entries.some(e => e.anchor.includes(':')));
  for (const entry of entries.filter(e => e.source_context)) {
    const context = entry.source_context;
    assert.equal(source.content.slice(context.quote_start, context.quote_end), entry.quote);
    assert.equal(source.content.slice(context.header_start, context.header_end), context.header);
    assert.equal(context.document_hash, source.sha256);
    assert.equal(context.name, 'verify');
    assert.ok(Object.isFrozen(context));
  }
  assert.ok(entries.find(e => e.quote.includes("throw Error('MISSING')")).source_context);
});

test('readback attribution retains method ownership whose header precedes function value', () => {
  const { packet, raw } = fixture(), source = packet.documents.find(d => d.kind === 'source');
  source.file = 'tests/fixtures/method.cjs';
  source.content = "class Auditor {\n  review(result) {\n    if (!result) throw Error('INVALID');\n  }\n}\n";
  source.sha256 = sha256(source.content);
  const registry = buildRegistry(packet), guard = registry.entries.find(e => e.quote.includes("throw Error('INVALID')"));
  assert.ok(guard.source_context.header_start < guard.source_context.function_start);
  raw.criteria.guard.observations.source = [{ evidence_id: guard.id, quote: guard.quote, explanation: 'The guard rejects an absent result.' }];
  const runtime = registry.entries.find(e => e.kind === 'runtime');
  raw.criteria.guard.observations.runtime = [{ evidence_id: runtime.id, quote: runtime.quote, explanation: runtimeExplanation(runtime) }];
  const { analysis } = decodeReadback(packet, raw);
  const input = buildAttributionInput(packet, analysis, 'guard');
  assert.doesNotThrow(() => attributionSchema(input));
  assert.equal(input.observations[0].source_context.name, 'review');
  const forged = structuredClone(input);
  forged.observations[0].source_context.name = 'unrelatedFunction';
  const { bundle_hash, ...contents } = forged;
  forged.bundle_hash = sha256(canonical(contents));
  const parts = attributionParts(forged).map(part => ({ model: 'qwen3:14b', input: part, review: { input_hash: part.input_hash, relation: 'SUPPORTED', reason: 'Synthetic tamper counterexample, not a real critic.' } }));
  assert.throws(() => assertAttribution(packet, analysis, 'guard', { model: 'qwen3:14b', review: assembleAttribution(forged, parts), parts }), /INVALID_ATTRIBUTION_PART_BINDING/);
});
