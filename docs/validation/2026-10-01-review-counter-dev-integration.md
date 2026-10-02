# Review-counter integration into dev

Date: 2026-10-01. Status: conflicts resolved and fast checks passed; database-backed E2E remains unexecuted.

The user requested the pushed review-counter fix on `dev`. This port applies commit `d03e4b30891f518c2728d97295b34952aaf23dbe` from `feat/sample-extraction-workbench` to the fetched `dev` baseline `4242610a77fcf22fdc102874de3add1b9cfd92cd`, using an isolated worktree. Other uncommitted workspace changes remain outside the port.

## Conflict resolution

The feature branch and dev differ in Sample Extraction review functionality. Three files conflicted: ResultsTab, its tests, and useExtraction. The resolutions preserve dev's existing decision and automatic-finalization behavior, while introducing the single required-progress status, accessible bulk-approval scope, initial-load Retry action, acknowledged draft feedback, and counted batch action.

Sample-carried decisions, transfer comparison and hand-pairing functionality are not present on this dev baseline. The port therefore omits the sample-only status fragments, explicit Save action, pairing write changes and two sample-specific ResultsTab tests. The version-zero draft test uses dev's existing draft shape instead of a sample-carried decision. Controller fixtures receive the new reload callback. No Parsing Service or backend package is modified by this port.

The story catalogue and original validation/review records remain dated records of the feature-branch source snapshot and deployed observations; sample-specific stories and the original Claude pairing finding do not imply that this port adds those features to dev. Claude reviewed the original feature-branch change, not these conflict resolutions.

## Verification

- Targeted unit checks: **228 tests passed across 7 files** after the conflict resolutions and fixture updates; [log](2026-10-01-review-counter-dev-evidence/unit.log).
- Studio typecheck: **passed**; [log](2026-10-01-review-counter-dev-evidence/typecheck.log).
- Changed-file ESLint: **0 errors**, the same two useExtraction effect-dependency warnings as the dev baseline; [current log](2026-10-01-review-counter-dev-evidence/lint.log), [baseline log](2026-10-01-review-counter-dev-evidence/lint-baseline.log). The subsequently updated controller fixtures also pass [lint](2026-10-01-review-counter-dev-evidence/fixture-lint.log).
- Whitespace/conflict checks: passed after resolution and staging.
- Database-backed Playwright and component-browser checks were not rerun for this dev port. The original [fix record](2026-10-01-review-counter-fix.md) records the unavailable Docker socket and feature-branch browser evidence.

Dependencies were installed from the existing local cache with `FREE_SKIP_PYTHON=1 pnpm install --offline --frozen-lockfile`. Verification commands:

```sh
pnpm --filter studio typecheck
pnpm --filter studio exec vitest run src/ResultsTab.test.tsx src/useExtraction.test.tsx src/useBatchExtractionReviewGrid.test.tsx src/api.test.ts src/RightRail.test.tsx src/App.test.tsx src/reviewDrafts.test.ts
pnpm --filter studio exec eslint src/ResultsTab.tsx src/useExtraction.ts src/useBatchExtractionReviewGrid.ts src/projectContexts/BatchExtractionReviewGrid.tsx src/ResultsTab.test.tsx src/useExtraction.test.tsx src/useBatchExtractionReviewGrid.test.tsx src/api.test.ts src/RightRail.test.tsx e2e/canonical-evidence-lifecycle.spec.ts e2e/batch-extraction-export.spec.ts
```
