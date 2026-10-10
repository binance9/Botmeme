'use strict';
const criterion = (id, requirement, evidenceKinds = ['source', 'runtime']) => ({ id, requirement, evidenceKinds });
const profile = (scope, files, check, criteria) => ({ scope: 'JEV Auditor/' + scope, files: files.map(f => 'services/jev/auditor/' + f + '.cjs'), check, criteria });
const profiles = {
  'legacy-statistics': { scope: 'MemePilot/performance/position-win-rate', files: ['src/statistics.mjs'], check: 'statistics', legacy: true, criteria: [criterion('position-win-rate', 'Count completed positions and their net aggregate PnL across partial sells; a +10 partial and -5 final exit is one winning position.')] },
  'auditor-contract': profile('evidence-result-contract', ['contract', 'secrets'], 'auditor-contract', [
    criterion('contract', 'validatePacket rejects invalid hashes and empty/duplicate requested criteria. validateResult must cover every criterion requested by that packet exactly once, rejecting missing/unknown references, omitted/duplicate results, contradictory status and unactionable findings. PASS requires verified quotes and non-copied explanations for every required evidence kind. The separate host profile policy authenticates which criteria may authorize a scope; validatePacket does not invent criteria absent from the request.'),
    criterion('secrets', 'Reject literal credentials in every packet/result text field, including unquoted Bearer/api_key values; identifier-only source remains reviewable.')
  ]),
  'auditor-agent': profile('independent-review-agent', ['service', 'ollama', 'readback'], 'auditor-agent', [
    criterion('agent', 'Use the verified local Qwen3 14B as primary critic without acceptance authority. Return structured unknown with receipt_id for missing/invalid evidence and provider errors. Never retry valid negative analysis; malformed output permits only one bounded retry with the same source.'),
    criterion('model-boundary', 'Bind schema reference domains independently, verify complete provider output/model identity, bound responses and preserve only secret-free rejected diagnostics. No private thinking or raw provider errors in results.')
  ]),
  'auditor-collector': profile('source-runtime-diff-collector', ['evidence', 'diff'], 'auditor-collector', [
    criterion('collection', 'Read only authorized roots without executing inspected source. Run only named fixed checks and bind source/rules/architecture/dependencies/check hashes before and after runtime collection.', ['source', 'runtime', 'dependency']),
    criterion('diff', 'Declare a true initial review when no baseline exists; otherwise validate baseline scope/hash and report exact changed, added and removed source lines without treating historical verdicts as current acceptance.', ['source', 'runtime', 'diff'])
  ]),
  'auditor-dependencies': profile('dependency-graph', ['dependencies'], 'auditor-collector', [
    criterion('dependencies', 'Statically parse require/import/export, recursively bind local dependencies, reject unresolved/dynamic dependencies and out-of-root paths without executing inspected code.', ['source', 'runtime', 'dependency'])
  ]),
  'auditor-integrity': profile('receipt-freeze-registry', ['registry', 'history', 'gate'], 'auditor-integrity', [
    criterion('registry', 'Only a current deterministic gate PASS with attributed analysis, satisfied host proof obligations and bound successful runtime/source/dependencies can freeze. Recompute on reuse; reject v1 or revoked receipts and preserve contradictory evidence as non-frozen unknown.'),
    criterion('bootstrap-gate', 'Require all official auditor scopes with exact criteria and source files before bootstrap approval; bootstrap alone must never authorize Stage 2 or migration.')
  ]),
  'auditor-evidence-registry': profile('deterministic-evidence-registry', ['anchors', 'evidence-registry', 'source-context', 'evaluation', 'views'], 'auditor-v2', [
    criterion('evidence-registry', 'Issue evidence IDs deterministically before model review, binding exact text, origin, kind, scope and packet hashes. Reject foreign or wrongly typed IDs and model authority fields. Preserve exact quotes, genuine negative analysis and missing evidence; analysis projection alone cannot authorize acceptance.')
  ]),
  'auditor-acceptance': profile('deterministic-acceptance', ['proofs', 'acceptance'], 'auditor-v2', [
    criterion('deterministic-authority', 'Model reasoning cannot set acceptance. Require registered exact scope/source policy, all host-owned runtime proof obligations, valid typed evidence for each criterion, current source/runtime hashes, no revoked receipt, secrets, unresolved failure or uncertainty. Unsupported scope or missing obligations must remain unknown.')
  ]),
  'auditor-attribution': profile('evidence-attribution-veto', ['attribution'], 'auditor-attribution', [
    criterion('attribution', 'Bind each exact selected quote, explanation, overview and original ID to the current packet and registry. A separate 14B critic can veto positive analysis only; unknown or contradictory attribution cannot authorize acceptance. Require complete immutable judgments and real calibration rejecting recorded wrong attributions while recognizing directly supported evidence.')
  ]),
  'auditor-cli': { scope: 'JEV Auditor/fixed-profile-cli', files: ['services/jev/auditor/profiles.cjs', 'scripts/jev-audit.cjs'], check: 'auditor-cli', criteria: [
    criterion('cli', 'The CLI permits only fixed named profiles and validated baseline IDs, runs the internal collector/reviewer/registry, prints a structured result, and never invokes TypeSafe or arbitrary commands.')
  ] }
};
module.exports = { profiles };
