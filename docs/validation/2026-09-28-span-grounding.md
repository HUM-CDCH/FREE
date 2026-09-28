# Span grounding prototype — 2026-09-28

Status: source-span verification, unresolved-path scheduling, schema evidence policy
and origin/lexical routing implemented and tested in `feat/extraction-span-grounding`;
R5 is registered and fresh evaluation remains unfinished. See the [plan](../plans/2026-09-28-span-grounding.md).
Existing frozen study runs and production defaults are unchanged.
Review: [draft PR #145](https://github.com/HUM-CDCH/FREE/pull/145), based on the
reporting branch. Fresh execution and scientific reporting remain open.

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

## Fixed-upstream runner verification

`grounding.ground_records` now owns the serving policy/scheduling loop independently
of record extraction. The R5 experiment calls that same function with frozen values;
it cannot generate document, inventory or record replies. Its artifact separates
grounding cost from pinned upstream provenance and fingerprints the upstream hash.

- All **15 Article sources / 81 records / 2,959 claim leaves** reproduce from
  **266 saved upstream replies** with HTTP disabled. Inventories, values, contexts,
  conflicts, call accounting and diagnostics match the original bounded artifacts.
  Origins retain exact original reply paths; bundles are in the primary workspace's
  `artifacts/extraction-ablation/grounding-preparation-20260928/`.
- Nine focused study tests cover unchanged values across all six methods, rejection
  of changed values/origins/options before registration, no upstream generation,
  exclusive result retention, cached admission probes and budget accounting on
  resumed captured replies. Full fast suite: **1,130 passed, 72 skipped,
  74 deselected**, with the same three dependency warnings.
- The six scripted reference comparisons remain byte-identical after moving the
  serving boundary (`reference-after-grounding-boundary.json`, same SHA-256 above).
- Every admission probe is saved, including split/refused batches. Preflight uses
  an explicit all-NONE scripted scenario; these are token counts, not inference
  outcomes or a promised speedup. The registered cumulative call-time admission
  limit retains exhausted cells as terminal failures and counts reused replies.

Registration and frozen execution receipts establish the concrete R5 state; the
tests and prepared inputs alone do not establish a completed fresh comparison.

R5 registration completed with HTTP disabled and validates **90 cells / 15 sources**
from its frozen 80-file runtime. Manifest SHA-256:
`46c3b73183a496f6f8d55ccc7c08cfc2030efad22f5136eb87b6d0d708bdeeee`.
The [plan](../plans/2026-09-28-span-grounding.md) records archive and operational paths.
The separate replay helper `docs/validation/extraction_grounding_replay.py` uses only
saved replies and tokenizer probes, checks seals and rejects missing probes. Its
focused suite has **10 passes**, including exact successful and budget-ended replay
with HTTP blocked. This additional check does not modify the registered runtime.

Denominator audit: **79 populated boolean leaves** are retained in fixed upstream
values but excluded by the historical `leaves()` claim enumerator. The 2,959 claims
and their policy-eligible subsets comprise nonblank strings and numbers, not every
scalar. This is an explicit coverage limitation, preserved across all R5 arms and
recorded in `claim-denominator-audit.json` before any fresh R5 inference. No claim
that those booleans are supported or semantically correct follows from this study.

## Tokenizer preflight

Completed at **2026-09-28 02:09:20 UTC**: all 90 registered cells, 23,077 tokenizer
requests, **zero fresh model calls**. HTTP-disabled replay reproduces the entire
scripted all-NONE report exactly, with no additional tokenizer requests. Every
cell's attempted plus refused claim–unit comparisons reconciles to its eligible
claims multiplied by its fixed context count.

| Method | Scripted requests | Input tokens | Attempted claim–unit pairs | Refused pairs | Eligible pairs |
|---|---:|---:|---:|---:|---:|
| quoted | 2,154 | 14,344,454 | 8,359 | 0 | 8,359 |
| spans | 764 | 7,087,230 | 6,617 | 1,742 | 8,359 |
| spans_unresolved | 764 | 7,087,230 | 6,617 | 1,742 | 8,359 |
| spans_policy | 568 | 5,224,004 | 4,514 | 1,535 | 6,049 |
| spans_unresolved_policy | 568 | 5,224,004 | 4,514 | 1,535 | 6,049 |
| spans_routed | 644 | 5,776,123 | 4,514 | 1,535 | 6,049 |

These are admission scenarios, not measured inference savings. Span-only refuses
**20.8%** of the potential comparisons; schema policy skips 792 of 2,959 enumerated
claims, leaving 2,167 eligible claims. Unresolved scheduling cannot save calls when
every scripted answer is NONE. Routing increases calls in that scenario because
different preferred units fragment shared batches; actual support may alter this.

Refusals occur on ten of fifteen documents. The largest span-only gaps are Harvey
472/1,296 pairs, Age 376/470, Hamburg 345/460 and Hvissinge **285/285**. Akita,
Mizuta, Zelechowska, 1790-06-17-1 and Brondbylund have no preflight refusal. Report
per-document results and coverage before aggregate cost or a deployment decision.

Hvissinge demonstrates the failure without inference: its single-claim span
requests need at least **10,605 input tokens**, above the **10,240-token** input
allowance (12,288 minus 2,048 output reserve). Four-claim quoted requests require
8,233–8,577 tokens. Splitting the claim batch cannot fix a one-claim overflow.
Complete span rendering and its identifiers add prompt overhead; exact canonical
IDs do not by themselves make the input compact. A future rendering correction
needs a separate registration, preserving complete source/table context and
server-side identity. No change to frozen R5 or its admission limit is implied.

Receipts live in the primary workspace's
`artifacts/extraction-ablation/20260928-r5-grounding/`: `preflight-finished.json`,
`preflight-summary.json`, `summarize_preflight.py`,
`preflight-offline-verification.json` and `replay-preflight.py`. Preflight report
SHA-256: `02ef658d20935ace0663cd4d690edcf5975093acc134a2ff16d6678c610b0597`.
Per-request counts and exact rendered requests remain in `token-counts/`.

At 02:12 UTC the verified R5 supervisor has no child and no generation-started
receipt; it waits for the original final collector. R1 has 68/79 sealed cells,
R2a has 30/30, and R3/R4 remain queued. The original Akita quoted run has finished;
its absence from the process list is not a reason to restart it. This state is a
checkpoint, not an experiment-completion claim.
