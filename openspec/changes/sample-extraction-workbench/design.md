## Context

Extraction today is whole-document only. The Parsing Service's `extract`
(`kie/extract/run.py`) loads the complete canonical Evidence and has no page
option; the conversion `pages` parameter is conversion-only and always `None`.
Studio admits one Extraction per click (`postgres-admission.ts`), pins its
Extraction Method (ADR 0015), and treats the newest interactive attempt as the
document's result (`postgres-attempts.ts`). Review is complete-or-nothing: a
finalized review needs exactly one decision per grounded result path, each on
the model's own Evidence Anchor (`review-rules.ts:62`); partial reviews stay
versioned drafts (README §4). Schema nodes keep their ids through rename and
retype (`schema-node-persistence`). Evidence Anchors are `a_p{page}_s{index}`
(plus a cell id for table cells) and are stable within one Source
Representation Revision (`kei-artifact.ts:209`).

The UX is prototype B: the Schema tab is the workbench, each field shows its
sample values under its description, provenance works both ways, and reviewed
values carry forward.

## Goals / Non-Goals

**Goals:** page-scoped single Extractions with unchanged whole-document
behaviour; sample values reviewed where the schema is edited; carry-over of
reviewed decisions into re-runs and the full run that never guesses; corrections
that feed the existing schema-edit proposal flow.

**Non-Goals:** see the proposal. Also: no new service, queue, dependency or DBOS
step; no change to how the whole-document Extraction runs.

## Decisions

### 1. Scope is a request option, not a method setting

`Options.pages: list[int] | None` in the Parsing Service; Studio stores
`Extraction.requestedPages int[] NULL`, validated at admission (sorted, unique,
within `1..page_count`, at most 30 pages) and included in `sameAdmission`, never
in `savedMethodStillCurrent`. The kei handoff sends it inside
`request.options` (the envelope is strict, `kei-handoff.ts:75`) and the artifact
echoes it (`honorsRequestedOptions` requires it). `Options.dumped()` omits
`pages` when absent, so every existing fingerprint and golden fixture is
unchanged; a scoped request fingerprints its canonical page list. Batch admission
refuses a scope.

*Alternative:* a separate "sample" endpoint and table. Rejected: a sample is an
Extraction with a narrower scope; everything else (method, pinning, workflow,
review, GC) is identical.

### 2. Where each strategy applies the scope

- **Article and generic Catalog:** `run.extract` narrows `evidence.passages` and
  `evidence.withheld` to the pages before choosing the implementation, so one
  place scopes both. Article inventories only the sampled pages; records whose
  Evidence continues beyond them come back partial. The UI says so.
- **Recipe Catalog:** never narrow before `segmentation_run.obtain()`, which
  validates and publishes a whole-document segmentation; replacing it with a
  partial one would corrupt the cache. Segment the whole document (deterministic,
  no model call), then keep the blocks with a span on the pages. Headings and
  glossary in force still come from the whole segmentation, so an entry reads as
  it would in the full run. `record_blocks` lists only the kept blocks under
  their segmentation block ids; coverage and `complete` are computed over the
  kept blocks.
- **Document-level fields** read only the sampled pages for every strategy.
- A sample still requires a complete conversion (`passages.load`).

### 3. Samples are isolated from whole-document views

Latest attempt, latest reviewed, project summary and activity queries filter
`requestedPages IS NULL`. A per-document sample history query lists scoped
Extractions for the current Source Representation. `reviewable` stays as it is:
scope, not reviewability, tells them apart. `complete` is scope-relative and the
UI labels it with the pages.

### 4. The workbench reuses existing schema persistence

The prototype's "Save rev N & re-run sample" maps onto what Studio already does:
running a sample flushes the schema draft to an acknowledged Schema Revision (as
Run extraction does today), then admits the scoped Extraction. No second draft
concept. If the flush succeeds and admission fails, the revision stays saved and
the button retries admission with the same Extraction ID. Each value row is
labelled with the Schema Revision and pages that produced it; when the Current
Schema Revision has moved on, the field card says the values are from an earlier
revision.

Two-way provenance uses the existing overlays: a value focuses its anchors in
`useEvidenceOverlays`; an overlay click resolves anchor → result path → field
card and record. Records keep one label across cards: the recipe entry label,
else the Article identity field values, else "Record n".

### 5. Corrections may cite researcher-picked Evidence

`ReviewDecision` keeps `evidenceAnchorId` as the model's anchor and gains
`reviewedEvidence` (anchor ids with occurrence ids) for the passage the
corrected value is actually printed in. For a path with no model Evidence (the
model returned nothing, or a new value), a decision may exist with a null
`evidenceAnchorId` and non-empty `reviewedEvidence`. Review rules still require a
decision on every grounded path to finalize; decisions on ungrounded paths are
optional. Picked anchors must belong to the pinned Source Representation, like
cell anchors today. The UI finds the corrected text on the record's pages; with
several matches the researcher confirms one; with none (normalized text) the
researcher picks the passage.

### 6. Transfer snapshot pinned at admission

A single scoped or full Extraction admitted after samples pins
`Extraction.reviewTransfer Json NULL`: the union of the decisions of every sample
of the same document, Source Representation Revision and Extraction Schema
(explicit plus carried and not overridden). Where samples decided the same
aligned record and node, the newest wins; decisions on records no later sample
aligned are forwarded unchanged, so a sample on pp. 12–14 followed by one on
pp. 40–42 keeps both. Each entry records its source Extraction and review draft
version, schema node id, record key, source path key, action, model value,
reviewed value, value type, model anchors and reviewed Evidence. Immutable once
admitted; each sample is bounded by the 30-page cap. Batch members pin nothing in
this change.

*Alternative:* Codex's `ReviewTransferSnapshot` table. Deferred: the snapshot
has one owner and one reader and is read with the row, like the pinned method.
Move it to a table if it is ever queried on its own.

### 7. Matching: align records, then compare fields

Preconditions: same Source Document, Source Representation Revision and
Extraction Schema. Then:

1. **Records.** Recipe Catalog with the same segmentation fingerprint: by block
   id. Otherwise records align when they share Evidence Anchors and the pairing
   is one-to-one and mutual; anything else is *unmatched*, never *changed*.
   The researcher can pair an unmatched destination record with an unmatched
   source record by hand, one-to-one; the pairing is a draft of the destination
   review, undoable until it is finalized, and steps 2–3 then run on the pair.
   A hand pairing never relaxes step 3: values still carry only on equal anchors.
2. **Fields** by schema node id (a rename carries). Array items align by their
   anchors inside the aligned record, never by index.
3. **Values**, per action, after lossless conversion to the destination type:
   - approved: destination value and anchors equal the approved ones → seed
     APPROVED;
   - edited: destination equals the corrected value on the correction's
     reviewed Evidence → seed APPROVED (*fixed*); a correction without reviewed
     Evidence never carries as fixed;
     destination repeats the same model value on the same anchor → seed the
     EDITED decision again (the same mistake, already corrected);
   - rejected: destination repeats the rejected value on the same anchor → seed
     REJECTED;
   - anything else stays to review, labelled changed, type changed, new field or
     unmatched record.

Seeded decisions are draft decisions with provenance
(`carriedFrom: {extractionId, sourcePathKey}` on the decision). Nothing becomes
authoritative until the researcher finalizes the review, which writes ordinary
`ReviewDecision`s under the destination's own paths.

### 8. Suggestions from corrections use the existing proposal flow

The schema-edit request gains optional `corrections: {extractionId, nodeIds}`.
The server loads those decisions and their Evidence text, bounded (at most 20
corrections, passage text truncated), and adds them to the prompt as data. The
persisted instruction stays the researcher's words (or a fixed label), and the
reply uses the existing validated proposal envelope, which already carries
descriptions, allowed values and additions (`schemaEdit.contract.ts:24`).
Flush-before-chat is unchanged. The `schema-chat-edit` spec is corrected to allow
descriptions and allowed values, which the code already does.

### 9. Durable execution, method and GC

Studio's extraction workflow reads the scope from the row, since inputs carry
IDs only. The step sequence is unchanged, so no `DBOS.patch()`; recovered
checkpoints without `pages` default to whole-document. Renaming a field named
in Article `identity_fields` is refused at admission by the existing
`refuseUnusableIdentityFields`, whose message points to the Advanced tab. Sample
Extractions follow existing GC rules. The snapshot is self-contained, so a
collected source Extraction leaves no dangling reference.

## Risks / Trade-offs

- [Article samples see only part of the source] → UI copy on the sample and on
  carried results; partial records arrive as changed or unmatched, never carried.
- [A passing sample does not admit the full run: full-context Article refuses an
  oversized source] → the full-run button keeps today's refusal and message.
- [False carry-over] → requires record alignment, node id, value and anchors;
  ambiguity stays to review.
- [Fingerprint drift] → golden fixtures must pass unchanged with `pages` absent.
- [A stable node id with a changed meaning (unit, description)] → values are
  re-compared on every run; a description edit never carries a decision whose
  value changed.

## Migration Plan

Additive nullable columns (`Extraction.requestedPages`,
`Extraction.reviewTransfer`, `ReviewDecision.reviewedEvidence`,
`ReviewDecision.carriedFrom`) and `ReviewDecision.evidenceAnchorId` made
nullable; no backfill. The Parsing Service accepts requests without `pages`
exactly as before. Rollback: stop admitting scopes; null columns are ignored.

## Open Questions

None. Resolved 2026-09-29: the sample cap is 30 pages; unmatched records are
pairable by hand; an Article record without identity fields is labelled by its
first Evidence page and first non-empty scalar value (`p. 12 · Deckelpokal`),
else `p. 12 · record 2`. A label is display only, never used for matching.
