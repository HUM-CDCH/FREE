# Span grounding prototype — 2026-09-28

Status: source-span verification, unresolved-path scheduling, schema evidence policy
and origin/lexical routing implemented and tested in `feat/extraction-span-grounding`;
registration and live evaluation remain unfinished. See the [plan](../plans/2026-09-28-span-grounding.md).
Existing frozen study runs and production defaults are unchanged.

## Implemented behavior

`grounding=spans` offers deterministic ranges over complete canonical passage
text, plus intact table cells. The model returns an offered ID and attribution
boolean. The service reconstructs exact quotes and offsets, retaining canonical
parent/cell identity and measured or explicitly coarse geometry. Batches start
with 32 claims and split under actual token admission; malformed, missing,
unknown, negatively attributed and truncated decisions cannot create support.

`grounding_schedule=unresolved` independently carries full supported record
paths across units. Unsupported and unanswered claims remain eligible. This
avoids repeated verification after support, but does not search exhaustively
for contradictions.

`evidence_policy=schema` enables inherited `evidencePolicy` node metadata with
explicit child overrides. Matching Python/TypeScript validators accept `quoted`,
`derived` and `unverified`; omission inherits, explicit null is rejected. Derived
and unverified leaves retain their values, ungrounded paths and policy reasons.
The artifact and analyzer keep eligible counts alongside the original all-leaf
denominator. Empty eligibility is `not_applicable`, never complete grounding.
Policy metadata survives schema revisions, renames/retyping and PostgreSQL storage.
It does not change field extraction or imply correctness of a derived value.

## Verification

All commands used the existing interpreter at
`/home/gennaro/projects/FREE/prototypes/parsing_service/.venv/bin/python`, with
`PYTHONPATH=src:.` and `PYTHONDONTWRITEBYTECODE=1`, from this worktree's
`prototypes/parsing_service` directory.

- `-m pytest -q tests/test_extraction_span_grounding.py`: **20 passed**. Cases
  cover exact Unicode/control-character preservation, repeated occurrences,
  long cells, merged headers, measured/coarse geometry, negative/missing/unknown
  support, batching, refusal, truncation, cancellation and assembled scheduling.
- Existing method/structure/stage regression files: **72 passed**.
- `-m pytest -q -m 'not postgres and not live_model'`: **1,090 passed,
  72 skipped, 74 deselected**, with three existing dependency deprecations.
  This run included the first 18 new tests; two additional long-cell/occurrence
  tests subsequently passed in the 20-test focused run. No serving code changed
  between those runs.
- Six scripted full/bounded × semantic/quoted/off comparisons match the base
  checkout byte-for-byte for every request and artifact after removing only
  top-level start time and elapsed time. Evidence lives under
  `artifacts/extraction-ablation/span-grounding-20260928/` in the primary
  workspace: `reference-regression.py`, before/after JSON and
  `reference-verification.json`. Shared output SHA-256:
  `f1d993065b3875d34b069b98fa2a07c139ed7353597bb7d3e13bfd3130e06483`.
- OpenSpec strict validation and `git diff --check` pass. Manual bloat review
  covers new files; the scanner reports no findings in changed tracked code.
  Named method/scheduling controls are required experimental factors. No new
  dependency, service, queue, compatibility wrapper or automatic retry was added.

These checks establish deterministic implementation behavior. They do not
measure fresh model savings, claim entailment, retrieval recall, independently
reviewed table attribution, or authenticated product performance. The new
comparison must freeze identical upstream records before inference. All existing
R1/R2a/R3/R4 completion and final-report obligations remain open.

## Schema-policy verification

- Full fast Python suite: **1,104 passed, 72 skipped, 74 deselected**; focused
  schema/policy/span/study checks: **59 passed**. The final policy-only run has
  **14 passed**, including two subsequent checks for empty eligibility and
  rejection of links on skipped fields. No serving code changed between runs.
- Full Studio suite: **1,560 passed in 131 files**; extraction package:
  **73 passed**. Shared fixtures exercise both schema validators, revision POST/GET,
  schema changes and retention of policy reasons in the result adapter.
- Typechecks for db, extraction, extraction-result-export and Studio pass.
  Studio lint has zero errors and three pre-existing hook-dependency warnings.
- A real PostgreSQL test used the guarded disposable database
  `free_test_span_policy_264b0165`. Migrations and all **4 store checks** passed,
  including schema-policy write/read; the owned database was removed afterward.
  The existing server and databases were not reset. Receipt and redacted logs:
  `artifacts/extraction-ablation/span-grounding-20260928/policy-postgres-receipt.json`
  in the primary workspace.
- All six old-method scripted comparisons remain byte-identical after policy
  implementation (`reference-after-policy.json`, same SHA-256 above). The frozen
  study analyzer and collector remain untouched.

## Routing verification

`grounding_routing=origin_lexical` records per-leaf value-call origins, distinguishing
inventory-bound fields and remapping exact array items to their original indexes.
It ranks whole contexts by origins, lexical value matches and BM25 relevance, then
groups claims sharing their next unit. Unresolved claims reach every remaining
unit; refusal is distinct from an attempted call. Successful support stops only
that path, with unvisited contexts retained. Nothing claims contradiction recall.

- `tests/test_extraction_routing.py`: **15 passed**. Coverage includes array-index
  remapping, repeated occurrences, equal values in unrelated fields, scalar
  conflicts, identity provenance, late support outside preferred units, shared
  claim batching, NONE/missing/invalid/negative/truncated replies, budget refusal,
  cancellation, table/header context, policy skips and assembled artifact behavior.
- Full fast Python suite: **1,121 passed, 72 skipped, 74 deselected**, with the
  same three dependency warnings. This includes both additional policy tests.
- Six old-method scripted cases remain byte-identical, including requests,
  artifacts and fingerprints. Receipt: `reference-routing-verification.json`
  in the artifact directory above, output `reference-after-routing.json`, same
  SHA-256 as the original reference. No fresh inference occurred.
- Manual bloat audit includes the new module and tests; tracked-diff scanner
  reports no findings. The independent routing factor and fallback are explicit
  study requirements; the existing verifier remains the sole support owner.

Fresh cost, retrieval adequacy and semantic attribution remain unmeasured. An
origin is a reply provenance hint, not support; BM25 and value matching only order
work. Existing R1/R2a/R3/R4 source, collector and generation jobs are unchanged.
