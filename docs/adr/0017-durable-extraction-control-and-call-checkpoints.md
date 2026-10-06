# 0017: Durable Extraction control and call checkpoints

Date: 2026-10-04. Status: accepted direction, implemented and verified in the isolated candidate under [Map durable interactive extraction and project-wide feedback](https://github.com/HUM-CDCH/FREE/issues/169). Production deployment/enablement remains a separate unapproved action.

One researcher-visible Extraction must survive cooperative pause, revised settings, retries, and live review without losing completed work. DBOS remains the durable executor, but an attempt that returns at a pause boundary is runtime-successful while the Extraction remains Paused; DBOS messages alone also cannot establish which committed correction context a new call captured. Use immutable linked execution selections and a restricted PostgreSQL coordination schema for durable controls, call captures/checkpoints, and feedback publication, with DBOS enqueue/recovery driving attempts rather than defining researcher-visible lifecycle.

The Parsing worker retains no access to the application `public` tables or Studio's `dbos` schema. It receives only narrowly granted coordination routines that validate attempt fences and immutable inputs; Studio publishes corrections and eligible guidance revisions in one transaction. Every provider call durably captures inputs/context before invocation and commits its output before acknowledgement. A paused attempt drains and exits, releasing capacity; Resume creates a linked attempt reusing eligible saved work. Stable source anchors and result identities are distinct from schema-dependent work-window boundaries. DBOS rewind or rewriting an old admitted method is rejected because it would corrupt historical attribution.

This direction will amend the Extraction-specific status authority in [0012](0012-one-durable-execution-layer.md) and extend the immutable selection rule in [0015](0015-extraction-method-pinned-at-admission.md) from one admission to each linked execution selection. It does not introduce another job scheduler, permit worker access to researcher account configuration, or weaken source Evidence requirements. Details and release conditions live in the [implementation specification](../plans/2026-10-04-durable-interactive-extraction-specification.md) and [migration/verification plan](../plans/2026-10-04-durable-interactive-extraction-release.md).

## Pre-production scope amendment

Scope amendment, 2026-10-04: the user confirmed this is pre-production and
removed historical extraction compatibility from this feature. No legacy result
reader/identity mapping, failed-legacy upgrade Retry, protocol-0 fallback,
Cancel-to-Stop translation, or mixed-protocol export is required. Retry applies
to durable attempts in the same Extraction. Immutable producing inputs,
corrections, source Evidence, restricted coordination, and the admission gate
remain required. This amendment supersedes the original planning map's legacy
release requirements; it does not change the settled durable product decisions.

## Durable-only amendment

Amendment, 2026-10-05: the user required durable-only code with no legacy
implementation or compatibility shim. Admission, readers, review, finalization
and exports now use the durable model alone. The non-durable `runExtraction`
workflow and its registration, path/anchor Review Drafts and settlement, the
review/draft/reset/cancel routes, the batch review grid and the old result and
batch exports were deleted. Successful admission now commits the Extraction,
its durable head and its workflow enqueue in one transaction. Saved durable
Extractions remain readable, controllable, reviewable and exportable. A public Extraction row without a live coordination head is not
listed or opened. No historical migration or table drop was made. The Parsing
Service's `extract` workflow, its artifact and progress routes, the stage files
and write-once records it published beside a run, and its `kei-extract:`
contract were deleted too. The worker registers only `convert`, `deleteRuns`
and the durable `extractDurableV1`, `extractionCallV1` and
`deleteDurableHistoryV1` workflows; durable attempts keep the `kei-extract`
lane. Studio's and the Parsing Service's garbage collection keep only current
ownership: a run stays while a surviving revision or any durable head,
tombstoned heads included, pins it, and a deleted graph's DBOS history goes
only after its native calls are quiescent. Project summaries and activity count
an Extraction as extracted once it is COMPLETED or any of its result/decision
pairs is finalized, and as reviewed once a pair is finalized, whatever its
processing state. The
living `canonical-evidence-lifecycle` specification and the retired
`result-tree-navigator` specification were reconciled with this model by the
OpenSpec change `durable-only-extraction-review`. Its completed infrastructure
and exploratory acceptance is recorded in the
[2026-10-06 merge acceptance](../validation/2026-10-06-pr188-merge-acceptance.md).

## Admission amendment

Amendment, 2026-10-05: the user required removal of the whole admission gate.
Valid requests now admit durable Extractions directly. There is no release flag,
environment switch, disabled-admission error, or non-durable fallback.
This amendment supersedes the admission-disabled clauses in ADRs 0012 and
0015 and the pre-production scope amendment above. Exact-commit Spark
acceptance is a merge prerequisite in the recorded
[OpenSpec tasks](../../openspec/changes/archive/2026-10-06-durable-only-extraction-review/tasks.md).
PostgreSQL checks cover successful single and batch admission, replay and enqueue
rollback. The Compose contract checks HTTP 201 followed by durable COMPLETED.
Merging this implementation removes the admission block. This follow-up must
pass its own infrastructure checks before deployment. The older validation and
plan records remain unchanged and describe their own source cuts.

## Candidate implementation and integration status

The candidate lives on `feat/durable-interactive-extraction`, based on current
`dev` (`db6f8b92`), with the planning commit and ADR 0016/redesign artifacts
preserved. Its `extraction_runtime` namespace adds no mutated historical public
Extraction pins. Runtime capability is selected by its Head row. DBOS attempts
and call workflows retain distinct names;
failed responses are immutable attempt-specific history, while successful
checkpoints are reusable by unchanged-input retries.

Review projection uses each value's immutable producing schema, independently
of consuming-target guidance compatibility. Stable child identities permit
nested renames; approvals/rejections bind to the actual reviewed model version.
Article aggregation retains historical lineage and explicit scalar proposals.
The shared results-review components consume stable saved values directly.
Whole-field edits validate against their producing type; optional correction
Evidence names explicitly selected occurrences from the pinned source.
Finalizations identify immutable result and decision cuts independently of
processing completion. Operational export history has its own capture time.
The source artifact and preprocessing generation stay referenced through
terminal states and deletion drain. Deleted graphs are fenced atomically with
public cascade deletion; native-history cleanup uses the Parsing worker's boot
boundary so cancellation alone never proves quiescence.

The completed PR 183 report satisfied the requested Spark wait. Guarded tests
then ran in a private Spark checkout, with disposable databases and isolated
resources. The integrated candidate passed lifecycle/recovery, shared review,
exports, deletion and selected real-provider checks at that earlier source cut.
The current follow-up removes the admission block. No production database
migration, merge or deployment is authorized by this work.
See the [integration evidence](../validation/2026-10-04-durable-review-integration-verification.md)
for exact source cuts, conditional skips and independent review.
