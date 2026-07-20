## Context

The extraction pipeline produces a `result` object and an `evidence` object. `EvidenceHighlightLayer` already searches the PDF text for each result value and draws coloured rectangles on a canvas. The canvas is redrawn whenever `result`, `evidence`, PDF scale, or container size changes—but never when the researcher clicks a value in the Results tab, because the Results tab and the highlight layer have no shared interaction state.

The position-finding step (`findValueRects`) is asynchronous and potentially slow (iterates every PDF page). Any focus UX that re-triggers a full search on every click will feel sluggish.

## Goals / Non-Goals

**Goals:**
- Clicking a primitive value in the Results tab scrolls the PDF to that value's location.
- The active highlight becomes more vivid; all others are dimmed.
- Clicking the same value again deselects (toggle).
- No new network calls are needed.
- Palette is updated to Paul Tol's Muted (four colours) for colorblind accessibility.

**Non-Goals:**
- Highlighting of multi-word spans that cross page boundaries.
- Animating the scroll-to target.
- Tracing object/array headers (only leaf primitive values).
- Persisting focus state across extractions or page reloads.

## Decisions

### D1: Cache PDF positions in a ref after the initial canvas render

After the main render effect finds each highlight's page and rect, those `{ highlight, pageNumber, rects, pageTop, pageLeft }` entries are stored in `cachedEntriesRef`. A `cacheVersion` state integer is incremented when the full search finishes.

**Alternative considered:** Re-run `findValueRects` on every click.  
**Rejected:** Searching the full PDF for a value takes O(pages) async operations and blocks the UI thread briefly per page. For a 100-page document this is ~1 second per click—unacceptable.

**Alternative considered:** Run all searches up-front in a parallel `Promise.all` before first paint.  
**Rejected:** Would delay the first highlight from appearing. Progressive rendering gives faster perceived performance.

### D2: Separate focus effect reads from the cache

A second `useEffect` with deps `[focusValue, cacheVersion, containerEl]` handles scroll + redraw. It reads `cachedEntriesRef.current` (a ref, not state) to avoid stale-closure issues and to decouple from the expensive search effect.

**Why not put focusValue in the main effect's deps?**  
That would re-run the full search on every click. With the cache approach, the focus effect is synchronous canvas operations only.

### D3: Progressive draw respects current focusValue via a ref

During the async search (before `cacheVersion` increments), the main effect reads `focusValueRef.current` when drawing each newly-found highlight. This means the progressive draw is always consistent with the current focus state, even before the cache is complete.

### D4: focusValue is threaded as React prop state from App downward

`App` owns `focusValue: string | null` state. `onValueClick` is threaded: `PrimitiveRow → ResultValue → ResultsTab → RightRail → App`. `App` passes `focusValue` to `EvidenceHighlightLayer`.

**Alternative considered:** Context or a shared store.  
**Rejected:** Overkill for a single string; prop threading through four components is straightforward.

### D5: Toggle deselect; reset on new extraction

Clicking a focused value sets `focusValue` to `null` (toggle). When extraction completes (`onComplete` in `useExtraction`), `App` resets `focusValue` to `null` so stale focus from a previous run does not persist.

### D6: Dim factor 0.25 globalAlpha for non-active; double-draw for active

Non-active highlights are drawn with `ctx.globalAlpha = 0.25`, making them very faint but still visible as spatial context. The active highlight is drawn twice—first at `globalAlpha = 1.0`, then at `globalAlpha = 0.6`—to push its effective opacity above the palette alpha (≈0.45–0.55) without re-parsing the colour string.

## Risks / Trade-offs

- **Cache staleness after layout change**: `pageTop`/`pageLeft` are computed relative to the container's scroll origin. They remain valid across container scrolls but become stale after zoom or window resize. The existing `scale` / `containerVersion` state deps on the main effect handle this—they clear the cache and re-search. The focus effect won't find stale entries because `cacheVersion` is also bumped.

- **Value collisions**: Two fields with the same string value will both respond to a single click. For most archaeological data this is harmless (e.g., all graves marked "ja" for a boolean field). A path-based focus key would eliminate ambiguity but adds complexity not warranted at this stage.

- **Canvas size mismatch**: The focus effect redraws on the existing canvas (sized by the main effect). If the container resizes between the two effects, the canvas dimensions may be stale. The `containerVersion` → main effect re-run keeps this window short.
