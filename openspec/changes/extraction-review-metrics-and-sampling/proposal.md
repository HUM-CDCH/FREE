## Why

Studio's extraction review surfaces (single-document finished dialog, batch
finished dialog, and the review grid) currently collapse "field has a value
but wasn't grounded" and "field has no value at all" into one bucket, and
compute that bucket by subtracting two independently-derived metrics
(`resultStats.ts`'s missing count and `grounding.ts`'s ungrounded-paths count)
that use different leaf-traversal rules — they silently disagree on edge
cases like empty arrays. The review grid also has no sort order at all, so a
researcher reviewing a large batch has no way to see the worst documents
first, and there is no standard for how many documents in a batch actually
need a human look before the researcher can trust the batch. Finally,
researcher corrections (`ReviewDecision`) are captured but never reach the
extraction pipeline — there is no mechanism today to let validated values
improve future extractions.

## What Changes

- Replace the two-bucket "grounded / ungrounded" report (single-document
  finished dialog and batch finished dialog) with a single three-way
  classification computed in one pass over schema leaf nodes — `grounded`
  (has a value with grounding evidence), `ungroundedWithValue` (has a value,
  no evidence link), `missing` (no value) — so the three counts always sum to
  the leaf field count by construction, instead of being reconciled from two
  independently-computed metrics.
- Batch finished dialog additionally shows the total successfully-extracted
  document count, and only lists per-document detail rows for documents with
  `ungroundedWithValue > 0` or `missing > 0`; clean documents collapse into a
  single summary line instead of one row each.
- Add a per-member "issue score" (`ungroundedWithValue + missing`, aggregated
  client-side from existing diagnostics/result data) to the review grid, and
  sort grid rows by that score descending.
- Add a review-priority indicator to the grid: documents are flagged
  "priority review" either because their score exceeds a threshold, or
  because they were picked by a size-scaled sampling floor over the
  remaining (low-score) documents, following a √N-based curve so the
  reviewed fraction shrinks as batch size grows while the reviewed count
  still grows. This is advisory only — it changes triage order and badges,
  not what a researcher is allowed to review or approve. No document is
  auto-approved or hidden from review as a result of not being flagged.
- **BREAKING**: none — no existing API/contract shape changes required for
  the above; these are additive UI/computation changes.
- (Exploratory, phase 3 — see Impact/Out of scope) Investigate closing the
  loop from researcher corrections back into extraction quality: per-field
  (not per-document) few-shot examples sourced from `APPROVED` (model's
  original value, confirmed correct) or `EDITED` (researcher-supplied
  correction) `ReviewDecision`s — never `REJECTED`, which carries no value at
  all — stored as a new leaf-scoped `examples` property
  alongside (not replacing) the existing group-only `description` property,
  versioned through the existing `SchemaRevision` mechanism, and a new
  batch/member-level retry capability (mirroring the existing single-document
  `retryOfId` pattern) to re-run not-yet-reviewed documents against the
  updated schema revision. This phase requires validating that few-shot
  injection actually improves accuracy before broader investment, and is
  scoped separately from phases 1-2.

## Capabilities

### New Capabilities

- `extraction-result-classification`: the single-pass three-way
  (grounded / ungrounded-with-value / missing) leaf classification, and its
  use in the single-document finished dialog and batch finished dialog.
- `batch-completion-summary`: batch finished dialog's success count and
  collapsed per-document reporting (detail rows only for documents with
  issues).
- `review-grid-prioritization`: per-member issue score, grid sort order, and
  the two-tier (forced + sampled-floor) review-priority flagging with its
  √N-scaled sampling curve.
- `batch-extraction-retry` (phase 3): batch/member-scoped extraction retry
  that creates new retry-linked extraction attempts for members of an
  existing batch, without overwriting prior attempts.
- `schema-field-examples` (phase 3, exploratory): a leaf-scoped, versioned
  `examples` list (value + source excerpt) distinct from the existing
  group-only `description`, populated from researcher review decisions and
  consumed by prompt compilation as few-shot guidance.

### Modified Capabilities

(none — `schema-field-descriptions` is unchanged; the new phase-3 `examples`
property is additive and leaf-scoped, deliberately kept separate from that
capability's group-only description rule rather than changing it)

## Open Questions For Review

1. **Is "review priority" ever allowed to gate approval?** This proposal
   assumes no — it only affects sort order and badges, and every document
   in a batch remains individually reviewable/approvable exactly as today.
   If a hard gate (auto-approve documents outside the sampled/flagged set)
   is actually wanted, that is a materially different and riskier proposal
   and should be scoped separately.
2. **Phase 3 scope commitment**: should `batch-extraction-retry` and
   `schema-field-examples` be fully implemented in this change, or should
   this change land phases 1-2 only, with phase 3 validated first via a
   small manual/scripted experiment (a handful of fields, manually inserted
   examples, compare extraction accuracy before/after) before committing to
   building the retry + examples infrastructure? Default assumption in
   `tasks.md` is the latter (validate first).

## Impact

- `prototypes/studio/src/projectContexts/ExtractionFinishedDialog.tsx`,
  `BatchExtractionFinishedDialog.tsx`: new three-way classification display.
- `prototypes/studio/src/projectContexts/BatchExtractionReviewGrid.tsx`,
  `useBatchExtractionReviewGrid.ts`: per-member score aggregation, sort,
  priority-flag rendering.
- New shared classification utility (single-pass schema-leaf walk), replacing
  ad hoc combination of `resultStats.ts` and `grounding.ts` outputs for
  reporting purposes (both files' existing computations are otherwise
  unchanged and still used elsewhere as today).
- Phase 3 only: `packages/extraction/src/schema.ts` (new `examples` node
  property), `packages/db` schema/revision persistence, a new batch-retry API
  route alongside `prototypes/studio/api/batch_extractions.ts`, and
  `packages/extraction/src/module.ts`/`job-worker.ts` for retry execution.
