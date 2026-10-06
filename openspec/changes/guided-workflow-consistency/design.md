## Context

The guided pilot workflow was ported onto dev from the donor branch
(`guided-pilot-extraction-workflow`, `guided-workflow-phases`). Its capability
specs did not come with it, so the rules live only in code comments, tests and
the partially adopted workbench plan. Meanwhile the researcher retains the old
free actions: free tab navigation, free schema editing (every edit appends an
immutable revision), free selection changes, re-runs and source reprocessing.

The overlap produces real defects: the Batch Schema Suggestion confirmation
bypasses the pilot gate on both sides; the Project Context summary and stepper
ignore stabilisation, staleness and newer unreviewed runs; three different
"pilot" thresholds disagree; and several next-step actions contradict the gate
that governs them.

Constraints:

- The README product contract: durable, versioned state; a repeated admission
  replays; schema suggestions feed the schema path and are not a competing
  extraction mode; partial review never becomes authoritative.
- `DURABLE_RELEASE_VERIFIED` is false, so durable admissions are off, but the
  native review code path and its PostgreSQL checks already exist and must not
  be left inconsistent with the project summary.
- The accepted workbench adoption deferred review transfer ("sample decisions
  in collection review") to a later change; this change does not add it.

## Goals / Non-Goals

**Goals:**

- One pilot-selection limit (`PILOT_BATCH_SELECTION_LIMIT`) decides what a
  pilot is, in naming and in gating.
- Every Batch Extraction entry path, including Batch Schema Suggestion
  confirmation, refuses a collection-scale run against an unstabilised
  Revision and creates nothing.
- The Project Context phase, the stepper and its "Next" action follow the
  current Revision's stabilisation, the latest Extraction per Source Document
  and its review, and staleness.
- Approval, skip and reuse affordances match what the server will admit.
- Review progress counts reviewable members consistently.
- A finalized native review advances the Project Context summary.

**Non-Goals:**

- No review-transfer or sample-result cloning; a changed selection still
  extracts normally.
- No change to the Extraction identity, pinning or replay rules.
- No enablement of durable admissions; the native summary path is reconciled
  but stays behind its release flag.
- No redesign of the review grid, the durable review rail or the schema editor.

## Decisions

### D1: Keep `PILOT_BATCH_SELECTION_LIMIT` as the one limit, fix the labels

`packages/extraction/src/batch.ts` already defines the gate limit (5). The UI's
`PILOT_LABEL_LIMIT = 3` and the completion dialog's `<= 3` are the outliers.
Use the shared constant for naming and for the dialog's pilot branch. The
pilot banner may still recommend "2-3 documents", but a 4-5 member run is a
pilot everywhere because that is what the gate admits. Alternative considered:
raise the label thresholds to 5 — rejected because it keeps two sources of
truth.

### D2: Enforce the suggestion pilot gate server-side, mirror it client-side

`persistSuggestedBatch` creates the Revision and the batch in one transaction.
Add the same check the ordinary batch admission uses: if the admitted members
exceed `PILOT_BATCH_SELECTION_LIMIT` and the target Revision (the existing one,
or the new one it is about to create) has no `stabilisedAt`, fail with
`schema_not_stabilised` before any write. The client removes the
`SUGGEST_SCHEMA` exemption from `collectionScaleNeedsStabilisedSchema` and,
because a fresh suggestion has no Revision yet, gates on the selected member
count. A pilot-sized suggestion confirmation still creates the Revision and
runs, so the researcher can review, stabilise and then use the ordinary batch
path for the collection.

Alternative considered: let the suggestion path auto-stabilise or auto-run a
pilot subset — rejected; stabilisation must follow a reviewed pilot, and
silently subsetting a researcher's selection would hide what ran.

### D3: Summary carries current-Revision facts; stepper derives from them

Today `reviewedSourceDocumentCount` counts a Source Document as reviewed when
*any* of its Extractions was reviewed, and `phase` flips on that. Change the
summary computation (`packages/db/src/project-store.ts`) to:

- consider a public Extraction row published when it has `outcome='SUCCEEDED'`
  (stored path) or a non-deleted `extraction_runtime.Head` (native path);
- build the latest Extraction per Source Document by `createdAt`;
- count a document as reviewed when its *latest* published Extraction is
  reviewed (stored `reviewedAt`, or a native `Finalization` at the head's
  current `snapshotVersion`);
- count staleness from that latest Extraction's source pin;
- compute `currentRevisionReviewed`: a reviewed published Extraction whose
  `schemaRevisionId` is the newest Schema's latest Revision (the same Revision
  the existing `schemaStabilised` field describes).

`phase` becomes `extract` until `currentRevisionReviewed` is true, then
`validate`. `ProjectWorkflowSteps` additionally uses `summary.schemaStabilised`
and `summary.staleSourceDocumentCount`: a Project with pending pilot work or
stale work is not "fully validated"; exactly one displayed step is current and
the "Next" control names the actual next step (pilot, approve-for-batch, or
batch). Alternative considered: derive the whole thing on the client from raw
batch lists — rejected; the summary is already the one bounded read the list
and stepper share.

### D4: The panel tracks the editor's acknowledged Revision

`SavedSchemaEditor` exposes the controller's acknowledged Revision (it already
has `schemaRevisionId`). The panel keeps it beside the loaded `chosenSchema`
and uses the acknowledged Revision for the approval banner, the collection
gate and the pilot guidance whenever it differs. The editor stays mounted
across revisions of the same schema (key by `extractionSchemaId`), so typing
is not remounted per save. Run already submits the flushed Revision, so the
gate and the admission then agree.

### D5: Honest labels for reuse and review counts

The per-document "Reuses reviewed result" badge becomes "Reviewed under this
Revision" unless the current selection exactly matches an already admitted
batch for that Revision (which is the only case the server replays). The
document tab bar's progress uses the reviewable subset: add `reviewable` to
`batchExtractionProgress` and use `reviewed/reviewable` there and for the
grid's "fully reviewed" test, so a failed or unreviewable member cannot leave
the indicator permanently short.

### D6: Native reviews feed the summary

The summary reads non-deleted `extraction_runtime.Head` rows for the listed
Projects and their `Finalization` rows, mapping a head to its Source Document
through the Source Representation Revision already read for the summary. The
read is bounded to the listed Projects and relies on the public Extraction row
for `createdAt` and the head's current `snapshotVersion`. This keeps
admissions gated off while making the summary correct if they are enabled.

## Risks / Trade-offs

- [The summary query grows when durable heads exist.] → Read heads once per
  listed page and finalizations by `extractionId in (...)`, never per Project
  or per Source Document; durable admissions are off, so the extra list is
  empty in production today.
- [Changing `reviewedSourceDocumentCount` to latest-per-document changes the
  Home card's "X of Y reviewed".] → That is the intended correction; a newer
  unreviewed run must not read as reviewed. Update the tests that encoded the
  old per-any-extraction behavior.
- [Suggestion runs over the limit become refused.] → The UI disables Run and
  explains the pilot-sized requirement; the suggested fields are still
  generated and editable, and the ordinary batch path runs the collection
  after stabilisation.
- [Projecting native heads into `packages/db` duplicates a little of the
  extraction module's durable-summary logic.] → Keep it to published/reviewed
  facts and cite the extraction module's contract; no payload parsing is
  needed at project level.

## Migration Plan

No database migration: the change uses existing columns, the existing
`extraction_runtime` namespace and the existing activity-summary contract. The
deployment is a normal Studio/Extraction release; roll back by reverting the
release. The contract snapshot is regenerated only if the summary DTO changes
(it does not; `currentRevisionReviewed` is internal to the summary read and the
existing `schemaStabilised` field is already on the wire).

## Open Questions

- None blocking. Whether a later change adds review transfer (sample decisions
  into collection members) stays with the deferred workbench follow-up.

## Verification notes

Run on 2026-10-06 with Node 25 (`NODE_OPTIONS=--no-experimental-webstorage`
so jsdom owns `localStorage`):

- `pnpm typecheck` and `pnpm lint` pass.
- `pnpm --filter extraction test` passes (246 tests).
- `pnpm --filter db test` passes 86/87; the only failure is
  `durable-extraction-migration.test.ts`, caused by the concurrent uncommitted
  `refs/db.json` and the new `20261005T2213_remove_batch_schema_suggestion_purpose`
  migration in this checkout, not by this change.
- `pnpm --filter studio test` passes 2303/2312; the nine failures are the
  environment-dependent `api/_pdf_pages.test.ts`, `server/playwrightStack.test.ts`
  and `server/workflows.test.ts` files (pdf.js workers, Playwright stack leases,
  application registration), untouched by this change.
- Remaining for a PostgreSQL/Docker host: run the new
  `postgres-suggested-batches.integration.test.ts` gate case and the full E2E
  tier. The new gate is also defended by the Studio client test and the
  extraction unit tier.
