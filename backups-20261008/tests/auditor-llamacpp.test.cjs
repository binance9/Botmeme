'use strict';
// Transport protocol counterexamples only, never reviewer/model acceptance.
const test = require('node:test'), assert = require('node:assert/strict');
const { LlamaCppReviewer } = require('../services/jev/auditor/llamacpp.cjs');
const { sha256, KINDS } = require('../services/jev/auditor/contract.cjs');
const format = { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'], additionalProperties: false };
const completed = (raw = { reason: 'Protocol fixture only.' }) => ({ model: 'qwen3-32b', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(raw) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
const response = value => new Response(JSON.stringify(value));
test('llamacpp transport binds exact 32b model loopback endpoint schema and bounded budget', async () => {
  let request;
  const reviewer = new LlamaCppReviewer({ fetcher: async (url, options) => { request = { url, options, body: JSON.parse(options.body) }; return response(completed()); } });
  const answer = await reviewer.complete(format, 'System', 'Evidence');
  assert.equal(request.url, 'http://127.0.0.1:18002/v1/chat/completions'); assert.equal(request.options.redirect, 'error'); assert.equal(request.body.model, 'qwen3-32b');
  assert.deepEqual(request.body.response_format, { type: 'json_schema', json_schema: { name: 'jev_evidence_review', strict: true, schema: format } }); assert.equal(request.body.max_tokens, 4096); assert.equal(request.body.stream, false);
  assert.equal(answer.metrics.model, 'qwen3-32b'); assert.equal(answer.metrics.promptTokens, 10); assert.equal(answer.metrics.outputTokens, 5); assert.deepEqual(answer.raw, { reason: 'Protocol fixture only.' });
});
test('llamacpp rejects untrusted endpoint identity and unbounded configuration', () => {
  for (const endpoint of ['https://example.org/v1/chat/completions', 'http://localhost:18002/v1/chat/completions', 'http://user:password@127.0.0.1:18002/v1/chat/completions', 'http://127.0.0.1:18002/v1/chat/completions?redirect=1']) assert.throws(() => new LlamaCppReviewer({ endpoint }), /INVALID_REVIEW_ENDPOINT/);
  for (const options of [{ model: 'qwen3:14b' }, { timeoutMs: 0 }, { maxTokens: 8193 }, { fetcher: null }]) assert.throws(() => new LlamaCppReviewer(options), /INVALID_REVIEW_PROVIDER_CONFIG/);
});
test('llamacpp rejects incomplete wrong model tools multiple choices and malformed JSON', async () => {
  for (const mutate of [v => { v.model = 'other'; }, v => { v.choices[0].finish_reason = 'length'; }, v => { v.choices[0].message.tool_calls = [{ name: 'tool' }]; }, v => { v.choices[0].message.function_call = {}; }, v => { v.choices.push(v.choices[0]); }, v => { v.choices[0].message.role = 'user'; }]) {
    const value = completed(); mutate(value); const reviewer = new LlamaCppReviewer({ fetcher: async () => response(value) }); await assert.rejects(reviewer.complete(format, 'System', 'Evidence'), /REVIEW_PROVIDER_INCOMPLETE/);
  }
  const value = completed(); value.choices[0].message.content = '{bad'; await assert.rejects(new LlamaCppReviewer({ fetcher: async () => response(value) }).complete(format, 'System', 'Evidence'), /INVALID_REVIEW_JSON/);
});
test('llamacpp enforces request response and provider failure boundaries', async () => {
  let calls = 0; const reviewer = new LlamaCppReviewer({ fetcher: async () => { calls++; return response(completed()); } });
  await assert.rejects(reviewer.complete(format, 'System', 'a'.repeat(64001)), /REVIEW_SCOPE_TOO_LARGE/); assert.equal(calls, 0);
  await assert.rejects(reviewer.complete({ description: 'a'.repeat(192001) }, 'System', 'Evidence'), /REVIEW_REQUEST_TOO_LARGE/); assert.equal(calls, 0);
  await assert.rejects(new LlamaCppReviewer({ fetcher: async () => new Response('x'.repeat(262145)) }).complete(format, 'System', 'Evidence'), /REVIEW_RESPONSE_TOO_LARGE/);
  await assert.rejects(new LlamaCppReviewer({ fetcher: async () => new Response('private diagnostics', { status: 503 }) }).complete(format, 'System', 'Evidence'), /^Error: REVIEW_PROVIDER_HTTP_503$/);
});
test('llamacpp inherited review retains UNKNOWN analysis and reports accurate provider provenance', async () => {
  const packet = { scope: 'llamacpp-protocol', criteria: [{ id: 'criterion', requirement: 'Inspect evidence without accepting this fixture.', evidenceKinds: ['source'] }], documents: KINDS.map(kind => { const content = 'Protocol fixture evidence only.'; return { id: kind, kind, file: 'tests/fixtures/' + kind + '.txt', content, sha256: sha256(content) }; }) };
  const raw = { criteria: { criterion: { observations: { source: [] }, findings: [], missing_evidence: ['No behavior established.'], reason: 'Insufficient evidence.', assessment: 'UNKNOWN' } } };
  const reviewer = new LlamaCppReviewer({ fetcher: async () => response(completed(raw)) }), result = await reviewer.review(packet);
  assert.equal(result.analysis.criteria.criterion.assessment, 'UNKNOWN'); assert.equal(result.provenance.provider, 'ssh-llamacpp'); assert.equal(result.provenance.model, 'qwen3-32b'); assert.equal(result.provenance.readback_protocol, 'evidence-readback/1');
  assert.equal(result.provenance.attributions.length, 0);
});
test('llamacpp classifies bounded provider timeout without exposing diagnostic text', async () => {
  const reviewer = new LlamaCppReviewer({ timeoutMs: 10, fetcher: async (_url, { signal }) => new Promise((resolve, reject) => {
    const hold = setTimeout(() => reject(Error('Unexpected timeout fixture completion')), 1000);
    signal.addEventListener('abort', () => { clearTimeout(hold); reject(Error('Provider diagnostic must not escape')); }, { once: true });
  }) });
  await assert.rejects(reviewer.complete(format, 'System', 'Evidence'), /^Error: REVIEW_PROVIDER_TIMEOUT$/);
});
