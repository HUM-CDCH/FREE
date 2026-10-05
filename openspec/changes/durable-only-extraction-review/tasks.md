## 1. Specifications

- [x] 1.1 Write delta specs for `canonical-evidence-lifecycle`, `result-tree-navigator` and `durable-extraction-admission`
- [x] 1.2 Sync the deltas into `openspec/specs/` (main specs updated; `durable-extraction-admission` added; `result-tree-navigator` removed)
- [x] 1.3 `openspec validate durable-only-extraction-review --strict` and `openspec validate --specs` pass

## 2. Implementation (durable-only follow-up)

- [x] 2.1 Delete the `ProjectStore` accept write, Review Draft routes/store and `ResultsTab`; Studio renders only `DurableResults`
- [x] 2.2 Correction Evidence is checked against the pinned Source Representation (`api/durable_extractions.ts`)
- [x] 2.3 A late post-save page read does not replace a newer explicit selection or its draft (`DurableResults.tsx`)
- [x] 2.4 Both "Latest reviewed" entry points open the finalized result/decision pair (`App.tsx`, `AppFrame.tsx`, `projectNavigation.ts`)
- [x] 2.5 The view names the selected and newer result/decision versions; Finalize names its pair
- [x] 2.6 Local unit/component tests, typechecks and eslint pass for the above (session 3, 2026-10-05)
- [x] 2.7 Project summaries count a finalized Extraction as extracted and reviewed whatever its processing state

- [x] 2.8 Remove the complete admission gate and its refusal API/UI handling
- [x] 2.9 Verify successful single and batch admission, replay and enqueue rollback in PostgreSQL
- [x] 2.10 Verify late save responses, both Latest reviewed routes and older-pair finalization in the browser

- [x] 2.11 Initialize worker coordination before DBOS launch and close it before process exit
- [x] 2.12 Document the durable-only upgrade: operationally close access, drain or cancel deleted `runExtraction` / `extract` invocations with pinned DBOS clients, require zero active rows after writers stop, and describe optional terminal-history cleanup (`docs/operations/deployment.md`)

## 3. Infrastructure acceptance (required before merge and archive)

- [x] 3.1 Current implementation `b6b3cbe2`: db 57 and extraction 15 PostgreSQL checks passed on Baratheon, including all 18 actual Python durable lifecycle/recovery cases; see `docs/validation/2026-10-06-pr188-independent-review-followup.md`
- [x] 3.2 Current implementation `b6b3cbe2`: Studio PostgreSQL 63, durable browser 18 and real-service browser 13 passed; two live-model cases and one private scanned-PDF case skipped (record above)
- [ ] 3.3 Current-source root `pnpm test:system` against Compose (earlier source passed; rerun required). `pnpm test:safety` passed all 29 on `b6b3cbe2`
- [ ] 3.4 Complete Spark acceptance recorded on the exact merge-candidate commit: deterministic isolated Baratheon checks passed on `b6b3cbe2`; finish current-source standard/recovery browser matrix and live Article/unified model checks before merge. Production remains unchanged
- [ ] 3.5 Independent review of the exact commit; merge and archive this change only after 3.1–3.4 pass, with `openspec archive durable-only-extraction-review --skip-specs` (the main specs are already synced; re-applying the REMOVED deltas would fail)
