## 1. Three-way classification (foundation for phases 1-2)

- [x] 1.1 Implement `classifyExtractionFields(schemaNodes, result, evidence)` as a single pass over schema leaf nodes, returning `{ grounded, ungroundedWithValue, missing }` counts (and per-path category if needed by the grid), per design.md D1.
- [x] 1.2 Add unit tests covering: fully grounded result, mixed result, empty-array leaf, nested object with all-null children, and confirming counts always sum to leaf count.
- [x] 1.3 Add a regression test asserting the classifier's output is NOT derived by subtracting `resultStats.ts` and `grounding.ts` outputs (guards against reintroducing the reconciliation bug).

## 2. Single-document finished dialog

- [x] 2.1 Update `ExtractionFinishedDialog.tsx` to call the new classifier and render grounded / ungrounded-with-value / missing counts.
- [x] 2.2 Remove the old two-bucket (grounded / could-not-be-grounded) display logic once the three-way version is verified.

## 3. Batch finished dialog

- [x] 3.1 Update `BatchExtractionFinishedDialog.tsx` to show total succeeded-document count.
- [x] 3.2 Reuse the classifier per document; render a detail row only for documents with `ungroundedWithValue > 0` or `missing > 0`.
- [x] 3.3 Add a collapsed summary line for the remaining clean documents (count only, no per-document row).
- [x] 3.4 Add tests/storybook-style coverage for: all-clean batch, mixed batch, all-problem batch.

## 4. Grid issue score and sorting

- [x] 4.1 In `useBatchExtractionReviewGrid.ts`, compute each member's issue score (`ungroundedWithValue + missing`) via the classifier, using already-loaded diagnostics/result data (design.md D2).
- [x] 4.2 Add default sort by issue score descending in `BatchExtractionReviewGrid.tsx`; keep existing member iteration as a stable tiebreaker.
- [x] 4.3 Add tests confirming sort order matches descending issue score and is stable for ties.

## 5. Two-tier review-priority flagging

- [x] 5.1 Implement the forced-tier threshold check (score exceeds configured threshold) as a client-side constant, per design.md D3.
- [x] 5.2 Implement `reviewCount(N)` (`N` for `N<=5`, `max(5, ceil(sqrt(5*N)))` otherwise) and the sampled-floor selection over below-threshold members.
- [x] 5.3 Render a "priority review" badge on flagged rows in the grid; confirm no change to `reviewable`/approval controls for unflagged rows.
- [x] 5.4 Add tests for: N<=5 (all flagged), N=100 (23 flagged, mix of forced+sampled), all-clean batch (sampled floor only), all-bad batch (forced tier only, no sampling needed).

## 6. Phase 1-2 validation

- [ ] 6.1 Manually verify all three report surfaces (single-document dialog, batch dialog, grid) against a real batch with a known mix of grounded/ungrounded/missing fields.
- [ ] 6.2 Confirm with the researcher whether the forced-tier threshold default feels right on real data; adjust the constant if not.

## 7. Phase 3 validation spike (gate before building retry/examples infra)

- [ ] 7.1 Query existing `ReviewDecision` data for the action mix (`APPROVED` vs `EDITED` vs `REJECTED`) per field, before assembling any example set. `REJECTED` never carries a value and must be excluded from example sourcing regardless of outcome (see design.md D4); this check is specifically about whether `EDITED` volume is high enough to supply "correction" examples, or whether the pool would rely almost entirely on `APPROVED` confirmations.
- [ ] 7.2 Pick 2-3 fields with enough `APPROVED`/`EDITED` decisions per 7.1; manually assemble a small few-shot example set (value + source excerpt) for each.
- [ ] 7.3 Manually inject those examples into the prompt (no schema/infra changes yet) for a handful of not-yet-extracted documents and compare grounded/ungrounded/missing rates and correction rates against a baseline run without examples.
- [ ] 7.4 Decide, based on 7.1-7.3, whether to proceed to tasks 8-9 below. If `EDITED` volume is very low, note that as a separate finding: it points at Edit-input friction (free-text only, no assisted population from source text) as a follow-up UX problem, independent of whether the few-shot hypothesis itself holds. If the hypothesis doesn't hold, stop here and document findings instead.

## 8. Phase 3 (only if 7.4 is a go): batch-extraction-retry

- [ ] 8.1 Add a batch/member-scoped retry endpoint mirroring the existing single-document `retryOfId` pattern (new `Extraction`/`ExtractionJob` row linked to the prior one, prior attempt untouched).
- [ ] 8.2 Add a bulk "retry all not-yet-reviewed members" action that skips already-reviewed members; make it a manually-triggerable button, available at any time (never invoked automatically).
- [ ] 8.3 Add a "priority review done" signal (all `review-grid-prioritization`-flagged members have `reviewedAt`) and surface/highlight the bulk retry action as a suggestion when it becomes true — do not gate this on the batch's existing all-members `needsReview` metric, since sampling means not every member needs review.
- [ ] 8.4 Update `useBatchExtractionReviewGrid.ts`'s `retryMember` (currently only reloads cached state) to actually trigger the new retry endpoint, or introduce a clearly-named separate action if reload-only behavior must be preserved elsewhere.
- [ ] 8.5 Add tests: retry preserves prior attempt, retry pins to current schema revision, bulk retry skips reviewed members, retry suggestion fires when priority-flagged members are done (not per-decision, not gated on non-flagged members), suggestion never blocks the manual action from being available earlier.

## 9. Phase 3 (only if 7.4 is a go): schema-field-examples

- [ ] 9.1 Add optional `examples: { value, sourceExcerpt? }[]` to leaf `SchemaNode`s (additive, non-breaking), kept separate from the existing group-only `description`.
- [ ] 9.2 Implement aggregation of `APPROVED`/`EDITED` `ReviewDecision`s (never `REJECTED`, which carries no value) into per-field (column-scoped, not row-scoped) example candidates.
- [ ] 9.3 Persist example updates as a new `SchemaRevision` via the existing append-only revision mechanism; confirm prior `ExtractionAttempt`s remain pinned to their original revision.
- [ ] 9.4 Implement a cap on examples per field consumed during prompt compilation (`compileInstructions`), selecting a bounded most-relevant subset.
- [ ] 9.5 Add tests: examples scoped to field not document, prior attempts unaffected by new revisions, leaf nodes still expose no `description` UI, example count capped during compilation.
- [ ] 9.6 Re-run the phase-3 validation comparison (task 7.3) end-to-end through the real infra before declaring this capability done.
