# 0017: Durable Extraction control and call checkpoints

Date: 2026-10-04. Status: accepted; amends
[0012](0012-one-durable-execution-layer.md) (Extraction status authority) and
[0015](0015-extraction-method-pinned-at-admission.md) (method pins per input
selection).

## Context

One researcher-visible Extraction must survive cooperative pause, revised
settings, retries and live review without losing completed work. DBOS alone
cannot carry that lifecycle: an attempt that returns at a pause boundary is
runtime-successful while the Extraction is Paused, and DBOS messages cannot
establish which committed correction context a new call captured.

## Decision

- **The coordination head owns the visible lifecycle; DBOS dispatches and
  recovers attempts.** Immutable linked execution selections and a restricted
  PostgreSQL coordination schema (`extraction_runtime`) hold durable controls,
  call captures and checkpoints, and feedback publication. DBOS enqueue and
  recovery drive attempts but do not define the researcher-visible lifecycle.
- **The Parsing worker stays restricted.** It has no access to the
  application `public` tables or Studio's `dbos` schema, and receives only
  narrowly granted coordination routines that validate attempt fences and
  immutable inputs. Studio publishes corrections and eligible guidance
  revisions in one transaction.
- **Every provider call is a checkpoint.** It durably captures its inputs and
  context before invocation and commits its output before acknowledgement.
- **Pause drains; Resume links.** A paused attempt drains and exits, releasing
  capacity; Resume creates a linked attempt that reuses eligible saved work.
- Stable source anchors and result identities are distinct from
  schema-dependent work-window boundaries.
- Review reads each value through its immutable producing schema, and an
  approval or rejection binds to the model version actually reviewed.
- Article aggregation retains historical lineage and explicit scalar proposals.
- Cleanup of a deleted graph's native history waits for the Parsing worker's
  boot boundary, so cancellation alone never proves quiescence.
- **No legacy compatibility.** There is no legacy result reader or identity
  mapping, protocol-0 fallback, Cancel-to-Stop translation or mixed-protocol
  export. Retry applies to durable attempts in the same Extraction.
- Rejected: DBOS rewind and rewriting an old admitted method, because both
  would corrupt historical attribution; another job scheduler; worker access
  to researcher account configuration; weaker source Evidence requirements.

## Consequences

- An Extraction's status comes from its head, not from DBOS as 0012 derives
  other work's status.
- 0015's immutable method pin applies to each linked execution selection, not
  only to the first admission.
- The DBOS application versions stay `studio@1` and `kei@1`: durable attempts
  are new workflows, not changed ones.
- The [product contract](../product-contract.md) states the Extraction
  contract, and the
  [durable execution design](../design/unified-durable-execution.md) its
  workflows, queues and cleanup.

## Durable-only amendment

2026-10-05. Admission, readers, review, finalization and exports use the
durable model alone. Successful admission commits the Extraction, its durable
head and its workflow enqueue in one transaction. A public Extraction row
without a live coordination head is not listed or opened. The worker registers
only `convert`, `deleteRuns` and the durable `extractDurableV1`,
`extractionCallV1` and `deleteDurableHistoryV1` workflows; durable attempts
keep the `kei-extract` lane. Garbage collection keeps a run while a surviving
revision or any durable head, tombstoned heads included, pins it, and deletes
a deleted graph's DBOS history only after its native calls are quiescent.
Project summaries and activity count an Extraction as extracted once it is
COMPLETED or any of its result/decision pairs is finalized, and as reviewed
once a pair is finalized, whatever its processing state. This amendment
supersedes [0016](0016-review-drafts-on-a-running-extraction.md).

## Admission amendment

2026-10-05. Valid requests admit durable Extractions directly. There is no
release flag, environment switch, disabled-admission error or non-durable
fallback.

## Live results amendment

2026-10-06. The results rail follows the latest saved results while a run
reads, instead of staying on the first saved cut; only an explicitly opened
cut (a finalized review, a saved-correction link, History's "Open") stays put.
A finished unified Catalog entry, and each Article grounding batch, retains its
verified Evidence links at once, so values are marked on the source as they
are read. Pause, Resume, Retry and Stop take the run button's place.

Discovery's reply is streamed by the transport only: the captured request is
sent unchanged plus the provider's `stream` and usage options, and the call is
read, checked and committed exactly as an unstreamed one (a server that ignores
the stream answers once and is read as before). While it is generated, the
worker shows the places it has completed, and the planner the record starts
earlier windows found, as DBOS events Studio reads for display only; nothing in
a run reads them back, and failing to write them never fails a call.

## Discovery guidance amendment (2026-10-07)

New record-boundary discovery inputs exclude field-value correction examples;
those examples still guide value extraction and the other existing stages.
Captured `omissions` records each excluded revision with reason `stage`.
The composer-1 exact-input protocol remains unchanged: already finalized
requests and checkpointed answers are never recomposed. This narrows which
guidance belongs to the discovery task, without changing workflow steps or the
DBOS application version.
