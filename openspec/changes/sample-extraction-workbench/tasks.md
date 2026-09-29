# Tasks

Four pull requests, each usable end to end (CONTRIBUTING.md). Sections 1–4 are
one PR each, in merge order; section 5 accepts the whole change.

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
- [x] 2.3 Seed the destination review draft under its own paths with provenance; override and finalize through existing review rules. Verify that a fully carried review still needs explicit finalization.
- [ ] 2.4 Studio: re-run statuses (fixed, as reviewed, changed with Accept new/Keep, unmatched record) in the Schema tab; Results show reviewed in sample / changed since sample / to review. Add *Carried Review Decision* to `CONTEXT.md`.
- [ ] 2.5 Hand pairing of unmatched records (one-to-one, undoable, stored in the destination review draft); paired records compared under the same rules. Verify a split Article record paired to one half, and that pairing never carries a value on a different anchor.

## 3. PR 3 — Structural edits and correction Evidence

- [ ] 3.1 Nullable `evidenceAnchorId` for decisions on ungrounded values (their Evidence is `reviewedEvidence`, added in 1.5); review rules accept optional ungrounded decisions whose Evidence is published for the pinned Source Representation. Verify refusal of a non-canonical passage.
- [ ] 3.2 Correction Evidence in the Schema tab: confirmation among several matches, "Pick on page" when none; Save blocked without Evidence.
- [ ] 3.3 Rename/retype/add/remove in field cards with the transfer rules: rename carries, lossless retype converts, otherwise type changed, added field is new, removed field's decisions stay with their revision. Verify identity-field renames are refused at admission with the Advanced-tab message.

## 4. PR 4 — Suggestions from corrections

- [ ] 4.1 Schema-edit request gains optional `corrections: {extractionId, nodeIds}`; ownership check; server-side loading bounded to 20 corrections with truncated passages; Evidence text kept out of the stored instruction. Verify refusal for another account's Extraction and that no model call is made.
- [ ] 4.2 Field card "Suggest a description from N corrections" through the existing proposal review and Apply flow. Verify with `useSchemaProposalReview.test.tsx` and `_schema_edit.test.ts`.

## 5. Acceptance

- [ ] 5.1 Run typecheck, lint, fast tests, guarded PostgreSQL, Parsing Service `test` and `test:service`, and the authenticated browser flow sample → correct → suggest → re-run → full run; record them in a dated validation receipt.
- [ ] 5.2 Independent read-only review of the final candidate; resolve findings and revalidate.
