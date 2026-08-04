## Context

`useExtraction.ts` sends `{ records: [template], _strategy }` to `/api/extract` for both strategies (see `_catalog_sections.ts`'s `getExtractionStrategy`/`findPrimaryArrayKey` and `_model.ts`'s `extractWithModel`). The backend never removes this envelope from its response — `runSectionedExtraction` (Catalog) explicitly rebuilds `{ [arrayKey]: kept.map(...) }`, and the whole-document path (Article) round-trips whatever shape the `evidenceTemplate` had, which is the same `records`-wrapped shape it was given. So both strategies' responses arrive at the frontend as `{ records: [...] }`; only Catalog's array is ever meant to hold more than one item.

`ResultsTab.tsx`'s tree navigation (`currentEntries`) treats every array generically, labeling each element `Item ${i+1}` regardless of whether the array represents a real repeated group or an incidental singleton. For Article results, this surfaces as a permanent, uninformative `records → Item 1` breadcrumb in front of every field the researcher actually asked for.

## Goals / Non-Goals

**Goals:**
- An Article-strategy Extraction Result displays and exports as a flat object of the researcher's own top-level schema fields — no visible `records`/`Item 1` wrapper.
- Zero behavior change for Catalog-strategy results.
- No backend or request-shape changes — this is confined to what the frontend keeps in extraction state after a response arrives.

**Non-Goals:**
- Removing the `{ records: [template] }` request wrapper itself. That wrapper is unrelated request-plumbing (carries `_strategy` since `SchemaNode[]` has no root-metadata slot — see `heading-sectioned-extraction` design.md Decision 5) and Catalog still needs it to request sectioned extraction. Changing it would touch the backend, `api.ts`, and both strategies' request contracts for no benefit to this bug.
- Reconciling the pre-existing drift in the `extraction-results-view` spec (e.g. its "No export affordance" requirement no longer matches `ResultsTab.tsx`, which has Copy/Download controls) — out of scope, not made worse by this change.

## Decisions

### 1. Unwrap once, at the `useExtraction.ts` response boundary — not in `ResultsTab.tsx` or `evidenceHighlights.ts`

`evidenceHighlights.ts`'s `buildHighlights` already branches on `Array.isArray(result.records)`: a `records`-wrapped branch (today's only live path, for both strategies) and a "Non-wrapped: assign color per top-level key" branch that already exists but is dead code today, since every result currently carries the wrapper. Unwrapping once in `useExtraction.ts`, before `setState`, means `ResultsTab.tsx`, `EvidenceHighlightLayer.tsx`/`evidenceHighlights.ts`, JSON/Markdown export, and copy/download all automatically take that already-existing non-wrapped path for Article results — no other file needs to change.

**Alternative considered**: unwrap inside `evidenceHighlights.ts` or `ResultsTab.tsx` individually. Rejected — `buildHighlights` doesn't know the researcher's chosen strategy today (and shouldn't need to), and doing this in two display-layer places instead of one request/response boundary risks the two staying inconsistent (e.g. Copy JSON exporting the wrapped shape while the Review tree shows unwrapped fields).

### 2. Guard the unwrap: only apply when `result.records` is a non-empty array, otherwise leave `result` untouched

```
const strategyResult =
  extractionStrategy !== 'catalog' && Array.isArray(result.records) && result.records.length > 0
    ? (result.records[0] as Record<string, unknown>)
    : result
```
and symmetrically for `evidence`. If the model ever returns zero items (e.g. `isEmptyResult` filtering happened to drop everything — though that filter is Catalog-only today) or the response is shaped unexpectedly, the unwrap is skipped and the raw wrapped result is shown instead of throwing or silently discarding data. This mirrors the defensive, non-throwing style already used throughout `_model_output.ts` (e.g. `parseExtractionResult`'s schema-mismatch fallback).

**Alternative considered**: assert/throw when the shape doesn't match. Rejected — an Extraction Result is inherently model output; a defensive fallback to the pre-existing (wrapped) display is strictly safer than surfacing a hard error for what is, worst case, a cosmetic regression back to today's behavior.

### 3. Don't special-case a `records` array with more than one item for Article strategy

If an Article-strategy response ever came back with more than one `records` entry (shouldn't happen — the whole-document path never multiplies the array — but nothing currently guarantees it), the guard `result.records.length > 0` would still unwrap to just `result.records[0]`, silently discarding any extra entries. This is an accepted, narrow edge case: Article strategy's contract is "one whole-document pass, one result," so `records[0]` is definitionally the entire intended result; there is nothing correct to do with hypothetical extra entries beyond ignoring them.

## Risks / Trade-offs

- **[Risk]** A future change to the whole-document Article path could start returning something other than a length-1 `records` array without anyone noticing, since the guard silently no-ops instead of warning → **Mitigation**: this is the same trade-off the rest of this codebase already accepts for model-output shape mismatches (`_model_output.ts`); adding a `console.warn` here would be inconsistent with that precedent and isn't in scope for a display-shape bug fix.
- **[Trade-off]** `Copy JSON` / `Download` for Article strategy now export the unwrapped object rather than the previously-wrapped one. This is the intended fix, not a side effect, but it is a visible change to the exported JSON shape for anyone who had scripted against the old `{records: [...]}` export shape.

## Migration Plan

No data or API migration. Purely a frontend state-shape change scoped to `useExtraction.ts`; existing Catalog-strategy behavior and the request contract are unchanged. No rollback concerns beyond reverting the one function.
