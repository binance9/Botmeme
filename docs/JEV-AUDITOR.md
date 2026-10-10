# Internal JEV Auditor — evidence-first v2

Scope: official internal source/runtime audit for Botmeme. This service is
separate from JEV Hunter and has no code-write, order, signing or wallet authority.
TypeSafe /v1/systemone is never an acceptance provider. Dashboard and legacy
source stay frozen; migration and Stage 2 remain locked.

## Evidence and authority

Input is bounded source/module, exact initial/delta evidence, architecture,
resolved dependency/wiring evidence, and a real predefined runtime check receipt.
The host builds the deterministic evidence registry before invoking a reviewer.
Every issued ID binds scope, complete packet hash, document hash, origin, location
and exact text. The model selects only IDs supplied in per-criterion/per-kind
schema enums. Foreign, stale or wrongly typed IDs reject; no fuzzy quote repair.
Full source context remains visible. Decoded runtime output is explicitly marked.
Each model call reviews one criterion using an explicit view of the original
immutable registry. All scope source files and the auditor architecture stay
visible; runtime selections are restricted to that criterion's actual required
TAP verifier records, including failures. Full decoded logs and failure details
remain visible. Each selectable fragment is a JSON record pairing its ID and quote;
neighboring text is never part of the selected quote. Schema generation requests
observations, findings and missing facts before the overview and assessment.
This presentation cannot override validators or turn a negative into support.
Wire protocol `evidence-readback/1` additionally requires a verbatim quote after
each selected ID and before its explanation. The host rejects mismatched quotes;
The generation schema binds each allowed ID to its exact host quote with a
constant pair. This constrains selection, not semantic understanding. The whole
serialized request, including grammar, is capped at 192KB in addition to the
unchanged 64KB packet/view limits. Unsupported grammar remains a provider failure.
it never repairs an ID or substitutes nearby text. Raw replies are retained in
provenance. The final gate revalidates their registry/view/kind membership and
requires the quote-stripped reply to equal the complete stored analysis. Missing
or altered readbacks cannot freeze. A valid negative remains final even when its
auxiliary readback is malformed. Exact copying never replaces the semantic veto.
For JS source, observation choices are restricted to syntactically complete
statements; excluded IDs and the reason are disclosed in the request. Full source
and finding references remain available. No eligible proof means unknown, not a
reduced obligation. Completeness does not establish the statement's semantics.
Runtime descriptions are host-constrained verbatim record readbacks, not claims
of independent model analysis. Authenticated TAP obligations and attribution
remain required; additional runtime claims are rejected.
Other documents stay in the complete bound packet, with exclusions
declared in the view manifest. No ID is regenerated for a partial view. The final
gate requires exact coverage manifests for every criterion. A source finding must
cite evidence from its actual target file. A valid negative stops further model
calls; remaining criteria are explicitly unreviewed/unknown, never silently passed.

The model returns analysis, observations, findings, root causes, proposed fixes
and missing evidence. It cannot output final status, acceptance flags or hashes.
SUPPORTS is only an analysis projection, not acceptance. Empty selections or
uncertainty remain unknown. Genuine negative analysis is never retried to seek
positive support. The host preserves verified selected text and does not supply
missing model observations.

Attribution checks run in isolated contexts: one exact quote/claim pair per call,
then a separate overview check. Every raw subresponse and its input hash is kept.
The gate reconstructs those inputs from the original bundle and requires the
combined judgment to equal the recorded subresponses, preserving every veto.
Source observations include host-derived enclosing-function context when a full
source AST establishes it unambiguously. Document hashes and exact UTF-16 spans
bind the quote, function and header. Context establishes location/name only;
behavior must still follow from the selected quote. No inferred body is supplied.
There is no vote or favorable-result selection. At most 64 observations and one
overview are allowed, with one aggregate provider timeout; exhaustion is unknown.

The packet declares the requested criteria. Packet validation checks their shape,
nonempty unique IDs and evidence digests. Result validation checks that every
requested criterion appears exactly once; a missing result is rejected by the
coverage count after membership/duplicate checks. It does not infer an unrequested
criterion. The separate fixed-profile proof policy authenticates the complete
required criterion set for acceptance. These are three distinct boundaries.
`missing_evidence` contains descriptions of unavailable facts, never bare IDs.
An ID-only description in otherwise supportive analysis may receive the bounded
format retry. Valid negative/unknown findings or assessments remain blocking
even with that malformed auxiliary field; they are never retried into support.

Final public output includes status PASS | FAIL | CHUA_XAC_MINH, scope, findings,
root_causes, evidence_ids, missing_evidence, required_fixes, affected_files,
receipt_id and source_hash. Additional provenance contains provider/model attempts,
packet/registry hashes, criterion checks and deterministic proof obligations.
source_hash binds the root-qualified source manifest; invalid input has null.

Evidence IDs include their document kind/index and exact line anchor as well as
the packet-bound digest. A positive primary analysis is checked in a separate,
fresh 14B context containing only each selected exact quote and its explanation,
plus the overview. This attribution critic can veto; it cannot grant acceptance
or change a primary negative. Complete judgments bind the current packet,
registry, claim bundle and model. UNKNOWN/CONTRADICTED blocks without retrying a
valid veto. Reusing a receipt recomputes and compares the attribution proof hash.
Real calibration must reject the actual misattributions preserved in revoked
receipts while accepting a directly supported control, in two fresh calls.
This tests known semantic failures; it is not a claim of exhaustive proof.

Only the deterministic acceptance gate can produce final PASS. It requires:
- registered criteria and the exact source file set/root for that bounded scope;
- every host-owned verifier obligation satisfied by a real fixed-command TAP
  record, not skipped, duplicated, nested diagnostics or model prose;
- valid selected evidence of every required kind for every supported criterion;
- complete runtime receipt digest, command/cwd, source and protected-policy hashes;
- current dependency binding with no unresolved imports;
- no failing obligation, unresolved finding, missing evidence or uncertainty;
- no secret leakage and no revoked or renamed receipt.

Host tests verify behavior such as wrong scopes, tampered logs, malformed outputs,
revocation and source drift. Protocol fixtures test rejection boundaries only;
they are never presented as real AI review or autonomous trading evidence.
The model supplies critical semantic analysis; deterministic verifiers supply
separate required behavioral proof. Neither one alone can approve a module.

## Runtime and review policy

Local model inventory was inspected. Qwen3 14B is the largest available suitable
text model and is the primary critic under the owner's latest routing instruction.
The unmodified qwen3:14b is used rather than the application-specific alias.
One bounded retry on schema/ID/provider-incomplete output may inspect the same
immutable packet with a sanitized error code. A valid negative or unknown review
is final for that run. Provider outages return unknown. Two malformed attempts
return unknown, with secret-free diagnostic attempts retained. Private model
reasoning is never included in receipts. No TypeSafe fallback is allowed.

Source, diffs, comments and logs are untrusted model input, never instructions.
The collector only reads Botmeme and the expressly authorized MemePilot root.
General inspected source is never executed. Only named host checks run with
shell=false. The historical statistics counterexample is a known pure-function
check, not a production module acceptance. No frontend or HTTP endpoint is added.

Receipts are append-only and versioned jev-auditor/2. Recording and consuming a
PASS recomputes the gate from analysis, policy, registry and current bindings.
Revocation is permanent even after source restoration. A renamed or relocated copy
cannot bypass the canonical registry and receipt identity check. A prior FAIL for
the same scope, source and verifier-policy revision blocks a later supporting
review; restarting the CLI cannot erase an unresolved finding. v1 receipts remain historical comparison
evidence and cannot authorize v2 acceptance. Diffs preserve their real baseline
and never imply historical acceptance still applies.
Failure history uses a separately verified source/policy revision. Changing only
the comparison receipt cannot count as a fix or clear a prior FAIL. The comparison
receipt remains hash-protected against mutation. Historical FAIL records without
the new revision field are reconstructed from their bound evidence, or remain
blocking if that provenance cannot be established. Final acceptance requires the
configured primary Qwen3 14B; 8B analysis cannot authorize a freeze.

## Bootstrap and subsequent stages

Nine bounded bootstrap reviews cover contract/secrets, model service/transport,
collector/diff, dependency graph, registry/freeze, evidence registry, deterministic
acceptance, attribution veto and CLI. Every current receipt is required by the bootstrap gate.
A bootstrap PASS alone cannot authorize migration or Stage 2.

The existing 85 migration decisions remain 56 DROP / 22 PORT / 7 REWRITE pending
separate evidence reconciliation. No re-audit from scratch or wholesale legacy
runtime/server/paper-engine import is authorized by auditor bootstrap.

Five design perspectives: architecture separates analysis from authority;
provenance binds source/diff/log/check versions; security bounds reads and rejects
secrets; QA exercises counterexamples rather than trusting labels; operations
preserves failures and prevents stale/revoked acceptance. These are design
perspectives, not a claim of five external reviews.

Later-stage autonomy and network-switching requirements are binding in
`docs/AUTONOMOUS-INTELLIGENCE.md`, included and hash-protected in every packet.
Those modules are not implemented or approved by this auditor work. The target
remains autonomous paper mode, independent risk veto, valid NO_ACTION, durable
state and evidence-backed feedback. Only later-approved wallet controls may be
added at the bottom-left; no signing or live execution is enabled here.
