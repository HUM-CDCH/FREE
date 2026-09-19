## Why

FREE currently has no way to answer, with numbers, "did this schema/vocabulary
refinement cycle actually make extraction better?" There is no gold-standard
comparison, no precision/recall/F1, no Evidence Anchor accuracy score, and no
reviewer-effort measure anywhere in the codebase — every existing quality
signal (the three-way grounded/ungrounded/missing classification, raw
`ReviewDecision` counts) is a proxy computed from FREE's own output, never
checked against an expert-curated answer key. Without this, claims like "543
publications, 95% coverage, errors are mainly omissions in multi-species
tables" (from a recent pilot) can be described qualitatively but not tracked
quantitatively across the iterative schema/vocabulary refinement FREE already
supports via `SchemaRevision` history.

## What Changes

- Add a gold-standard corpus: a held-out, version-locked set of documents plus
  expert-curated ground-truth records/fields, kept stable across refinement
  cycles so metric changes reflect schema/vocabulary changes, not corpus churn.
  Populated by uploading a spreadsheet (columns = field names, each row = one
  gold record — not one row per document, so multi-record documents are
  representable) rather than a bespoke annotation UI.
- Make `SourceDocument.originalName` unique per project (a genuine change to
  the existing upload flow, not scoped to evaluation — see design.md D1c):
  today two different-content PDFs can share a display name, which is
  exactly the ambiguity that would otherwise require a per-row
  disambiguation step when resolving a gold spreadsheet's filename column.
  Closing it at the upload source makes that resolution unambiguous by
  construction instead.
- Add a purpose choice at suggestion-creation time, `SCHEMA` or
  `SCHEMA_AND_VALIDATE`: the project's spreadsheet (uploaded/versioned via
  the standalone `openspec/changes/spreadsheet-schema-suggestion` change
  this one depends on) can also seed the schema itself, and when the
  researcher picks `SCHEMA_AND_VALIDATE`, this change populates the gold
  corpus from the pinned `projectSpreadsheetVersionId`'s rows once that
  suggestion is confirmed — `SCHEMA` alone stops after schema-seeding, no
  gold data created. Because the spreadsheet is stored durably and the
  suggestion pins the exact version it used, this population step works
  correctly no matter how long after creation confirmation happens.
  Schema-seeding mechanics (column-type inference, the suggestion
  draft/edit/confirm flow, spreadsheet storage itself) are entirely that
  sibling change's concern.
- Add record alignment: match extracted records against gold records per
  document (not assumed 1:1 by position), so a matched pair can be scored and
  an unmatched gold record counts as a miss (recall) while an unmatched
  extracted record counts as a hallucination (precision) — this is what
  actually measures "incomplete enumeration of multi-species tables."
- Add field-level precision/recall/F1 scoring over matched record pairs.
- Add an evaluation run record that ties one `SchemaRevision` + the gold
  corpus's fixed version + a re-run of that corpus through the existing
  extraction pipeline to one set of computed metrics — enabling a
  metrics-across-cycles comparison, reusing `SchemaRevision` history (no
  changes needed there) and the batch-retry capability being built in
  `openspec/changes/extraction-review-metrics-and-sampling` (retarget it at
  the frozen gold corpus instead of not-yet-reviewed production documents).
- Also support validating a single document's extraction attempt on its own
  (no full corpus batch run required), producing the exact same metric
  shape as a batch run — mirroring how the single-document
  `ExtractionFinishedDialog` already mirrors `BatchExtractionFinishedDialog`
  at `n=1` rather than the two surfaces reporting different things.
- Add controlled-vocabulary violation diagnostics: `coerceAllowedValue`
  (`packages/extraction/src/allowed-values.ts`) already keeps an
  out-of-vocabulary value verbatim by design (never silently blanks it) — add
  a countable/reportable event alongside that unchanged behavior, so
  "values outside controlled vocabularies" becomes a tracked failure mode
  instead of an invisible one.
- Add reviewer-effort quantification: timestamp each `ReviewDecision` from
  first shown to submitted, and compute an edit-distance between an `EDITED`
  decision's `reviewedValue` and the model's original value — both currently
  absent (only raw decision counts exist today).
- Add Evidence Anchor accuracy: a second, independent annotation layer where
  an expert judges whether a claimed evidence anchor actually supports its
  value (distinct from whether the value itself is correct), plus the
  accuracy score derived from those judgments.
- Add gold-assisted review: when a document belongs to an evaluation
  corpus, its existing per-field Approve/Reject/Edit review control (grid
  and single-document result tab alike) also shows the gold value and
  pre-selects a default action from a fuzzy-similarity comparison against
  it — high similarity pre-selects Approve, low similarity pre-selects
  Reject, the ambiguous middle pre-selects nothing. This is a UI default
  only: the researcher's own click still commits the decision, and what
  was suggested is persisted alongside it (see design.md D9). Distinct
  from `record-alignment-scoring`'s D3 exact-match comparator, which stays
  untouched and remains what `EvaluationRun` metrics are computed from.
- (Exploratory, largest and most speculative piece — see Impact/Out of scope)
  Add a schema-free baseline extraction path, so schema-guided results can be
  compared against an unguided extraction on the same documents. **BREAKING**
  for nothing existing — this is a new, additive extraction strategy — but it
  is a large enough scope (a full third strategy alongside ARTICLE/CATALOG)
  that it should be scoped and estimated as its own follow-up rather than
  built inside this change; included here only as a spec so the eventual
  comparison contract is defined up front.

## Capabilities

### New Capabilities

- `gold-standard-corpus`: version-locked evaluation documents plus
  expert-curated ground-truth records/fields, held fixed across refinement
  cycles, populated via spreadsheet upload (one row = one gold record; a
  row's filename resolves to exactly one project document now that
  `originalName` is unique per project — see `source-document-ingestion`
  below) under the `SCHEMA_AND_VALIDATE` upload purpose. Depends on
  `openspec/changes/spreadsheet-schema-suggestion` for the schema-seeding
  half of that upload (not owned here — see Impact).
- `record-alignment-scoring`: matches extracted records to gold records per
  document and computes field-level precision/recall/F1 over matched pairs,
  with unmatched records counted as misses/hallucinations.
- `evaluation-run-tracking`: links a `SchemaRevision` + the gold corpus's
  fixed version + a corpus re-run to one computed metrics set, enabling
  cross-cycle comparison.
- `controlled-vocabulary-diagnostics`: a countable, reportable event for
  values `coerceAllowedValue` could not match into the closed set, without
  changing the existing keep-verbatim behavior.
- `reviewer-effort-tracking`: per-`ReviewDecision` timing and edit-distance,
  aggregated per document/evaluation run.
- `evidence-anchor-accuracy`: expert judgments on whether a claimed evidence
  anchor supports its value, and the accuracy score derived from them.
- `schema-free-baseline-extraction` (exploratory — see What Changes): a third
  extraction strategy with no researcher-authored schema, for baseline
  comparison against ARTICLE/CATALOG results on the same documents.
- `gold-assisted-review`: a fuzzy-match-derived default action (and the
  gold value itself) surfaced on the existing per-field review control when
  a document belongs to an evaluation corpus, plus the persisted
  suggestion/score that made that default — see design.md D9.

### Modified Capabilities

- `source-document-ingestion`: `originalName` becomes unique per project;
  an upload whose display name collides with an existing document in the
  same project is now rejected, instead of silently coexisting (see
  design.md D1c). This is the one requirement in this change that isn't
  evaluation-specific — it changes upload behavior for every caller, not
  only gold-spreadsheet ingestion.
- `ReviewDecision` (part of the existing extraction-review capability):
  adds `suggestedAction`/`matchScore` fields, both nullable and both `null`
  outside evaluation-corpus documents — additive only, no existing field's
  meaning or validation changes (see design.md D9).

(`SchemaRevision` history and `allowed-values.ts`'s coercion behavior
remain reused as-is and unmodified.)

## Open Questions For Review

1. **Numeric/string matching tolerance**: should field-level scoring treat a
   measurement as correct within a tolerance band (e.g. ±0.5°C for thermal
   values), or require exact match after normalization? Needs a decision per
   field type before `record-alignment-scoring` can be built, likely
   configured per schema field rather than globally.
2. **Record alignment algorithm**: exact matching strategy (key-field
   matching, e.g. species name, vs. a general minimum-edit-distance
   assignment) is a design decision with real accuracy implications — see
   design.md.
3. **Single-document validation scope**: does a document need to already
   belong to an `EvaluationCorpus` (has curated `GoldRecord`s) to be
   individually validated, or should ad hoc gold-annotation of one document
   outside any named corpus be supported too? Default assumption (design.md
   D4b): must belong to an `EvaluationCorpus` — no parallel un-corpused gold
   storage path. Confirm before building.
4. **Scope of this change vs. a follow-up**: recommend landing
   `gold-standard-corpus` + `record-alignment-scoring` +
   `evaluation-run-tracking` + `controlled-vocabulary-diagnostics` as the
   core loop first (this is what actually produces precision/recall/F1
   across cycles); `reviewer-effort-tracking` and `evidence-anchor-accuracy`
   as a second wave; `schema-free-baseline-extraction` scoped separately
   given its size (a full new extraction strategy). tasks.md phases these
   explicitly — confirm before implementation whether all phases are wanted
   in one change or split. Note the core loop's `SCHEMA_AND_VALIDATE` upload
   path also needs `openspec/changes/spreadsheet-schema-suggestion`
   implemented (that change is independently useful and doesn't need to
   wait for this one).

## Impact

- New gold-corpus storage (documents + expert-curated records/fields, likely
  a new `packages/db` model family alongside `ExtractionSchema`/
  `SchemaRevision`, since it needs the same append-only/versioned rigor).
- Depends on `openspec/changes/spreadsheet-schema-suggestion` for
  spreadsheet storage/versioning, parsing, column-type inference, and the
  confirmed column-to-field mapping (plus `projectSpreadsheetVersionId`) —
  not owned or duplicated here. This change only adds: the
  `SCHEMA`/`SCHEMA_AND_VALIDATE` purpose choice at suggestion-creation
  time, filename-to-`SourceDocument` resolution (unambiguous once
  `originalName` is unique per project — see below), and mapping resolved
  rows into `GoldRecord`s using the sibling change's confirmed mapping.
- `packages/db/src/prisma/contract.prisma`'s `SourceDocument` model gets
  `@@unique([projectContextId, originalName])`; `source_documents.ts`'s
  upload path gets a new duplicate-name rejection ahead of its existing
  content-hash dedup. Needs a pre-flight check for filename collisions
  already present in existing project data before the migration adds the
  index (design.md D1c, Risks).
- New scoring code in `packages/extraction/src/` (record alignment, field
  comparison, precision/recall/F1), and a new evaluation-run entity linking
  `SchemaRevision`, the gold corpus's version, and computed metrics.
- `packages/extraction/src/allowed-values.ts`: add a diagnostic event
  alongside `coerceAllowedValue`'s existing coercion, without changing its
  return behavior.
- `ReviewDecision` persistence/contract: add timing fields (§7); new
  edit-distance computation (likely `prototypes/studio/src/` or shared,
  since both server and client already share review-decision types); also
  adds `suggestedAction`/`matchScore` (gold-assisted review, D9) — both
  additive, nullable, and unrelated to each other's rollout order.
- `BatchExtractionReviewGrid.tsx`'s `ReviewCell` and the single-document
  result tab's equivalent control: read the matched `GoldRecord` field
  (when the document belongs to an evaluation corpus) to show the gold
  value and pre-select a default action from the D9 similarity score.
- Depends on `batch-extraction-retry` from
  `openspec/changes/extraction-review-metrics-and-sampling` (retargeted at
  the frozen gold corpus) — sequencing note, not a spec dependency this
  change owns.
- `schema-free-baseline-extraction`: `prototypes/studio/shared/extraction.contract.ts`'s
  `extractionStrategySchema` enum, plus a new execution path in
  `packages/extraction/src/module.ts` — largest-impact item, recommend
  scoping separately (see Open Questions).
