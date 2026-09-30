# Tasks

The original PR1–PR4 remain separately usable (CONTRIBUTING.md); section 5
accepts that original change, including PR4. Sections 6–9 track the selected
workflow integration after the committed workbench/dev baseline. PR4 remains
pending and is independent of manual field navigation and deterministic import.

## 1. PR 1 — Page sample with a fixed schema, reviewed in the Schema tab

- [x] 1.1 Parsing Service: add `Options.pages`; narrow passages for Article and generic Catalog in `run.extract`; keep whole-document segmentation for recipe Catalog and select entries with a span on the pages; echo `pages`; omit it from `dumped()` when absent. Verify: golden/replay fingerprints unchanged; recipe sample reuses the published segmentation; contract fixtures `extract.input.json`/`extract.output.ok.json` gain a scoped example. — 75aac918
- [x] 1.2 Extraction package and database: nullable `Extraction.requestedPages`; validate at admission (sorted, unique, in range, ≤ 30); include in `sameAdmission` and the kei request options; accept its echo in `acceptKeiArtifact`; refuse scope on batch. Verify: replay conflict on a different scope, no `method_changed` from scope, recovered workflow without pages runs whole-document. — 1ad20a97
- [x] 1.3 Filter `requestedPages IS NULL` in latest attempt, latest reviewed, project summary and activity; add the per-document sample history query. Verify with the postgres attempts/summary tests that a newer reviewed sample does not displace the full result. — 036e3f07
- [x] 1.4 Studio viewer: track the current page (`pagechanging`), add the thumbnail strip with toggles and "This page / ± 1 / ± 2"; Run sample flushes the schema then admits; retry admission after a saved flush. Verify in `App.test.tsx`/`useExtraction.test.tsx`. — 7489704b
- [x] 1.5 Schema tab: sample values under each field with record labels, run revision/pages label and stale-revision notice; right/correct/undo writing the sample's normal review draft; a correction records `ReviewDecision.reviewedEvidence` when its value is found on exactly one passage of the record's pages (else none, so it can never carry as fixed); values focus their Evidence and page passages focus their value. Verify in `SchemaPanel.test.tsx` and one browser flow. — ab92fa05
- [x] 1.6 Add *Sample Extraction* to `CONTEXT.md`; scope-relative completeness copy; Article sample caveat copy. — 63c48e83

## 2. PR 2 — Review transfer into re-runs and the full run

- [x] 2.1 Nullable `Extraction.reviewTransfer` pinned at single admission from the union of all samples of the same document, Source Representation Revision and Extraction Schema (newest decision wins per aligned record and node; unaligned decisions forwarded); nullable `ReviewDecision.carriedFrom`; batch pins nothing. Verify immutability after later sample edits, two samples on different page sets both carried, and nothing pinned across a reprocessed source. — 344f3b7f
- [x] 2.2 Record alignment (segmentation block for recipe Catalog, else one-to-one mutual anchor overlap) and per-action matching by node id, value after lossless conversion and anchors; arrays by anchors. Verify with table cases: approval, same mistake, fix, rejection, moved anchor, merged/split Article records, reordered arrays, table-cell anchors. — 18b07a06
- [x] 2.3 Seed the destination review draft under its own paths with provenance; override and finalize through existing review rules. Verify that a fully carried review still needs explicit finalization. — 809887d6
- [x] 2.4 Studio: re-run statuses (fixed, as reviewed, changed with Accept new/Keep, unmatched record) in the Schema tab; Results show reviewed in sample / changed since sample / to review. Add *Carried Review Decision* to `CONTEXT.md`. — 64132106
- [x] 2.5 Hand pairing of unmatched records (one-to-one, undoable, stored in the destination review draft); paired records compared under the same rules. Verify a split Article record paired to one half, and that pairing never carries a value on a different anchor. — 03ce3687

## 3. PR 3 — Structural edits and correction Evidence

- [x] 3.1 Nullable `evidenceAnchorId` for decisions on ungrounded values (their Evidence is `reviewedEvidence`, added in 1.5); review rules accept optional ungrounded decisions whose Evidence is published for the pinned Source Representation. Verify refusal of a non-canonical passage.
- [x] 3.2 Correction Evidence in the Schema tab: confirmation among several matches, "Pick on page" when none; Save blocked without Evidence.
- [x] 3.3 Rename/retype/add/remove in field cards with the transfer rules: rename carries, lossless retype converts, otherwise type changed, added field is new, removed field's decisions stay with their revision. Verify identity-field renames are refused at admission with the Advanced-tab message.

## 4. PR 4 — Suggestions from corrections

- [ ] 4.1 Schema-edit request gains optional `corrections: {extractionId, nodeIds}`; ownership check; server-side loading bounded to 20 corrections with truncated passages; Evidence text kept out of the stored instruction. Verify refusal for another account's Extraction and that no model call is made.
- [ ] 4.2 Field card "Suggest a description from N corrections" through the existing proposal review and Apply flow. Verify with `useSchemaProposalReview.test.tsx` and `_schema_edit.test.ts`.

## 5. Acceptance

- [ ] 5.1 Run typecheck, lint, fast tests, guarded PostgreSQL, Parsing Service `test` and `test:service`, and the authenticated browser flow sample → correct → suggest → re-run → full run; record them in a dated validation receipt.
- [ ] 5.2 Independent read-only review of the final candidate; resolve findings and revalidate.


## 6. PR5a — Shared review attention

- [x] 6.1 Classify pinned actual scalar paths on orthogonal grounding/decision axes; empty arrays have no phantom occurrences; prepared approvals are not decisions. Share the pure calculation between read DTOs and workbench/results/collection review.
- [x] 6.2 Add non-blocking attention filters and provenance navigation. Exclude missing/ungrounded cells from required decisions, retain descriptive counts after finalization and allow only validated canonical Evidence corrections.
- [x] 6.3 Validate the frozen page-scope/single-transfer/hand-pairing baseline independently and resolve findings before extending admission: selected-page duplicate/order scope, carried provenance, scoped pairing saves, and cross-sample one-to-one pairing.

## 7. PR5b — Field context, same-pages re-run and factual guidance

- [x] 7.1 Resolve transient stable node context in the manual editor, preserve dirty edits, explain renamed/retyped/removed nodes and offer the historical revision. No PR4 correction-context hook.
- [x] 7.2 Flush before deliberate same-pages re-run, preserve saved method/page scope and source guards, and retain existing uncertain-admission identities.
- [x] 7.3 Derive guidance from existing facts/capabilities, without a saved lifecycle or readiness gate. Show bounded selected-source coverage for the selected schema/current pins, deduplicated physical pages, admitted/draft/finalized counts, full results and unavailable reads.

## 8. PR6 — Bounded transient Excel schema import

- [x] 8.1 Authenticate/own preview before parsing; preflight actual ZIP expansion before streaming ExcelJS, enforcing compressed/expanded/column/row/decoded-cell bounds and ordinary XLSX validation.
- [x] 8.2 Explicit sheet/header/separator/types/enums/description preview; safe paths, stable IDs, lossless hints and bounded examples. Preview/cancel persists no workbook or schema.
- [x] 8.3 Confirm through ordinary initialization/expected-head revision append; reconcile uncertain initialization before retry; keep a dirty editor intact. Use ordinary sample/review after confirmation.

## 9. PR7 — Sample decisions in collection review

- [x] 9.1 Replace the original batch snapshot exclusion in the transfer spec after single-transfer acceptance; use the same source-local snapshot at ordinary/suggested member admission with the existing matcher, atomic transaction and enqueue.
- [x] 9.2 Verify non-null batch/transfer fixtures through module/owned readers, preparation/draft/finalization, DTO, recovery and grid. Expose carried/changed/unmatched/remaining facts, hand pairing, conflicts and explicit carried finalization.
- [x] 9.3 Prove replay snapshots immutable, deliberate repetition captures current decisions, source-local query growth at six/fifty members, and member4 snapshot failure rolls back ordinary and suggested admission. Retain existing ownership, method and source-pin guards.

## 10. Workflow integration acceptance

- [x] 10.1 Complete the deterministic aggregate on Spark, forward fresh/upgrade migration checks, authenticated import → sample/review → field edit → same-pages re-run → full run → collection review, Parsing Service/service tiers, and a dated validation receipt. — `1617c51d`; [validation receipt](../../../docs/validation/2026-09-30-workbench-workflow-integration.md).
- [x] 10.2 Independently review the frozen integration candidate on Standards and Spec axes, resolve findings and revalidate. Record adjacent delivery bases/merge order. Keep PR4 and its later correction-context integration pending. — `1617c51d`; [validation receipt](../../../docs/validation/2026-09-30-workbench-workflow-integration.md).
