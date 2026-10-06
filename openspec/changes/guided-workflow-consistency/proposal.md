## Why

The guided pilot workflow and the researcher's free actions overlap, and the
two disagree about what is done and what may run next: the schema-suggestion
confirmation runs collection-scale batches against unstabilised revisions, the
project stepper ignores stabilisation, staleness and newer unreviewed runs, and
three different "pilot" thresholds give contradictory next steps. This confuses
researchers and lets work bypass the pilot gate the workflow promises.

## What Changes

- Enforce the pilot gate on every Batch Extraction entry path, including the
  Batch Schema Suggestion confirmation, on both the client and the server.
- Derive the project workflow position and the Pilot/Batch/Validate steps from
  current facts: the current Schema Revision's stabilisation, whether the latest
  Extraction per Source Document is reviewed, and staleness.
- Use one pilot-selection limit everywhere; a run at or under it is a pilot and
  says so in the history list, the completion dialog and the review guidance.
- Make pilot guidance and next-step actions agree: no "skip the pilot" path that
  the collection gate immediately refuses, no stale "approved" banner after an
  in-place schema edit, and no reuse badge that the server does not honour.
- Count review progress against reviewable members only, consistently in the
  document tab bar and the review grid.
- Count durable native reviews in the project summary so a native pilot review
  advances the workflow, not only the batch-level progress.

## Capabilities

### New Capabilities

- `guided-pilot-workflow`: the pilot-to-stabilise-to-collection contract, its
  gates, and the workflow position and next-step guidance derived from durable
  state.

### Modified Capabilities

## Impact

- Studio client: `ProjectWorkflowSteps`, `BatchExtractionsPanel`,
  `BatchExtractionFinishedDialog`, `BatchExtractionReviewGrid`,
  `BatchExtractionScreens`, `DocumentTabBar` and `usePilotRoundProgress`.
- Extraction: batch admission and suggested-batch admission
  (`postgres-admission.ts`, `postgres-suggested-batch.ts`, `batch.ts`).
- Database: the Project Context activity summary in `project-store.ts`, and its
  contract snapshot.
- Tests: Studio unit tests, `db` and `extraction` unit tests, plus the existing
  PostgreSQL checks where the gate or summary is exercised.
