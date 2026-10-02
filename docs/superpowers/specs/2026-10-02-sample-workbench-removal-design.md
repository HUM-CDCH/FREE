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
  `reviewPairings` stay, with their comments rewritten to "retired on
  2026-10-02 with the sample workbench; never written; dropped by a later
  migration". No migration in this change.

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
  remain readable through their own ID (an open deep link) and are collected
  like any Extraction. They never appear as a document's `latestAttempt`: the
  reopen query keeps its existing `requestedPages IS NULL` condition, which is
  the one place the retired column is still read.
- The document reopen snapshot answers `latestAttempt` and `latestReviewed`
  only.

## Error handling

- A run request body with `pages`: 422 `invalid_request`.
- A `loadAdmitted` checkpoint written before this change that carries
  `requestedPages`: the workflow ignores the field; such a workflow is a
  sample's and was settled or cancelled before the deploy, per the drain the
  operations notes already require for record-scope upgrades.
- The retired columns are nullable; nothing fails on a null.

## Testing

- New: the reopen snapshot of a document that has a legacy sample row returns
  the whole-document attempt as latest; `keiExtractInputSchema` rejects
  `pages`; the run route refuses a body with `pages`; `App` renders no sample
  control and `PageNavigation` no checkbox; kei's `dispatch` reads the whole
  evidence for every strategy (a `run.py` unit test).
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
  nothing writing them).
- Any restyling (the redesign spec).
