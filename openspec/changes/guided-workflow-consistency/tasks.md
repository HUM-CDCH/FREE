## 1. Server pilot gate

- [x] 1.1 Enforce `PILOT_BATCH_SELECTION_LIMIT` in `persistSuggestedBatch`: refuse a collection-scale confirmation against an unstabilised Revision with `schema_not_stabilised` before creating the Revision, batch or members
- [x] 1.2 Add an extraction-level test that a >limit suggestion confirmation is refused and writes nothing, and that a limit-sized one is admitted
- [x] 1.3 Remove the client `SUGGEST_SCHEMA` exemption from `collectionScaleNeedsStabilisedSchema` and gate suggestions on the selected member count, with copy that says to pilot at most the limit first
- [x] 1.4 Add a Studio unit test that a collection-scale suggestion disables Run and shows the pilot-sized requirement, while a limit-sized one stays runnable

## 2. Project activity summary

- [x] 2.1 In `listProjectContexts`, count a public Extraction as published when it succeeded or has a non-deleted `extraction_runtime.Head`, and build the latest Extraction per Source Document
- [x] 2.2 Count a Source Document reviewed only when its latest published Extraction is reviewed (stored `reviewedAt` or a native `Finalization` at the head's current snapshot), and derive staleness from that latest Extraction
- [x] 2.3 Compute the newest Schema's current Revision and mark it reviewed from a reviewed published Extraction against that exact Revision; use it for `phase`
- [x] 2.4 Update/extend `db` unit tests for latest-only review, staleness, a revised unstabilised Revision returning to `extract`, and a native head/finalization advancing the summary

## 3. Workflow stepper

- [x] 3.1 Use `summary.schemaStabilised` and `summary.staleSourceDocumentCount` in `ProjectWorkflowSteps` so pilot/batch/validate status reflects the current Revision and pending work
- [x] 3.2 Make exactly one displayed step current and make the "Next" control name the actual next step (pilot, approve-for-batch, or batch)
- [x] 3.3 Add `ProjectWorkflowSteps` unit tests for: revised unstabilised Revision, stale source, newer unreviewed run, reviewed current pilot, and single current step

## 4. Batch prepare and guidance

- [x] 4.1 Track the embedded schema editor's acknowledged Revision in `BatchExtractionsPanel` and use it for the approval banner, collection gate and pilot guidance, keeping the editor mounted per schema
- [x] 4.2 Offer "Skip — run the full collection instead" only when the chosen Revision is stabilised or the project cannot exceed the pilot limit
- [x] 4.3 Offer "Approve for batch extraction" when the gate can actually succeed, and direct the researcher to pilot first otherwise
- [x] 4.4 Replace the per-document "Reuses reviewed result" claim with an honest "Reviewed under this Revision" label unless the exact selection replays
- [x] 4.5 Add Studio unit tests for the stale-approval-after-edit, skip, approve and reuse-label cases

## 5. Consistent review progress

- [x] 5.1 Add a `reviewable` count to `batchExtractionProgress` and use `reviewed/reviewable` in the document tab bar and the review grid's fully-reviewed test
- [x] 5.2 Add tests for a pilot with a failed and an unreviewable member reporting complete review progress

## 6. One pilot threshold

- [x] 6.1 Use `PILOT_BATCH_SELECTION_LIMIT` for the completion dialog's pilot branch and the history list's pilot label
- [x] 6.2 Add tests that a 4-5 member unstabilised run is named and guided as a pilot in the dialog, list and review guidance

## 7. Verification

- [x] 7.1 Run `pnpm --filter studio test`, `pnpm --filter db test` and `pnpm --filter extraction test`
- [x] 7.2 Run `pnpm typecheck` and `pnpm lint`
- [x] 7.3 Update `openspec/changes/guided-workflow-consistency` status and record what remains
