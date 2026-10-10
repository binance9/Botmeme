'use strict';
// A separate critic may veto a positive analysis. It cannot grant acceptance,
// change the primary analysis, or infer evidence outside the selected quotes.
const { canonical, sha256 } = require('./contract.cjs');
const { assertNoSecrets } = require('./secrets.cjs');
const { buildRegistry } = require('./evidence-registry.cjs');
const { evaluateReview } = require('./evaluation.cjs');
const { attributionIdentity } = require('./reviewer-identity.cjs');
const VERSION = 'evidence-attribution/1';
const RELATIONS = Object.freeze(['SUPPORTED', 'CONTRADICTED', 'UNKNOWN']);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && canonical(Object.keys(value).sort()) === canonical([...keys].sort());
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 2000;
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

function buildAttributionInput(packet, partialAnalysis, criterionId) {
  const projected = evaluateReview(packet, partialAnalysis, [criterionId]);
  if (projected.result.status !== 'PASS') throw Error('ATTRIBUTION_REQUIRES_POSITIVE_ANALYSIS');
  const criterion = packet.criteria.find(c => c.id === criterionId), primary = partialAnalysis.criteria[criterionId];
  const registry = buildRegistry(packet), byId = new Map(registry.entries.map(entry => [entry.id, entry]));
  const observations = criterion.evidenceKinds.flatMap(kind => primary.observations[kind].map(selection => {
    const entry = byId.get(selection.evidence_id);
    return { evidence_id: entry.id, kind: entry.kind, file: entry.file, document_id: entry.document_id, quote: entry.quote, source_context: entry.source_context, explanation: selection.explanation };
  }));
  const input = {
    version: VERSION, criterion_id: criterionId, packet_hash: registry.packet_hash, registry_hash: registry.registry_hash,
    requirement: criterion.requirement,
    overview: { statement: primary.reason, evidence_ids: observations.map(observation => observation.evidence_id) },
    observations
  };
  return freeze({ ...input, bundle_hash: sha256(canonical(input)) });
}

function validateInput(input) {
  assertNoSecrets(input);
  if (!exact(input, ['version', 'criterion_id', 'packet_hash', 'registry_hash', 'requirement', 'overview', 'observations', 'bundle_hash']) || input.version !== VERSION || !text(input.criterion_id) || !text(input.requirement) || ![input.packet_hash, input.registry_hash, input.bundle_hash].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) throw Error('INVALID_ATTRIBUTION_INPUT');
  const { bundle_hash, ...contents } = input;
  if (sha256(canonical(contents)) !== bundle_hash) throw Error('INVALID_ATTRIBUTION_BUNDLE_HASH');
  if (!exact(input.overview, ['statement', 'evidence_ids']) || !text(input.overview.statement) || !Array.isArray(input.observations) || !input.observations.length) throw Error('INVALID_ATTRIBUTION_INPUT');
  const ids = [];
  for (const observation of input.observations) {
    if (!exact(observation, ['evidence_id', 'kind', 'file', 'document_id', 'quote', 'source_context', 'explanation']) || !['source', 'diff', 'architecture', 'runtime', 'dependency'].includes(observation.kind) || ![observation.evidence_id, observation.file, observation.document_id, observation.explanation].every(text) || !text(observation.quote) || observation.quote.trim().length < 12 || observation.quote.length > 400 || ids.includes(observation.evidence_id)) throw Error('INVALID_ATTRIBUTION_OBSERVATION');
    const context = observation.source_context;
    if (context !== null && (observation.kind !== 'source' || !exact(context, ['document_hash', 'quote_start', 'quote_end', 'function_start', 'function_end', 'header_start', 'header_end', 'header', 'name']) || !/^[a-f0-9]{64}$/.test(context.document_hash) || !['quote_start', 'quote_end', 'function_start', 'function_end', 'header_start', 'header_end'].every(k => Number.isSafeInteger(context[k]) && context[k] >= 0) || context.quote_end - context.quote_start !== observation.quote.length || context.header_start > context.function_start || context.function_start > context.header_end || context.header_end > context.quote_start || context.quote_end > context.function_end || typeof context.header !== 'string' || context.header.length !== context.header_end - context.header_start || context.header.length > 400 || (context.name !== null && !text(context.name)))) throw Error('INVALID_ATTRIBUTION_SOURCE_CONTEXT');
    ids.push(observation.evidence_id);
  }
  if (canonical(input.overview.evidence_ids) !== canonical(ids)) throw Error('INVALID_ATTRIBUTION_OVERVIEW_REFERENCES');
  return input;
}

function attributionSchema(input) {
  validateInput(input);
  const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
  const relation = () => object({ relation: { type: 'string', enum: [...RELATIONS] }, reason: { type: 'string', minLength: 1, maxLength: 2000 } });
  const schema = object({
    criterion_id: { type: 'string', enum: [input.criterion_id] },
    bundle_hash: { type: 'string', enum: [input.bundle_hash] },
    observations: object(Object.fromEntries(input.observations.map(observation => [observation.evidence_id, relation()]))),
    overview: relation()
  });
  schema.required = ['criterion_id', 'bundle_hash', 'overview', 'observations'];
  return schema;
}

function validateAttribution(input, review) {
  validateInput(input); assertNoSecrets(review);
  if (!exact(review, ['criterion_id', 'bundle_hash', 'overview', 'observations']) || review.criterion_id !== input.criterion_id || review.bundle_hash !== input.bundle_hash) throw Error('INVALID_ATTRIBUTION_REVIEW');
  const ids = input.observations.map(observation => observation.evidence_id);
  if (!exact(review.observations, ids)) throw Error('INCOMPLETE_ATTRIBUTION_COVERAGE');
  const conclusions = [review.overview, ...ids.map(id => review.observations[id])];
  if (conclusions.some(conclusion => !exact(conclusion, ['relation', 'reason']) || !RELATIONS.includes(conclusion.relation) || !text(conclusion.reason))) throw Error('INVALID_ATTRIBUTION_RELATION');
  const status = conclusions.some(conclusion => conclusion.relation === 'CONTRADICTED') ? 'CONTRADICTED' : conclusions.some(conclusion => conclusion.relation === 'UNKNOWN') ? 'UNKNOWN' : 'SUPPORTED';
  return freeze({ criterion_id: input.criterion_id, bundle_hash: input.bundle_hash, status, overview: structuredClone(review.overview), observations: structuredClone(review.observations), proof_hash: sha256(canonical(review)) });
}

function attributionParts(input) {
  validateInput(input);
  if (input.observations.length > 64) throw Error('ATTRIBUTION_CALL_BUDGET');
  const parts = input.observations.map(observation => ({ ...observation, evidence_kind: observation.kind, kind: 'observation', bundle_hash: input.bundle_hash }));
  parts.push({ kind: 'overview', bundle_hash: input.bundle_hash, statement: input.overview.statement, observations: input.observations });
  return parts.map(part => freeze({ ...part, input_hash: sha256(canonical(part)) }));
}

function attributionPartSchema(part) {
  return { type: 'object', additionalProperties: false, required: ['input_hash', 'relation', 'reason'], properties: {
    input_hash: { const: part.input_hash }, relation: { type: 'string', enum: [...RELATIONS] }, reason: { type: 'string', minLength: 1, maxLength: 2000 }
  } };
}

function assembleAttribution(input, parts) {
  assertNoSecrets(parts);
  const expected = attributionParts(input);
  if (!Array.isArray(parts) || parts.length !== expected.length) throw Error('INCOMPLETE_ATTRIBUTION_PARTS');
  const judgments = parts.map((part, index) => validateAttributionPart(expected[index], part));
  if (parts.some(part => canonical(attributionIdentity(part)) !== canonical(attributionIdentity(parts[0])))) throw Error('INVALID_ATTRIBUTION_PART_BINDING');
  return { criterion_id: input.criterion_id, bundle_hash: input.bundle_hash, observations: Object.fromEntries(input.observations.map((o, index) => [o.evidence_id, judgments[index]])), overview: judgments.at(-1) };
}

function validateAttributionPart(expected, part) {
  assertNoSecrets(part);
  if (!(exact(part, ['model', 'input', 'review']) || exact(part, ['provider', 'model', 'input', 'review'])) || !attributionIdentity(part) || canonical(part.input) !== canonical(expected)) throw Error('INVALID_ATTRIBUTION_PART_BINDING');
  const reply = part.review;
  if (!exact(reply, ['input_hash', 'relation', 'reason']) || reply.input_hash !== expected.input_hash || !RELATIONS.includes(reply.relation) || !text(reply.reason)) throw Error('INVALID_ATTRIBUTION_PART_REVIEW');
  return { relation: reply.relation, reason: reply.reason };
}

// The acceptance layer recomputes the bundle from its complete current packet;
// a caller-supplied bundle or derived status cannot replace those originals.
function assertAttribution(packet, partialAnalysis, criterionId, receipt, expectedIdentity = null) {
  const identity = attributionIdentity(receipt);
  if (!(exact(receipt, ['model', 'review', 'parts']) || exact(receipt, ['provider', 'model', 'review', 'parts'])) || !identity || expectedIdentity && (identity.provider !== expectedIdentity.provider || identity.model !== expectedIdentity.model)) throw Error('INVALID_ATTRIBUTION_REVIEWER');
  const input = buildAttributionInput(packet, partialAnalysis, criterionId);
  const assembled = assembleAttribution(input, receipt.parts);
  if (receipt.parts.some(part => canonical(attributionIdentity(part)) !== canonical(identity))) throw Error('INVALID_ATTRIBUTION_REVIEWER');
  if (canonical(assembled) !== canonical(receipt.review)) throw Error('INVALID_ATTRIBUTION_ASSEMBLY');
  return validateAttribution(input, receipt.review);
}

module.exports = { VERSION, RELATIONS, buildAttributionInput, attributionSchema, validateAttribution, assertAttribution, attributionParts, attributionPartSchema, assembleAttribution, validateAttributionPart };
