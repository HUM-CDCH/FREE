## 1. Gold-standard corpus data model

- [x] 1.1 Add `EvaluationCorpus`, `EvaluationCorpusVersion` (append-only, mirroring `SchemaRevision`'s shape/optimistic-concurrency pattern), and `GoldRecord` to `packages/db/src/prisma/contract.prisma`.
- [x] 1.2 Add persistence functions: create corpus, append a new version (document set + `GoldRecord`s), get/list versions — mirroring `project-store.ts`'s `appendSchemaRevision`/`initializeSchemaRevision` pattern.
- [x] 1.3 Add a `identifying?: boolean` property to `SchemaNode` (`packages/extraction/src/schema.ts`), additive/optional, for record-alignment key fields.
- [x] 1.4 Add an `evaluationTolerance?` property to `SchemaNode` for numeric fields (design.md D3), additive/optional. (Restricted at the type/zod level to `number`/`integer` fields only — the prior single non-string-scalar union branch was split so `evaluationTolerance` can't be set on `verbatim-string`/`date`/`boolean`.)
- [x] 1.5 Tests: appending a corrected version never mutates a prior version; documents are referenced (not duplicated) by existing `sourceDocumentId`/`sourceRepresentationRevisionId`. (`project-store.test.ts`'s "ResearcherProjectStore Evaluation Corpus" block; `schema.test.ts` covers `identifying`/`evaluationTolerance` validation.)
- [x] 1.6 Add `@@unique([projectContextId, originalName])` to `SourceDocument` (`contract.prisma:101-115`), with a pre-flight check for existing collisions before the migration adds the index (design.md D1c/Risks — decide the resolution mechanic for any found). Reject an upload whose `originalName` already exists in the project (`source_documents.ts`), as a new check ahead of the existing `contentSha256`/`ingestionKey` dedup in `project-store.ts`'s `ingestSourceDocument`. Not evaluation-specific — this changes upload behavior for every caller. (Migrated and applied to the local dev database.)
- [x] 1.7 Tests: uploading a different-content file whose name collides with an existing document in the same project is rejected with a clear error; the same name in a *different* project succeeds; existing content-hash/`ingestionKey` dedup behavior is unaffected.

## 2. Spreadsheet ingestion: purpose choice, filename resolution, gold-record population

Depends on `openspec/changes/spreadsheet-schema-suggestion` for
project-scoped spreadsheet storage/versioning, parsing, column-type
inference, and the confirmed column-to-field mapping + `projectSpreadsheetVersionId` —
not rebuilt here.

- [x] 2.1 Add the purpose choice (`SCHEMA` vs `SCHEMA_AND_VALIDATE`) to the spreadsheet-derived suggestion-creation flow (not the upload flow — uploading is purpose-agnostic in the sibling change), delegating schema-seeding to `spreadsheet-schema-suggestion`. (`BatchSchemaSuggestion.purpose`, required on `POST /api/batch-schema-suggestions/from-spreadsheet`; nullable, only ever set for `SPREADSHEET`-kind suggestions.)
- [x] 2.2 Implement filename resolution against the project's `SourceDocument`s (`originalName`): a match resolves automatically (unambiguous by construction once §1.6's uniqueness constraint lands — at most one document can share a given `originalName` in a project); zero matches reported as an error naming the row/filename. A spreadsheet MAY still have multiple *rows* sharing one filename — that's §2.3's per-row-not-per-filename handling, not a resolution ambiguity. (design.md D1d: the spreadsheet's `filename` column — case/whitespace-insensitive — identifies the row's document and is excluded from schema-seeding entirely, not just from gold-population; `packages/extraction/src/gold-spreadsheet.ts`.)
- [x] 2.3 For `SCHEMA_AND_VALIDATE`: once `spreadsheet-schema-suggestion` confirms the schema, read the confirmed suggestion's pinned `projectSpreadsheetVersionId` and map its row values (via the sibling change's confirmed column-to-field mapping and 2.2's resolved filenames) into `GoldRecord`s under a new `EvaluationCorpusVersion` (§1), one `GoldRecord` per row (not per filename — multiple rows sharing a filename become multiple records under that document). This works correctly however long after creation confirmation happens, and even if the project's spreadsheet has since been re-uploaded, since the suggestion pins a specific version rather than "whatever is current." (Runs inside `persistSuggestedBatch`'s existing confirm transaction, `packages/extraction/src/postgres-suggested-batch.ts` — schema-seeding and gold-population commit or fail together; an unresolvable row throws and rolls back the whole confirm, per design.md D1d.)
- [x] 2.4 Tests: unambiguous filename resolves automatically; unmatched filename is reported as an error, not skipped; a field renamed before confirming (in the sibling change's review step) still receives its column's values here under `SCHEMA_AND_VALIDATE`; `SCHEMA`-only suggestion creates no `GoldRecord`s even when cells are filled; multiple rows with the same filename become multiple `GoldRecord`s under one document; population reads the suggestion's pinned spreadsheet version even after the project's current version has moved on. (Pure mapping/exclusion logic unit-tested in `gold-spreadsheet.test.ts` and `_spreadsheet_schema.test.ts`; end-to-end confirm behavior added to `extraction-module.integration.test.ts` — **requires a live disposable Postgres database to actually run (`pnpm test:postgres`); not executed in this session, only typechecked.**)

## 3. Record alignment and field scoring

- [x] 3.1 Implement key-field alignment: match extracted records to `GoldRecord`s via `identifying` field(s) when declared. (`alignRecords`, `packages/extraction/src/record-alignment-scoring.ts`.)
- [x] 3.2 Implement the minimum-cost greedy fallback alignment for documents with no declared `identifying` field or unresolved ties. (Same function — a blank identifying value or a tied key on either side falls through to the greedy pool; see design.md D2's implementation note.)
- [x] 3.3 Implement field comparison: exact (trim/case-fold) for string/enum/boolean; tolerance-aware for numeric fields with `evaluationTolerance` set, exact otherwise. (`fieldsMatch`; array/nested-object fields compared as one opaque deep-equal leaf — scope note in design.md D3.)
- [x] 3.4 Implement precision/recall/F1 aggregation across matched pairs plus unmatched (omitted/hallucinated) records, per document and rolled up. (`scoreDocument`/`scoreAlignment` per document, `aggregateFieldOutcomes` sums raw counts before `precisionRecallF1` derives ratios — never averages per-document ratios.)
- [x] 3.5 Tests: reordered-but-matchable records align correctly; omitted record counts as recall miss across all its fields; hallucinated record counts as precision miss across all its fields; unconfigured numeric field requires exact match; configured tolerance credits a near-miss; aggregate metrics reflect both matched-pair and unmatched-record outcomes. (`record-alignment-scoring.test.ts`, 12 cases, pure logic — no DB, no Postgres dependency, run and passing in this session.)

## 4. Evaluation run tracking

- [x] 4.1 Add `EvaluationRun { evaluationCorpusVersionId, schemaRevisionId, batchExtractionId?, extractionId?, computedAt, metrics: Json }` to the DB contract — exactly one of `batchExtractionId`/`extractionId` set (design.md D4/D4b). (Invariant enforced in application code — `validateExtraction` always sets `extractionId` and leaves `batchExtractionId` null — mirroring `ReviewDecision`'s EDITED/reviewedValue pattern, not a DB constraint.)
- [ ] 4.2 **Blocked** — Generalize `batch-extraction-retry` (from `openspec/changes/extraction-review-metrics-and-sampling`, §8) to accept an arbitrary member/document list, not only not-yet-reviewed production members — needed so it can retarget the frozen gold corpus. That capability doesn't exist yet: it sits behind that change's own unstarted §7 (a manual validation spike only a researcher can run). See design.md D4 "Status" note — not building a parallel mechanism here, waiting for the real one.
- [ ] 4.3 **Blocked on 4.2** — Implement "create evaluation run" (batch path): re-extract the corpus version's documents at the current `SchemaRevision` via the generalized retry, score via §3, persist the resulting metrics.
- [x] 4.4 Implement "validate one document" (single-extraction path, design.md D4b): score one extraction attempt against its document's `GoldRecord`s using the same §3 scoring function, persist as an `EvaluationRun` with `extractionId` set — no batch/corpus re-run required. (`validateExtraction`, `packages/extraction/src/postgres-evaluation-runs.ts`, wired through `ExtractionModule`. **Not done**: an HTTP API route and the single-document Results-tab UI surfacing — only the module-level operation exists; nothing calls it from a request handler or `ExtractionFinishedDialog.tsx` yet.)
- [x] 4.5 Implement "list runs for a corpus version", ordered by schema revision sequence, for cross-cycle comparison (both batch and single-document runs). (`listEvaluationRuns`, same file — orders newest schema-revision cycle first; works for whichever run kinds exist, so it'll pick up batch runs for free once 4.2/4.3 unblock. Same "not done": no HTTP route or UI yet.)
- [x] 4.6 Tests: a later gold-version correction does not change an existing run's persisted metrics; two runs against the same corpus version but different schema revisions both remain independently readable; run ordering reflects revision sequence; a single-document run and a batch run against the same corpus version expose the same metric categories; validating one document does not trigger extraction/scoring of any other corpus document. (Added to `extraction-module.integration.test.ts` — **requires a live disposable Postgres database (`pnpm test:postgres`); not executed in this session, only typechecked**, same caveat as §2.4. The batch-vs-single-document metric-shape scenario is deferred with 4.2/4.3 — nothing to compare against yet.)

## 5. Controlled-vocabulary diagnostics

- [ ] 5.1 In `packages/extraction/src/allowed-values.ts`, add a diagnostic event emission at `coerceAllowedValue`'s call sites (`applyAllowedValues`/`coerceNode`) whenever the returned value isn't an exact/normalized match, without changing the existing keep-verbatim return behavior.
- [ ] 5.2 Thread the new diagnostic events into the extraction's existing diagnostics payload (parallel to `diagnostics.grounding`).
- [ ] 5.3 Aggregate vocabulary-violation counts into `EvaluationRun.metrics` (§4).
- [ ] 5.4 Tests: an out-of-vocabulary value both stays verbatim and produces an event; a matched/normalized value produces no event; violation counts appear in run metrics.

## 6. Core-loop validation checkpoint

- [ ] 6.1 Build (or reuse, if one already exists outside this repo) a small real gold corpus — a handful of documents with expert-curated records, uploaded as a spreadsheet (§2) — and run tasks 1-5 end to end.
- [ ] 6.2 Confirm with the researcher: does the key-field/fallback alignment (§3) behave sensibly on real multi-species tables? Does the default-exact-match tolerance policy need any fields configured with `evaluationTolerance` before this is useful? Does the column-type inference (§2.3) produce usable drafts on a real spreadsheet, or does it need tuning?
- [ ] 6.3 Decide whether to proceed to §7-10 below, based on 6.1-6.2.

## 7. Reviewer effort tracking (second wave)

- [ ] 7.1 Add `shownAt`/`decidedAt` capture client-side in the Studio review UI (grid + single-extraction results tab), included in the existing decision-save payload.
- [ ] 7.2 Add `ReviewDecision` schema/persistence fields for the two timestamps.
- [ ] 7.3 Implement edit-distance computation (Levenshtein over `String(original)` vs `String(reviewedValue)`) for `EDITED` decisions only; never computed for `REJECTED`.
- [ ] 7.4 Aggregate reviewer-effort figures into `EvaluationRun.metrics`.
- [ ] 7.5 Tests: timestamps present on every saved decision; edit distance recorded only for EDITED; reviewer-effort figures appear in run metrics.

## 8. Evidence Anchor accuracy (second wave)

- [ ] 8.1 Add a judgment store keyed by `{evaluationCorpusVersionId, sourceDocumentId, resultPath, judgment}`, independent of `GoldRecord`.
- [ ] 8.2 Add an expert-facing UI surface to sample and judge claims (which claims to sample is a product decision — confirm sampling strategy before building).
- [ ] 8.3 Compute Evidence Anchor accuracy (share of judged claims marked "anchor supports value") over judged claims only, and aggregate into `EvaluationRun.metrics`.
- [ ] 8.4 Tests: a correct value can carry a wrong-anchor judgment; judgments don't require a full gold-value pass; accuracy is computed over the judged sample only, not extrapolated.

## 9. Schema-free baseline spike (gate before building §10)

- [ ] 9.1 Manually run a schema-free prompt (no schema constraints) against 5-10 gold-corpus documents; inspect how messy the resulting field names/structure actually are relative to the gold schema.
- [ ] 9.2 Decide, based on 9.1, whether field-name alignment is tractable enough to build, and whether `schema-free-baseline-extraction` is worth scoping as a full follow-up change (recommended default, per design.md D8) versus continuing here.

## 10. Schema-free baseline extraction (only if 9.2 is a go, and likely its own follow-up change)

- [ ] 10.1 Add `SCHEMA_FREE` to `extractionStrategySchema` (`prototypes/studio/shared/extraction.contract.ts`).
- [ ] 10.2 Add a `SCHEMA_FREE` execution path in `packages/extraction/src/module.ts` that skips schema-constrained generation.
- [ ] 10.3 Implement field-name alignment between schema-free output and the gold schema, ahead of `record-alignment-scoring`.
- [ ] 10.4 Wire schema-free results into `EvaluationRun` as an alternative baseline comparable against the same corpus version's `ARTICLE`/`CATALOG` runs.
- [ ] 10.5 Tests: schema-free extraction runs without a pinned schema revision; differently-named equivalent fields align before scoring rather than being scored as unrelated.

## 11. Gold-assisted review (core loop — not the schema-free track; numbered last only to avoid renumbering §3-10)

Depends on §1 (data model) and §3's field-comparison groundwork
conceptually, but computes its own fuzzy similarity score rather than
reusing §3's exact/tolerance comparator (design.md D9) — §3 stays the
source of truth for `EvaluationRun` metrics, untouched by this section.

- [ ] 11.1 Add `suggestedAction: ReviewDecisionAction | null` and `matchScore: number | null` to `reviewDecisionShape` (`extraction.contract.ts`) and the corresponding DB persistence — both null whenever no gold value is available for that field (outside evaluation-corpus documents, unchanged from today).
- [ ] 11.2 Implement the similarity function: normalized Levenshtein (`1 - distance / max(len(a), len(b))` over `String(value)`) for string/enum/boolean fields; a relative-difference variant for numeric fields. Reuses §7's edit-distance primitive if §7 has landed by this point; otherwise implemented once and shared.
- [ ] 11.3 Implement threshold mapping: similarity `>= 0.85` → suggest `APPROVED`; `< 0.5` → suggest `REJECTED`; otherwise → suggest nothing (today's blank default). Confirm these starting thresholds against a real corpus (mirrors §6's checkpoint) before treating them as final.
- [ ] 11.4 Wire the gold value + suggested action into `BatchExtractionReviewGrid.tsx`'s `ReviewCell` (`prototypes/studio/src/projectContexts/BatchExtractionReviewGrid.tsx:313-413`): show the gold value alongside the extracted value; pre-select (visually default) the suggested action's control without writing a `ReviewDecision`; the researcher's own click still commits `APPROVED`/`REJECTED`/`EDITED`, persisting whatever `suggestedAction`/`matchScore` were in effect at that moment (11.1).
- [ ] 11.5 Wire the same into the single-document result tab's equivalent review surface (mirrors 4.4's single-document reuse of batch scoring).
- [ ] 11.6 Tests: a field with no matched gold value shows no suggestion and behaves exactly as today; similarity `>= 0.85` pre-selects Approve; `< 0.5` pre-selects Reject; the ambiguous band pre-selects nothing; clicking a different control than the pre-selected one commits the researcher's choice, not the suggestion; the persisted `suggestedAction`/`matchScore` reflect what was shown at decision time even if the gold record is corrected in a later `EvaluationCorpusVersion`; a document outside any evaluation corpus is entirely unaffected.
