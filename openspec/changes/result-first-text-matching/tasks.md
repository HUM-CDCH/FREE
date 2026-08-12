# Result-First Text Matching

Make every non-table text evidence leaf match result-first instead of the
schema-driven `verbatim-string` split. Table evidence (row/column headers or a
`|`-prefixed snippet) and non-string primitives (numbers, booleans) keep the
snippet-primary path so bare values like `5` cannot anchor a match.

## 1. Strategy selection

- [x] 1.1 Change `collectEvidenceLeaf` in `prototypes/studio/src/evidenceHighlights.ts` so any string result that is not table-like gets `result-primary`; table-like strings and non-strings stay `snippet-primary`.
- [x] 1.2 Reuse `isTableLikeEvidence` (not a copy) by widening its parameter to the `rowHeader`/`columnHeader`/`snippet` subset in `prototypes/studio/src/tableEvidence.ts`; handle the now-unused `schema` parameter (`noUnusedParameters`).

## 2. Tests

- [x] 2.1 Update the existing strategy-selection assertion in `prototypes/studio/src/EvidenceHighlightLayer.test.ts` (a plain string summary now resolves `result-primary`).
- [x] 2.2 Add regressions: plain string -> `result-primary`; table-like evidence (pipe snippet / headers) -> `snippet-primary`; numbers/booleans unchanged.

## 3. Verification

- [x] 3.1 Run `pnpm vitest run` (excluding the pre-existing `ProjectNavigation.test.tsx` failure), `tsc -b`, and eslint on changed files.
