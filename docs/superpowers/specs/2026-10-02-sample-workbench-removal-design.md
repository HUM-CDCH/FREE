# Sample workbench removal — design

Date: 2026-10-02 · Status: proposed, awaiting review · Scope: `prototypes/studio`,
`packages/extraction`, `packages/db` (contract comments only), `prototypes/parsing_service`
(the `options.pages` request field)

## Purpose

Sampling becomes an implementation detail of how an Extraction is ordered (see
`2026-10-02-view-ordered-streaming-extraction-design.md`); it is no longer a
mode a Humanities Researcher operates. The sample workbench that reached `dev`
through the PRs up to #156 is removed as a whole: the page selection, the
coverage facts, the sample review and its finalize flow, the sample decisions
pinned into whole-document runs, and the API and service options that exist
only for them.

This is a pure deletion with one review boundary. It goes first, before the
workspace redesign, so the layout work edits smaller files
(`App.tsx` and `SchemaPanel.tsx` lose their sample branches).

Decided with the researcher on 2026-10-02: "sampling as implementation detail,
hidden it" and "Remove the sample workbench".

## Constraints

- Base: a fresh worktree from `origin/dev` after `git fetch` (local `dev` is
  62 commits behind it), never an open PR branch.
- Migrations are forward-only. The columns the workbench added stay in the
  schema, are never written again, and a later migration drops them.
- Nothing changes for whole-document Extractions, their Review Decisions,
  drafts and finalize, Batch Extractions, or export.
- Domain language from `CONTEXT.md`.

## 1. Inventory: what goes

### Studio client (`prototypes/studio/src`)

- `App.tsx`: `samplePages`, `selectingSamplePages`, `SAMPLE_PAGE_LIMIT`, the
  "Select sample pages" / "Done selecting" button, the selection line
  ("Choose up to 30 pages", This page, ± 1 page, ± 2 pages, Clear), "Run
  sample", "Save & re-run sample", the sample monitor (`sample`,
  `sampleRunning`, `shownSample`, its cancellation, reconnect and status copy),
  the page argument of `runExtraction`, the `SampleFacts` mount above
  `RightRail`, and the `sample` prop handed to `RightRail`.
- `PageNavigation.tsx`: the `selecting`, `selectedPages`, `selectionLimit` and
  `onTogglePage` props, the per-page "Sample" checkbox and label, and the
  accent styling of selected pages. The navigation itself stays (§2).
- `SampleFacts.tsx` and `api.ts`'s `readSampleFacts`.
- `RightRail.tsx`: the `sample` prop, `SchemaSample`, and the sample variant of
  the "edit this field" hand-off (`editField(…, fromSample)`); the Results-tab
  variant stays.
- `SchemaPanel.tsx`: `SchemaSample`, the sample review block ("Finalize sample
  review", "Sample review finalized for these pages", draft saving and its
  errors, "No records extracted on these pages"), and the `ReviewAttention`
  mount with its `transfer` and `onFocusValue` wiring.
- `ReviewAttention.tsx`: the `transfer` prop and the "Changed since sample"
  filter. The component otherwise stays (§2).
- `ResultsTab.tsx`: the `transfer` pass-through, copy that names sample pages,
  and "Save & re-run sample".
- `projectContexts/BatchExtractionsPanel.tsx`,
  `projectContexts/BatchExtractionReviewGrid.tsx`,
  `useBatchExtractionReviewGrid.ts`: the `SampleFacts` mount for selected
  sources and every sample-specific branch.
- `useExtraction.ts`: the pages argument of `runExtraction` and `runRequest`,
  and the refusal copy that only a sample can trigger.

### Studio API and contracts (`prototypes/studio/api`, `prototypes/studio/shared`)

- `api/sample_facts.ts`, `api/sample_facts.postgres.test.ts`,
  `shared/sampleFacts.contract.ts`, and the route's registration in the API
  dispatcher.
- `api/document_reopen.ts` and `shared/projectContext.contract.ts`: the
  `samples` list on the document reopen snapshot. The snapshot keeps
  `latestAttempt` and `latestReviewed`.
- `shared/extraction.contract.ts` and `api/_extractions.ts`: `requestedPages`,
  the transfer verdicts and pairings on the attempt DTO, and the pages field of
  the run request body (a body that still sends it is refused as
  `invalid_request`, 422).

### Extraction package (`packages/extraction/src`)

- `types.ts`: `requestedPages` on run inputs, admitted rows and snapshots;
  `ReviewTransfer`, `TransferEntry`, `TransferRecord`, `ReviewPairing`, the
  per-value transfer verdicts, the "carried from" field on a decision, and
  `samples` on the document snapshot.
- `review-rules.ts`: `transferSample`, `transferEntries`, `alignRecords`,
  `unionReviewTransfer`, `transferPairs`, `TransferVerdict` and their callers.
- `review-attention.ts`: the transfer-aware parts; the attention list itself
  stays (§2).
- `postgres-admission.ts`: `requestedPages` in the admission identity and
  `samplesReviewTransfer`, the pin of sample decisions at admission.
- `postgres-attempts.ts`, `postgres-persistence.ts`, `module.ts`: every read
  and write of `requestedPages`, `reviewTransfer` and `reviewPairings`, and the
  sample entry points.
- `postgres-reviews.ts`: the `reviewPairings` read in `readStoredReviewDraft`,
  its write in `saveStoredReviewDraft` and its reset in `resetStoredReview`.
  Stored draft decisions are projected onto the remaining fields when read
  (a legacy `carriedFrom` is dropped), so a draft saved before this change
  still parses under the strict contract and keeps its values and version.
  A finalized review's replay check also accepts the digest recomputed from
  its stored decisions under the current normalization, so a review finalized
  with carried decisions before this change still replays instead of
  reporting a conflict.
- `postgres-workflow-store.ts`: `requestedPages` in `loadAdmitted`.
- `postgres-admission.ts`, `sameAdmission`: a row whose `requestedPages` is
  set (a legacy sample) never equals a new request, so reusing a legacy
  sample's ID for a whole-document run is a conflict, never a replay.
- `workflows.ts`: `requestedPages` on `AdmittedExtraction` and `options.pages`
  in `keiExtractRequest`. `kei-handoff.ts` needs no change: its `options`
  record is opaque, Studio stops sending `pages` because nothing adds it, and
  kei refuses it.

### Parsing Service (`prototypes/parsing_service/src/kei_exp`)

- `kie/extract/run.py`: `Options.pages`, its validator, its exclusion in
  `Options.dumped()`, and the evidence restriction in `dispatch`. The kei
  workflow contracts (`workflows/contracts.py`) never named the field, so
  nothing changes there.

### Database (`packages/db`)

- `src/prisma/contract.prisma`: `requestedPages`, `reviewTransfer` and
  `reviewPairings` on `Extraction`, and `carriedFrom` on `ReviewDecision`,
  stay, with their comments rewritten to "retired on 2026-10-02 with the
  sample workbench; never written; dropped by a later migration". No
  migration in this change.

### Tests and browser journeys

Every case whose subject is a Sample Extraction, sample facts, a review
transfer or a pairing is deleted; cases that use "sample" as a fixture word
stay. The files: `packages/extraction/src/postgres-admission.integration.test.ts`,
`postgres-attempts.integration.test.ts`, `postgres-batches.integration.test.ts`,
`postgres-reviews.integration.test.ts`, `review-attention.test.ts`,
`review-rules.test.ts`, `workflows.test.ts`; `prototypes/studio/api/_kei_exp.test.ts`,
`document_reopen.test.ts`, `extractions.test.ts`; `prototypes/studio/src/App.test.tsx`,
`ProjectNavigation.test.tsx`, `ResultsTab.test.tsx`, `SchemaPanel.test.tsx`,
`projectContexts/BatchExtractionsPanel.test.tsx`, `projectNavigation.test.ts`,
`useBatchExtractionReviewGrid.test.tsx`; `prototypes/studio/e2e/canonical-evidence-lifecycle.spec.ts`
(its sample steps) and `e2e/project-navigation.spec.ts`.

## 2. What stays

- `PageNavigation.tsx` as page navigation: numbered pages, the current page
  (pdf.js `pagechanging`), Arrow/Home/End keys, Escape to close, the "Pages"
  toggle in the document toolbar. The redesign spec restyles it.
- `SchemaImport.tsx`, `shared/schemaImport.ts` and the
  `schema_import_preview` route: the Excel codebook import arrived on the same
  branch but is a schema feature, not sampling. The redesign spec moves it
  behind the schema overflow menu. Assumption to confirm at review.
- `ReviewAttention.tsx` and `review-attention.ts` as the attention list over a
  whole-document result (required decisions remaining, ungrounded, missing).
- Review Decisions, drafts and finalize on whole-document Extractions, and the
  `/extractions/{id}/review` routes.

## 3. Behaviour after the removal

- Run extraction always runs the whole Source Document, as it did before the
  workbench.
- Admission identity is the source representation revision, the Schema
  Revision, the strategy, the recipe and the pinned method, as before samples.
  kei's request never carries `pages`, and `Options.dumped()` already excluded
  it, so the fingerprints and artifact identities of whole-document Extractions
  do not change.
- Rows that already carry `requestedPages` (samples made before this change)
  stay in the database and are collected like any Extraction, but the
  document route no longer reopens them: an explicit `extractionId` naming
  one answers 404 like any unknown Extraction, and they never appear as a
  document's `latestAttempt` or `latestReviewed`. The reopen query keeps its
  existing `requestedPages IS NULL` condition, and `sameAdmission` reads the
  column to refuse a reuse of a legacy sample's ID; those are the two places
  the retired column is still read.
- The document reopen snapshot answers `latestAttempt` and `latestReviewed`
  only.

## Deployment

- Studio and the Parsing Service deploy together, after the drain that
  `docs/operations/deployment.md` prescribes for record-scope upgrades: no
  sample workflow may be in flight when the new code starts, and none can be
  resumed afterwards.
- Browser tabs open from before the deploy must refresh: the strict response
  parsers of the old client reject responses without `latestSample`, and the
  new API refuses their run requests that carry `pages`. A draft those tabs
  kept in session storage with `pairings` or `carriedFrom` is dropped by
  recovery; the server draft wins.

## Error handling

- A run request body with `pages`: 422 `invalid_request`.
- A whole-document run posted under a legacy sample's ID: 409
  `extraction_id_conflict`, nothing enqueued.
- A stored draft or a finalized review that carries `carriedFrom` or
  `reviewPairings` from before this change: read back without them, values
  and version preserved; a repeated finalize of such a review replays.
- A `loadAdmitted` checkpoint written before this change that carries
  `requestedPages`: the workflow ignores the field; such a workflow is a
  sample's and was settled or cancelled before the deploy, per the drain the
  operations notes already require for record-scope upgrades.
- The retired columns are nullable; nothing fails on a null.

## Testing

- New: the reopen snapshot of a document that has a legacy sample row returns
  the whole-document attempt as latest; `keiExtractRequest` builds a request
  without `pages`; the run route refuses a body with `pages`; a
  whole-document run under a legacy sample's ID is a conflict; a stored draft
  and a finalized review with legacy `carriedFrom` and `reviewPairings` read
  back without them and the finalized one replays; `App` renders no sample
  control and `PageNavigation` no checkbox; kei refuses `options.pages` and
  `dumped()` carries no `pages` key (`run.py` unit tests).
- Removed: the sample cases listed in §1.
- Gates: `pnpm test`, `pnpm test:postgres`, `pnpm lint`, `pnpm typecheck` in
  `prototypes/studio` and `packages/extraction`; `uv run pytest` in the Parsing
  Service; the weekly browser e2e.

## Files

Deleted: `prototypes/studio/src/SampleFacts.tsx`,
`prototypes/studio/shared/sampleFacts.contract.ts`,
`prototypes/studio/api/sample_facts.ts`,
`prototypes/studio/api/sample_facts.postgres.test.ts`.

Edited: the files named in §1 and §2, and `CONTEXT.md` (the "Sample
Extraction" and "Carried Review Decision" entries are removed).

## Out of scope

- A general "carry Review Decisions from the previous reviewed attempt" when a
  document is re-run. The transfer as built carries sample decisions only; a
  general version is a separate spec, not an assumption of this one.
- Dropping the retired columns (a later migration, after a deploy has run with
  nothing writing them). That migration first disposes of the legacy sample
  rows (deletes them, or marks them), because `requestedPages` is their only
  scope discriminator.
- Any restyling (the redesign spec).

## Review log

- 2026-10-02, Codex (gpt-6.1-sol, read-only) over the spec, the plan and Tasks
  2 and 3. Accepted: `sameAdmission` must refuse a legacy sample's ID (§1, §3,
  Error handling); `postgres-reviews.ts` and `postgres-workflow-store.ts` were
  missing from the inventory and stored legacy drafts would have failed the
  strict contracts (§1); a finalized review's replay must survive the digest
  change (§1, Error handling); legacy sample deep links answer 404 rather than
  "remain readable" (§3); the Testing claim about `keiExtractInputSchema` was
  wrong (Testing); the reduced browser journey must decide its required
  decisions before saving (plan Task 5); the `onPick` overlay code is dead
  (plan Task 5); the batch snapshot tests depend on the removed sample query
  (plan Task 4); the deployment and old-tab paragraphs (Deployment); the fourth
  retired column and the disposition of legacy rows before the drop (§1, Out of
  scope). Already fixed before the review landed: the accidentally deleted
  Catalog test and the vacuous legacy-draft test (Task 3 fix round 1).
