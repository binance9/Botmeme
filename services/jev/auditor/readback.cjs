'use strict';
// Readback checks transport grounding only. It cannot establish semantic support.
const { canonical } = require('./contract.cjs');
const { assertNoSecrets } = require('./secrets.cjs');
const { schemaFor, evaluateReview } = require('./evaluation.cjs');
const { criterionView } = require('./views.cjs');
const acorn = require('acorn');

function selectableObservation(entry) {
  if (entry.kind !== 'source' || !/\.[cm]?js$/i.test(entry.file)) return true;
  try { return acorn.parse(entry.quote, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true }).body.length > 0; }
  catch { return false; }
}
const runtimeExplanation = entry => 'The supplied runtime record is: ' + entry.quote;
function observationEligibility(packet, criterionId) {
  return { rule: 'JS observation quotes must be complete statements. Full context and finding references remain available; exclusion cannot satisfy an obligation.', excluded: criterionView(packet, criterionId).entries.filter(e => !selectableObservation(e)).map(e => ({ evidence_id: e.id, reason: 'INCOMPLETE_OR_EMPTY_JS_STATEMENT' })) };
}

function readbackSchema(packet, criterionIds = packet.criteria.map(c => c.id)) {
  const schema = schemaFor(packet, criterionIds);
  for (const [id, criterion] of Object.entries(schema.properties.criteria.properties)) {
    const view = criterionView(packet, id);
    criterion.properties.reason.description = 'Summarize ONLY facts established by the selected observations. Do not summarize the entire supplied file or repeat all requested requirements as proven. If a guard was not selected, do not claim it here. No claims of complete coverage from a subset of tests.';
    for (const [kind, list] of Object.entries(criterion.properties.observations.properties)) {
      const entries = view.entries.filter(e => e.kind === kind && selectableObservation(e));
      list.description = 'Each explanation describes ONLY its copied quote. A declaration constructs/binds a value; it does not prove later use, keying, uniqueness or rejection. A count comparison compares counts; it does not alone prove membership or exactly-once coverage. Select the actual guards needed for such claims. Do not infer purpose from variable names.';
      list.items = entries.length ? { oneOf: entries.map(entry => ({
        type: 'object', additionalProperties: false,
        required: ['evidence_id', 'quote', 'explanation'],
        properties: { evidence_id: { const: entry.id }, quote: { const: entry.quote }, explanation: entry.kind === 'runtime' ? { const: runtimeExplanation(entry) } : { type: 'string' } }
      })) } : false;
    }
  }
  return schema;
}

function decodeReadback(packet, raw, criterionIds = packet.criteria.map(c => c.id)) {
  assertNoSecrets(raw);
  const analysis = structuredClone(raw);
  for (const criterion of Object.values(analysis?.criteria ?? {})) {
    for (const list of Object.values(criterion?.observations ?? {})) {
      if (Array.isArray(list)) for (const observation of list) {
        if (observation && typeof observation === 'object') delete observation.quote;
      }
    }
  }
  const projected = evaluateReview(packet, analysis, criterionIds);
  // A valid negative cannot be erased by a malformed auxiliary readback.
  if (projected.result.status !== 'PASS') return { analysis, projected };
  for (const id of criterionIds) {
    const view = criterionView(packet, id), entries = new Map(view.entries.map(e => [e.id, e]));
    for (const [kind, observations] of Object.entries(raw.criteria[id].observations)) {
      for (const observation of observations) {
        const entry = entries.get(observation.evidence_id);
        if (!entry || entry.kind !== kind || observation.quote !== entry.quote) throw Error('INVALID_EVIDENCE_READBACK');
        if (!selectableObservation(entry)) throw Error('INVALID_INCOMPLETE_SOURCE_OBSERVATION');
        if (kind === 'runtime' && observation.explanation !== runtimeExplanation(entry)) throw Error('INVALID_RUNTIME_OBSERVATION_CLAIM');
      }
    }
  }
  return { analysis, projected };
}

function assertReadback(packet, partial, criterionId, raw) {
  const decoded = decodeReadback(packet, raw, [criterionId]);
  if (decoded.projected.result.status !== 'PASS' || canonical(decoded.analysis) !== canonical(partial)) throw Error('INVALID_READBACK_BINDING');
  return decoded;
}

module.exports = { readbackSchema, decodeReadback, assertReadback, selectableObservation, runtimeExplanation, observationEligibility };
