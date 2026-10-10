# Runpod verification — 2026-09-24

The supplied pod is reachable through the owner's existing SSH key. Inspection
identified an NVIDIA L40S and a running `qwen3-32b` llama.cpp model, Q4_K_M,
with a 16,384-token serving context. The model is 32B parameters; this is not a
claim that a JavaScript test suite runs on GPU or that the pod has 32 GB RAM.

Existing Ga AI services and model configuration were not changed. A separate
`/workspace/botmeme-verification` directory contains a checksum-verified portable
Node v24.18.0 and isolated source snapshots. No credentials, wallet session,
trading history or legacy source were copied into the test snapshot.

## Recorded component run

`data/remote-tests/run-20260924-182137/runtime-tests.receipt.json` records the
remote Node run: **169 tests passed, zero failures/skips**, complete TAP output,
and matching before/after source hashes. Raw output is in the adjacent
`runtime-tests.tap`. This proves the listed component checks on that snapshot,
not later edits, Windows parity, live feed availability or full bot acceptance.

## JEV model transport

An SSH tunnel exposes the existing pod-local model endpoint only at
`127.0.0.1:18002` on the local machine. No new public model port was exposed.
`services/jev/auditor/llamacpp.cjs` is the model-specific transport; source review,
host-issued evidence IDs, attribution vetoes and deterministic acceptance remain
in the shared auditor implementation. The exact provider/model pair is
`ssh-llamacpp` / `qwen3-32b`.

The existing fixed-profile CLI selects this reviewer with the process setting
`JEV_REVIEWER=ssh-llamacpp`; its default remains the historical local reviewer.
Unknown providers are rejected. A running tunnel is required; there is no silent
fallback to a different model.

The first real transport probe returned JSON that did not match its requested
schema. The deployed server ignored the schema at `response_format.schema`;
using `response_format.json_schema.schema` fixed the protocol. A subsequent
actual `LlamaCppReviewer.complete()` returned the exact requested JSON in 13.55
seconds without changing model settings. This verifies transport/schema handling,
not evidence semantics or final acceptance.

`data/remote-tests/run-20260924-182536/runtime-tests.receipt.json` records the
subsequent auditor regression: **195/195 passed**, zero failures/skips, complete
TAP and unchanged snapshot hashes. It includes both new model-protocol and
reviewer-identity tests. These are separate from the 169 runtime component checks.

A real `auditor-cli` source/evidence review completed through the internal JEV
service on the pod using Qwen3-32B. Receipt
`1f9dbd46-18c4-46cd-8620-1f09ef841285` returned **FAIL** for
`JEV Auditor/fixed-profile-cli`: the reviewer reported missing source/runtime
evidence of the collector/reviewer/registry execution path. The local copy is
`data/remote-tests/run-20260924-182536/qwen32-review.receipt.json`.
This is a preserved negative review, not a model-connection failure and not an
approved migration plan. Diagnose the evidence coverage before changing code;
do not manufacture missing runtime proof or treat the passing unit tests as
semantic acceptance. The reviewer also attributed collector/registry internals
to `JevAuditor.audit`; that attribution needs checking against the actual caller
in `scripts/jev-audit.cjs` before accepting its proposed code fix.

Full paper E2E remains gated on the owner's actual wallet connection. The model
cannot sign transactions, change strategy authority, manufacture evidence or
override a failed/unknown acceptance gate.
