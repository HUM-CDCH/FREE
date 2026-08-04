## 1. Occurrence-index-aware query matching

- [x] 1.1 In `EvidenceHighlightLayer.tsx`, extract the existing per-index-range rect computation out of `rectsForQuery` into a shared `rectsForRange(data: PageTextData, start: number, end: number): DOMRect[]` helper, without changing its math.
- [x] 1.2 Add `allOccurrenceRects(data: PageTextData, query: string): DOMRect[][]`, finding every non-overlapping `indexOf` match of `query` in `data.fullText` (case-insensitive) and mapping each to its rects via `rectsForRange`.
- [x] 1.3 Change `rectsForQuery`'s signature to `rectsForQuery(data: PageTextData, query: string, occurrenceIndex: number | null): DOMRect[]`, using `allOccurrenceRects` and selecting the occurrence at `occurrenceIndex` when in range, else the first occurrence (`[]` when there are none).
- [x] 1.4 Thread `occurrenceIndex` through `searchValueAnchoredBySnippet`'s two internal `rectsForQuery` calls (value-within-snippet-subrange, and value-across-whole-page) — its own snippet-location `indexOf` call is unchanged.
- [x] 1.5 Add `occurrenceIndex: number | null` as a parameter to `findValueRects`, passed through to every `rectsForQuery`/`searchValueAnchoredBySnippet` call inside it.
- [x] 1.6 At the call site in the main render effect, pass the already-computed `occurrenceIndex` (from `computeOccurrenceIndices`) into `findValueRects`, alongside the existing `findTableCellRects` call.
- [x] 1.7 (Not in original plan — implementation deviation.) Moved `PageTextData`, `getPageTextData`, `rectsForRange`, `allOccurrenceRects`, `rectsForQuery`, `searchValueAnchoredBySnippet`, `PageRects`, and `findValueRects` out of `EvidenceHighlightLayer.tsx` into a new `evidenceTextSearch.ts` module. Exporting these directly from `EvidenceHighlightLayer.tsx` (needed so 3.1/3.2's tests can import them) tripped `react-refresh/only-export-components` — Vite's fast-refresh lint rule refuses a component file that also exports plain functions/types. `evidenceTextSearch.ts` mirrors the existing `tableCellMatch.ts` pattern (pure matching logic in its own module, imported by the component); `EvidenceHighlightLayer.tsx` now only imports `findValueRects`/`PageRects` from it. No behavior change, confirmed by the full test suite and `tsc -b && vite build` both passing.

## 2. Page-anchored fallback reordering

- [x] 2.1 In `findValueRects`'s progressive-shortening fallback, swap the loop nesting from query-outer/page-inner to page-outer/query-inner, fetching each page's `PageTextData` once and trying all query tiers (full, 5-word, 3-word) against it before moving to the next page.

## 3. Tests

- [x] 3.1 Extend `EvidenceHighlightLayer.test.ts` (importing from the new `evidenceTextSearch.ts`): a page with two occurrences of the same value resolves each of two same-value highlights to its own `occurrenceIndex`'s occurrence, not both to the first; `occurrenceIndex: null` or out-of-range falls back to the first occurrence unchanged; single-occurrence values are unaffected. Also covers `searchValueAnchoredBySnippet`'s occurrence-index threading directly.
- [x] 3.2 Test the reordered fallback: a hint page that matches at the 3-word tier is preferred over a different page that matches at full specificity; and that the hint page is skipped in favor of another page when it has no match at any tier.
- [x] 3.3 Run the full `prototypes/studio` test suite (`pnpm vitest run`: 111 passed, 1 pre-existing skip), `tsc -b && vite build`, and `pnpm run lint` (identical pre-existing 8 errors/1 warning baseline — confirmed by diffing against a `git stash`'d run of the same command — no new lint issues introduced).

## 4. Manual verification

- [ ] 4.1 In the running app (`pnpm dev`) against the Ellekilde example, find or construct a case where a value repeats across two records on the same page and confirm each record's highlight now lands on its own occurrence rather than both landing on the first. **Not performed** — no browser-driving tool available in this environment; needs a human (or a browser-automation-capable session) to verify visually.
