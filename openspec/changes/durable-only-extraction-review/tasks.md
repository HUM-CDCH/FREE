## 1. Specifications

- [x] 1.1 Write delta specs for `canonical-evidence-lifecycle` and `result-tree-navigator`
- [x] 1.2 Sync the deltas into `openspec/specs/` (main specs updated; `result-tree-navigator` removed)
- [x] 1.3 `openspec validate durable-only-extraction-review --strict` and `openspec validate --specs` pass

## 2. Implementation (durable-only follow-up)

- [x] 2.1 Delete the `ProjectStore` accept write, Review Draft routes/store and `ResultsTab`; Studio renders only `DurableResults`
- [x] 2.2 Correction Evidence is checked against the pinned Source Representation (`api/durable_extractions.ts`)
- [x] 2.3 A late post-save page read does not replace a newer explicit selection or its draft (`DurableResults.tsx`)
- [x] 2.4 Both "Latest reviewed" entry points open the finalized result/decision pair (`App.tsx`, `AppFrame.tsx`, `projectNavigation.ts`)
- [x] 2.5 The view names the selected and newer result/decision versions; Finalize names its pair
- [x] 2.6 Local unit/component tests, typechecks and eslint pass for the above (session 3, 2026-10-05)
- [x] 2.7 Project summaries count a finalized Extraction as extracted and reviewed whatever its processing state

## 3. Infrastructure acceptance (not run; required before archive)

- [ ] 3.1 `packages/extraction` and `packages/db` `test:postgres`, including `durable-readers.postgres.check.ts` and `durable-control.postgres.check.ts`
- [ ] 3.2 Studio PostgreSQL tests and Playwright e2e on the durable routes (`durable-service.spec.ts`)
- [ ] 3.3 Root `pnpm test:system` and `pnpm test:safety` against Compose
- [ ] 3.4 Spark acceptance with admissions still OFF, recorded on an exact commit
- [ ] 3.5 Independent review of the exact commit; archive this change only after 3.1–3.4 pass, with `openspec archive durable-only-extraction-review --skip-specs` (the main specs are already synced; re-applying the REMOVED deltas would fail)
