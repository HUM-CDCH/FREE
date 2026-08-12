## 1. Implement the unwrap

- [x] 1.1 In `useExtraction.ts`, add a small pure helper (e.g. `unwrapArticleResult(strategy, result, evidence)`) implementing the guarded unwrap from design.md Decision 2 — returns `{ result, evidence }` unchanged for `'catalog'`, and unwraps `result.records[0]` / `evidence?.records?.[0] ?? null` for any other strategy when `result.records` is a non-empty array, otherwise falls back to the original values unchanged. Export it so it can be unit-tested directly (this codebase has no hook-testing infra — see `heading-sectioned-extraction`'s tasks.md precedent of testing pure helpers instead of the hook itself).
- [x] 1.2 Call this helper on the `{ result, evidence }` returned from `requestExtraction`, before `setState({ status: 'ready', result, evidence })`, passing the `extractionStrategy` already in scope.

## 2. Tests

- [x] 2.1 Add `useExtraction.test.ts` (new file) covering the pure helper: Article strategy with a well-formed singleton `records` array unwraps both `result` and `evidence`; Catalog strategy is passed through unchanged regardless of shape; Article strategy with a missing/empty/non-array `records` falls back to the original wrapped value unchanged; `evidence: null` stays `null` after unwrapping (not defaulted to `{}`).
- [x] 2.2 Run the full `prototypes/studio` test suite and confirm no regressions in existing `ResultsTab`/`evidenceHighlights`/`useExtraction`-adjacent coverage. (104 passed, 1 pre-existing skip; `tsc -b && vite build` also clean.)

## 3. Manual verification

- [ ] 3.1 In the running app (`pnpm dev`), generate an Article-strategy schema against the Ellekilde example, run extraction, and confirm the Review tree's top level shows the schema's own fields directly (no `records`/`Item 1` breadcrumb), Copy JSON/Download reflect the flat shape, and evidence highlights still resolve correctly.
- [ ] 3.2 Repeat with a Catalog-strategy schema and confirm the `records` array with one entry per detected record still displays exactly as before.
