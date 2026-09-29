## Why

Studio's extraction workflow is a flat `ingest → chat → approve → extract →
validate` sequence computed in `project-store.ts`. "Approve" (committing the
first `SchemaRevision`) is the only gate before extraction, so there is no
distinction between "good enough to try on a couple of documents" and "good
enough to run across the whole collection" — a researcher can commit a
barely-reviewed schema straight to a full batch extraction. There is also no
guided path for iterating: nothing in the product tells a researcher to test
on a small pilot set first, to try a structurally different document before
trusting the schema, or when they might be ready to stop refining and scale
up. Researchers are left to invent this discipline themselves, and the
review grid gives them no help deciding whether to keep refining or move on.

## What Changes

- Introduce an explicit **piloting → stabilised** state on the schema side of
  a Project Context, replacing the implicit "any `SchemaRevision` unlocks
  everything" gate. Only a **stabilised** schema may be used for
  collection-level (batch) extraction; a piloting schema may only be used
  for small, explicit pilot-document extractions.
- Add a guided **pilot flow**: after committing a schema revision, the
  researcher selects 2-3 pilot documents and runs extraction only against
  those, instead of the workflow silently allowing a jump straight to batch.
- Add a **schema-issue flag** action to the review grid, scoped to a field
  (column), not a single value. Flagging a field offers a one-click jump to
  the schema editor carrying that field's context (name + example
  values/evidence). Committing a new `SchemaRevision` from that jump
  re-extracts the *same* pilot documents against the new revision; prior
  results for those documents are superseded, not kept alongside the new
  ones (they belong to a stale revision and are not a valid comparison).
- Add **multi-round pilot review**: when a researcher reviews/corrects
  results without changing the schema, the grid guides them to pick a *new*
  set of 2-3 pilot documents (different from the ones just reviewed) to test
  whether their corrections improved extraction on unseen documents. The
  grid then shows both rounds at once — the new round on top, the
  already-reviewed prior round collapsed below and marked as done — so
  researchers can compare without re-reviewing settled work. This stacking
  behavior applies only across rounds under the *same* schema revision.
- Add a **soft stop signal**: after each pilot round, surface a "you might be
  ready to stabilise" nudge (not a hard gate) once the aggregated issue/edit
  rate across rounds is declining, reusing the existing per-document issue
  score from `review-grid-prioritization`. Researchers can keep pilot rounds
  going indefinitely if they choose.
- Add an explicit **stabilise** action, gated on having at least one
  completed pilot round, that flips the schema from piloting to stabilised
  and unlocks batch/collection-level extraction.
- Change **batch/collection-level extraction** so that documents already
  piloted and reviewed under the current (now-stabilised) schema revision
  are folded into the batch output as-is, instead of being re-extracted.
- Guided copy/CTAs at each decision point (why correcting a value matters,
  when a schema-issue flag exists, when the researcher might be ready to
  stabilise, which documents will be reused vs. freshly extracted in a
  batch), plus a stepper/progress indicator reflecting the new phases.
- Support both schema-entry paths already in the product — chat-drafted
  schema suggestion and direct spreadsheet upload — as equally valid ways to
  reach the piloting state; this change does not alter either path itself.

**Dependency, not part of this change**: the "recycle a correction as a
few-shot example for the next extraction" mechanism referenced in the
product discussion for multi-round pilot review is the `schema-field-examples`
capability already designed (but not yet built) under
`extraction-review-metrics-and-sampling`, phase 3 — including its task 7
validation spike, which that change's plan requires before building the
examples/retry infrastructure. This change's multi-round pilot review UX
(new-round-vs-reviewed-round stacking, "select new pilot docs" guidance) does
not itself require that mechanism to exist — it works today by re-running
plain extraction on newly selected documents — but the "your corrections
improve future extraction" benefit only becomes real once
`extraction-review-metrics-and-sampling` tasks 7-9 are complete. That
dependency is intentional and out of scope here; this change does not modify
`extraction-review-metrics-and-sampling`'s files, capabilities, or its
validation-spike gate.

## Capabilities

### New Capabilities

- `guided-workflow-phases`: the piloting/stabilised schema state, its
  computation alongside the existing `ingest/chat/approve/extract/validate`
  phase, and the gating check that only a stabilised schema may be used to
  create a batch extraction.
- `pilot-review-rounds`: pilot-document selection (2-3 docs), single/small
  extraction against them, and the grid's multi-round stacking (new round on
  top, previously-reviewed round collapsed below) when reviewing without a
  schema change, including the soft "ready to stabilise" nudge.
- `schema-issue-flagging`: the field-scoped flag action in the review grid,
  the context hand-off into the schema editor, and the re-pilot behavior
  (same documents, new revision, prior-round results superseded) that
  follows committing a schema change from a flagged field.
- `batch-extraction-pilot-reuse`: batch/collection-level extraction reusing
  already-piloted-and-reviewed results for documents reviewed under the
  current stabilised schema revision, instead of re-extracting them.

### Modified Capabilities

(none — `review-grid-prioritization`'s issue-score computation is reused
as-is for the soft stop signal; no change to its requirements. `schema-chat-edit`
and `spreadsheet-schema-suggestion` remain the two existing, unmodified entry
points into the schema stage.)

## Impact

- **Backend**: `packages/db` (schema/state field + migration for
  piloting/stabilised, phase computation in `project-store.ts`), a new
  small model for schema-issue flags, `prototypes/studio/api` (gating check
  in the batch-extraction creation route, new flag/stabilise endpoints),
  `packages/extraction/src/batch.ts` (pilot-result reuse instead of
  re-extraction).
- **Frontend**: `prototypes/studio/src` pilot document picker,
  `BatchExtractionReviewGrid.tsx` (flag action, round stacking, evidence
  highlight on filename click, guided CTAs), `StudioHome.tsx` and
  `projectContext.contract.ts` (stepper/phase enum extension).
- **Depends on** (not modified by this change): `extraction-review-metrics-and-sampling`
  tasks 7-9 (`schema-field-examples`, `batch-extraction-retry`) for the
  few-shot correction-recycling benefit described in product discussion.
