## Context

Three report surfaces exist today for extraction results:
`ExtractionFinishedDialog.tsx` (single document), `BatchExtractionFinishedDialog.tsx`
(whole batch), and the review grid itself
(`BatchExtractionReviewGrid.tsx` + `useBatchExtractionReviewGrid.ts`), which is
a persistent, continuously-updated aggregate report rather than a one-time
toast.

Two independent metrics currently feed the "grounded/ungrounded" line in the
dialogs:

- `resultStats.ts` walks the extracted `result` payload directly and counts
  `missing` as any leaf that is `null`/`undefined`/`''`, with a special case
  that an **empty array** counts as exactly one missing "field" with no
  underlying schema-node identity.
- `grounding.ts`'s `groundExtraction` derives `claims` from
  `populatedContentPaths` (only populated scalar leaves generate a claim —
  empty/null leaves generate none) and returns `ungroundedPaths` as claims
  without a matching evidence link.

These two were never designed to be summed or subtracted against each other
— they use different traversal rules (result-shape vs. claim-shape) and
diverge on the empty-array case. No code today actually combines them; each
is rendered as an independent stat. A three-way classification therefore
needs its own single source of truth, not a combination of the two.

The review grid has no sort order (rows render in `batch.members` order) and
no per-member aggregate score. `needsReview` is a derived batch-wide count
(`succeeded.length - reviewed.length - unreviewable.length` in
`batchExtraction.contract.ts`), not a per-document flag, so there is nothing
to rank on today.

`ReviewDecision`s (approve/reject/edit per field) are persisted but only ever
read back to project a "reviewed" view of a result — they never re-enter
extraction. Schema is already versioned: `ExtractionSchema` has immutable
`SchemaRevision` snapshots, and every `Extraction`/`ExtractionJob`/
`BatchExtraction` pins a specific `schemaRevisionId`. `SchemaNode` already
has an optional `description`, but `schema-field-descriptions` restricts it
to group nodes only (leaf nodes SHALL NOT expose a description) — so
per-field few-shot content cannot reuse that property without changing that
capability's requirements, which this change deliberately avoids by
introducing a separate, leaf-scoped property instead.

Batch-level retry does not exist: `useBatchExtractionReviewGrid.ts`'s
`retryMember` only reloads a cached result into grid state: it does not
invoke the model. Single-document retry does exist and preserves history via
a `retryOfId` self-relation.

## Goals / Non-Goals

**Goals:**
- One classification function that is the single source of truth for
  grounded / ungrounded-with-value / missing counts, used identically by
  both dialogs and (for scoring) the grid.
- Grid rows sortable by issue severity, with a review-priority signal that
  scales sub-linearly with batch size.
- A phase-3 design sketch for closing the researcher-feedback loop, gated
  behind a validation step, that does not disturb the existing group-level
  `description` capability or existing schema revision history semantics.

**Non-Goals:**
- Changing what "grounded" or "reviewable" mean at the data-model level —
  this change only adds a reporting/scoring layer on top of existing
  `diagnostics`/`resultPayload` data.
- Any auto-approval or review-skipping behavior. Every document stays
  individually reviewable regardless of its score or sampling status.
- Building the phase-3 retry/examples infrastructure as part of this change
  before the underlying hypothesis (few-shot examples measurably improve
  accuracy) is validated.

## Decisions

### D1. Single-pass leaf classification, not derived from `resultStats`/`grounding` outputs

Write one function, e.g. `classifyExtractionFields(schemaNodes, result, evidence)`,
that walks schema leaf nodes once and, for each leaf, looks up (a) whether
the corresponding path in `result` has a value and (b) whether that path
appears in the evidence/grounded-paths set, then buckets it into exactly one
of the three categories. This guarantees
`grounded + ungroundedWithValue + missing === leafCount` by construction,
independent of how `resultStats.ts` or `grounding.ts` separately choose to
count arrays or nested structures for their own (unrelated) purposes.

*Alternative considered*: reconcile `resultStats()`'s `missing` with
`ungroundedPaths.length` and derive `grounded = fieldCount - missing - ungrounded`.
Rejected — this is exactly the subtraction the current code implicitly relies
on being safe, and the empty-array case (and any future divergence between
the two traversal rules) breaks it silently. A single traversal removes the
cross-system dependency entirely.

### D2. Per-member issue score computed client-side, not persisted

`issueScore = ungroundedWithValue + missing`, computed per grid member by
running D1's classifier against that member's cached `diagnostics`/
`resultPayload` (already loaded into grid state today). No new backend
field or migration needed for phases 1-2 — this is pure derived UI state,
recomputed on load/refresh.

*Alternative considered*: persist a score column on the extraction/member
row so it can be queried/sorted server-side. Deferred — not needed until
grids grow large enough that client-side sort becomes a real performance
problem; revisit if batches with thousands of members become common.

### D3. Two-tier review-priority flagging (forced + sampled floor)

- **Forced tier**: any document whose `issueScore` exceeds a fixed absolute
  threshold (e.g. more than 1 problem field, or more than X% of leaf fields —
  exact threshold to be tuned against real batches) is flagged regardless of
  sampling budget.
- **Sampled floor tier**: among the remaining (low/zero-score) documents,
  flag `reviewCount(N) - forcedCount` more, evenly sampled, where:

  ```
  reviewCount(N) = N                                  , N <= 5
  reviewCount(N) = max(5, ceil(sqrt(5) * sqrt(N)))     , N > 5
  ```

  This is a √N-style sampling curve (the sample size grows with the square
  root of the population, so the *count* still grows but the *fraction*
  shrinks) — analogous to statistical audit-sampling practice, chosen over a
  fixed percentage because a fixed percentage either over-reviews huge
  batches or under-reviews small ones, and over a fixed count because that
  under-reviews large batches entirely.

  Rationale for the two tiers together: sorting by score alone and reviewing
  only the top-K would never surface a "confidently wrong but technically
  grounded" document — the sampled floor exists specifically to catch that
  blind spot in documents that look clean.

*Alternative considered*: a single percentage tier (e.g. always review top
20%). Rejected per the open critique — doesn't reduce to "review everything"
for N<=5, and doesn't provide any floor coverage of clean-looking documents.

This is advisory (badge + sort position) only. It does not change
`reviewable`/`needsReview`/approval semantics anywhere in the data model.

### D4. Phase 3 sketch: leaf-scoped `examples`, separate from `description`

If validated, add `examples?: { value: unknown; sourceExcerpt?: string }[]`
to `SchemaNodeBase` (or a leaf-specific subtype), populated by aggregating
`ReviewDecision`s **per field (column)**, not per document (row) — the
original plan's "row" framing was backwards, since `description` (and the
new `examples`) are field-level (column) properties shared across every
document that uses the schema, not document-scoped. Written as a new
`SchemaRevision` (append-only, same mechanism as any other schema edit) so
history/audit behavior is inherited for free and no existing
`ExtractionAttempt` is retroactively affected (they stay pinned to their old
revision id).

**Only `APPROVED` and `EDITED` decisions can source an example — `REJECTED`
cannot.** `extraction.contract.ts` enforces at the schema level that only an
`EDITED` decision may carry a `reviewedValue`; `REJECTED` always has
`reviewedValue: null` (confirmed in `postgres-persistence.ts`'s
`applyReviewDecisionsToResult`: "REJECTED clears the value, EDITED
overwrites it, APPROVED leaves the raw value alone"). So a `REJECTED`
decision is a pure negative signal — "this was wrong" — with nothing usable
as a training/example pair; it must be excluded from example generation
entirely, not treated as a weaker or partial signal.

This also matters for adoption risk: the grid's Edit control today is a
plain free-text `<input>` with no assisted population from the source
document (the researcher must retype the full corrected value from
scratch), which is real friction and could mean `EDITED` decisions are rare
in practice even when `REJECTED` ones are common. `APPROVED` carries no such
friction — it is the action researchers already take for every field that's
already correct — so counting `APPROVED` as a valid example source (not just
`EDITED`) is what keeps the example pool from depending entirely on the
higher-friction edit path. The phase-3 validation spike (tasks.md §7) should
check the actual `APPROVED`/`EDITED`/`REJECTED` mix in existing data before
any infra is built: if `EDITED` turns out to be vanishingly rare, that by
itself doesn't kill the approach (since `APPROVED` still supplies confirmed
positive examples), but it does mean the "correction" half of the feedback
loop (fixing specifically-wrong fields) provides little signal until Edit's
friction is addressed — a separate, later UX investment (e.g. pre-filling
the edit input from the nearest grounding-evidence excerpt), out of scope
here.

Kept separate from `description` rather than lifting the leaf restriction in
`schema-field-descriptions`, because that capability's requirements
explicitly scope description to group nodes for UI/authoring reasons
unrelated to few-shot guidance — reusing it would conflate "what a
researcher wrote to explain a field" with "machine-aggregated correction
examples," which have different lifecycle, provenance, and pruning needs
(examples need a cap and a curation/dedup strategy; descriptions don't).

Retry target: default to re-running not-yet-reviewed members of the same
batch against the new schema revision (the actual point of the feedback
loop), not the just-annotated document itself (which would just replay the
correction back at itself). Requires a new batch/member-scoped retry
endpoint mirroring the existing single-document `retryOfId` self-relation
pattern, since `retryMember` today only reloads cached state.

**Trigger timing: an explicit action, surfaced once priority-flagged review
is done — not per-annotation, and not gated on the batch's existing
`needsReview` metric.** There is no existing "batch review complete" action
in the codebase today (`finalizeReview` in `module.ts:120-192` is
per-document, not per-batch); the closest existing signal is
`batchExtractionProgress`'s `needsReview` reaching 0 (every succeeded,
reviewable member has `reviewedAt`). That signal doesn't fit here: phase 2's
review-grid-prioritization deliberately does *not* require every member to
be reviewed (only the priority-flagged subset), so gating the retry offer on
`needsReview === 0` would rarely or never fire for batches where the
researcher — by design — only reviews the flagged subset. Instead, the bulk
retry action stays a manually-triggerable button at all times, and FREE
additionally *suggests*/highlights it once every "priority review"-flagged
member (forced tier + sampled floor, from `review-grid-prioritization`) has
`reviewedAt` set — reusing phase 2's own flagging output as the completion
signal, rather than the pre-existing all-members metric that isn't
compatible with sampling-based review.

## Risks / Trade-offs

- [Threshold tuning for the forced tier is a guess until tried on real
  batches] → Ship with a conservative default, make it easy to adjust
  without a migration (client-side constant first; move server-side only if
  needed).
- [√N curve is a heuristic, not empirically validated for this domain] →
  Treat reviewCount as a UI suggestion only (D3), so a wrong curve degrades
  triage quality, not correctness — nothing is auto-approved based on it.
- [Phase 3: unbounded growth of examples per field would bloat prompts] →
  Cap per-field examples at a small K, chosen when phase 3 is scoped;
  explicitly out of scope for phases 1-2.
- [Phase 3: schema revision churn — every annotation-driven update creates a
  new SchemaRevision] → Existing revision history is already designed for
  frequent appends (optimistic-concurrency writes), so this is within
  intended usage. Retry itself is never automatic-on-save: bulk retry is
  always a manual researcher action, only *suggested* once priority-flagged
  review is done (see D4's "Trigger timing").

## Migration Plan

- Phases 1-2 are additive UI/computation changes with no schema or API
  changes — no migration or rollback concerns beyond normal feature
  deployment.
- Phase 3 (if greenlit) requires a `SchemaNode` shape addition (additive,
  optional field — non-breaking for existing revisions) and a new retry API
  route; sequence: validate the accuracy hypothesis manually first (see
  Open Questions in proposal.md), then design the retry endpoint and
  examples-authoring flow as their own follow-up change.

## Open Questions

- Exact forced-tier threshold for D3 (needs tuning against real batch data).
- Whether `issueScore` should eventually move server-side (D2) once/if grid
  sizes make client-side computation a bottleneck.
- Phase 3 is explicitly deferred pending validation; no open design question
  blocks phases 1-2.
