## Context

`EvidenceHighlightLayer.tsx`'s main render effect (`render()`) already computes `occurrenceIndices = computeOccurrenceIndices(highlights)` once per pass — a `Map` ranking each highlight by which occurrence it is among other highlights sharing the same `(field key, normalized value, hint page)` triple, in document/traversal order (`tableCellMatch.ts`). It is passed to `findTableCellRects` (line 320) but never to `findValueRects` (line 321), so the table-cell-coordinate path already resolves "this value appears more than once, which occurrence is *this* highlight's?" while the plain-text path does not.

Plain-text search (`rectsForQuery`, `searchValueAnchoredBySnippet`) uses `String.prototype.indexOf`, which always returns the *first* match in the searched text. `findValueRects`'s fallback tiers — snippet-anchored search, then a direct search with progressively shortened queries (full value, first 5 words, first 3 words) — only get *less* specific as they fall through, which makes a coincidental wrong-location match *more* likely the further a value has to fall back, with nothing to catch it: the first `indexOf` hit is accepted unconditionally regardless of whether other, equally-valid-looking occurrences exist elsewhere.

Separately, `findValueRects`'s progressive-shortening loop is nested query-outer/page-inner:
```
for (const query of queries) {
  for (const p of pages) { ... }
}
```
This means if the *full* value fails to match on the hint page for any reason, every *other* page is tried at full specificity before the hint page is ever retried at a shorter, looser tier — the search wanders away from the correct page before it has exhausted looser-but-still-plausible matches on the page the evidence actually said it was on.

## Goals / Non-Goals

**Goals:**
- When a query (value, or value-within-snippet) matches more than one location on a page, prefer the location whose reading-order position corresponds to the highlight's own `occurrenceIndex` — the same disambiguation `findTableCellMatch` already does for table cells — instead of always taking the first `indexOf` hit.
- Reorder the fallback search so a page (hint page first) is tried at every specificity tier (full value → 5 words → 3 words) before the search widens to other pages, keeping matches anchored to the page the evidence actually points at for as long as possible.
- Never regress behavior for the common case (value appears exactly once, unambiguously) — these changes only take effect when there is more than one candidate to choose between.

**Non-Goals:**
- Fuzzy/approximate text matching (dash-variant tolerance, snippet-location fallback for values with no verbatim match at all) — that is `evidence-highlight-matching-fixes`, already in flight, and orthogonal: that change is about *recall* (finding a match at all), this one is about *precision* (picking the right match among several already-found candidates).
- Disambiguating a repeated *snippet* (the same snippet text appearing verbatim more than once on a page) — `occurrenceIndex` is keyed on the highlight's `value`, not its `snippet`; a snippet that itself repeats can still anchor to the wrong copy before value-level disambiguation ever runs. This is an accepted residual limitation, parallel to the sibling change's "repeated-value ambiguity" non-goal — narrowing this further would require ranking snippet occurrences too, which is a larger change than the concrete bug reported.
- Porting a general edit-distance/fuzzy-matching library — unrelated to this change's scope.

## Decisions

### 1. Collect every occurrence of a query on a page, select by `occurrenceIndex`, default to the first when unavailable or out of range

`rectsForQuery` changes from "return rects for the first `indexOf` hit" to "find every non-overlapping occurrence of `query` in `data.fullText`, in reading order (the order `data.fullText` is built in — item order on the page), then return the occurrence at `occurrenceIndex` when one exists at that index, else the first occurrence (index 0)." Concretely:

```ts
function allOccurrenceRects(data: PageTextData, query: string): DOMRect[][] {
  const results: DOMRect[][] = []
  let from = 0
  const q = query.toLowerCase()
  if (!q) return results
  for (;;) {
    const idx = data.fullText.toLowerCase().indexOf(q, from)
    if (idx === -1) break
    results.push(rectsForRange(data, idx, idx + query.length))
    from = idx + query.length // non-overlapping; a repeated value never legitimately overlaps itself
  }
  return results
}

function rectsForQuery(data: PageTextData, query: string, occurrenceIndex: number | null): DOMRect[] {
  const all = allOccurrenceRects(data, query)
  if (all.length === 0) return []
  if (occurrenceIndex !== null && occurrenceIndex >= 0 && occurrenceIndex < all.length) {
    return all[occurrenceIndex]
  }
  return all[0]
}
```
`rectsForRange` is the existing per-index-range rect computation already inside today's `rectsForQuery`, extracted so both the single-match and multi-match paths share it. `searchValueAnchoredBySnippet`'s two internal `rectsForQuery` calls (within the snippet sub-range, and across the whole page) both gain the same `occurrenceIndex` parameter and pass it straight through — its own snippet-location `indexOf` call is unchanged (see Non-Goals).

Falling back to occurrence 0 (not `null`/no-match) when `occurrenceIndex` is absent or out of range keeps today's behavior as the floor: this only ever *narrows* which of several already-found matches gets picked, it never turns an existing match into a non-match. This mirrors `findTableCellMatch`'s established pattern of only using `occurrenceIndex` to pick among already-narrowed candidates, never to reject a page that has a match.

**Alternative considered**: return `null`/`[]` when `occurrenceIndex` is out of range (matching `findTableCellMatch`'s stricter behavior, which returns `null` so the caller can fall back to a different tier entirely). Rejected here — unlike the table path, there is no further-fallback tier below plain-text search; refusing to draw anything when we already found *a* plausible occurrence would reintroduce the "highlight disappears" failure mode `evidence-highlight-matching-fixes` is busy fixing, trading one bug for another.

### 2. Reorder `findValueRects`'s progressive-shortening fallback to page-outer, query-inner

```ts
for (const p of pages) {
  const data = await getPageTextData(pdfViewer, p)
  if (!data) continue
  for (const query of queries) {
    const rects = rectsForQuery(data, query, occurrenceIndex)
    if (rects.length > 0) return { pageNumber: p, rects }
  }
}
```
replacing today's query-outer/page-inner nesting. Each page (hint page first, per the existing `pages` ordering) is now tried at every specificity tier — full value, then first 5 words, then first 3 words — before the search ever moves to another page. This keeps a match anchored to the hint page as long as any tier can find one there, and only wanders elsewhere when the hint page has no match at all, at any tier. As a side effect, this also halves redundant `getPageTextData` calls in the common case (today's nesting re-fetches every page's text data once per query tier; the reordered loop fetches each page once and tries all tiers against it).

**Alternative considered**: keep query-outer/page-inner but special-case "try the hint page across all tiers first, then fall back to today's query-outer loop for the rest." Rejected as needless complexity — page-outer/query-inner achieves the same prioritization for every page, not just the hint page, with simpler code and no special-casing.

### 3.5 Implementation addendum: text-search helpers moved to a new `evidenceTextSearch.ts` module

Not anticipated when this design was written: exporting `rectsForQuery`/`searchValueAnchoredBySnippet`/`findValueRects`/`PageTextData` directly from `EvidenceHighlightLayer.tsx` (needed so tests can exercise them) trips ESLint's `react-refresh/only-export-components` — a `.tsx` file whose default export is a React component cannot also export plain functions/types without breaking Vite's fast-refresh. Fix: moved `PageTextData`, `getPageTextData`, `rectsForRange`, `allOccurrenceRects`, `rectsForQuery`, `searchValueAnchoredBySnippet`, `PageRects`, and `findValueRects` into a new `evidenceTextSearch.ts` module, imported by `EvidenceHighlightLayer.tsx` (which now only pulls in `findValueRects`/`PageRects`). This mirrors the codebase's existing `tableCellMatch.ts` — pure matching logic already lives in its own module, separate from the component that calls it — so this isn't a new pattern, just applying the existing one to the text-search path too. Pure relocation, no behavior change (verified: full test suite, `tsc -b && vite build`, and `pnpm run lint` all produce identical results to before the move, modulo the new tests themselves).

### 4. `occurrenceIndex` threading stays exactly as already computed — no change to `computeOccurrenceIndices`

`computeOccurrenceIndices` (in `tableCellMatch.ts`) is reused unchanged; `EvidenceHighlightLayer.tsx`'s render effect already computes it for every highlight, once, before the per-highlight search loop. The only change at the call site is passing the already-computed `occurrenceIndex` into `findValueRects` alongside the existing `hintPage` argument (currently only passed to `findTableCellRects`).

## Risks / Trade-offs

- **[Risk]** `occurrenceIndex` is derived from the *highlight's* traversal order (schema field/record order), not from the *page's* physical reading order — if a document's record order doesn't correspond to the order values actually appear on the page (e.g. out-of-order records), the index could still point at the wrong occurrence → **Mitigation**: this is the same assumption `findTableCellMatch` already relies on for table cells today, and is an accepted trade-off already validated in production for that path; extending it to text is not a new risk class, just the same one applied to a second matcher.
- **[Risk]** Treating `from = idx + query.length` as non-overlapping could miss a genuinely overlapping repeated value (e.g. `"aa"` inside `"aaa"`) → **Mitigation**: evidence values are field-level extracted strings (names, numbers, dates, short phrases), not single-repeated-character patterns; self-overlapping matches are not a realistic case for this data, and the existing code already had no attempt to handle it either.
- **[Trade-off]** The reordered fallback loop (Decision 2) means a page that would have matched at the *full* query on some later page (today's behavior) may now instead match at a *shorter* tier on an earlier page (the hint page) — this is the explicit intent of the change: a looser match on the page the evidence claims to be on is treated as more trustworthy than an exact match on an unrelated page.

## Migration Plan

No data or API migration — this only changes internal matching/selection logic inside `EvidenceHighlightLayer.tsx`'s plain-text search helpers. Purely additive from the researcher's point of view: highlights that previously landed on a coincidentally-matching-but-wrong location now prefer the occurrence and page consistent with the highlight's own position among repeated values.

## Open Questions

None — self-contained to `EvidenceHighlightLayer.tsx`, reusing `tableCellMatch.ts`'s existing `computeOccurrenceIndices` without modification.
