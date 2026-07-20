## Why

Extraction results are currently read-only text with no connection back to the source document. Humanities researchers need to verify extracted values against the original text—without a direct link, they must manually search the PDF, which is slow and error-prone.

## What Changes

- Clicking any primitive result value in the Results tab scrolls the PDF viewer to the page where that value appears and intensifies its highlight (active value at full opacity, all others dimmed).
- Clicking the same value again deselects (toggle behaviour).
- The active focus resets when a new extraction completes.
- The evidence highlight palette is replaced with four colours from Paul Tol's Muted set (sky blue, olive, rose, teal) for improved colorblind accessibility; the transparent variants used as overlays remain distinguishable under deuteranopia, protanopia, and tritanopia.

## Capabilities

### New Capabilities

- `result-tracing`: Click-to-trace interaction that connects a result value in the Results tab to its location in the PDF viewer.

### Modified Capabilities

- `evidence-highlight-layer`: Colour palette updated to Paul Tol's Muted; layer now accepts a `focusValue` prop and redraws with focus/dim state without re-running the PDF text search.
- `extraction-results-view`: Result value rows become clickable (trace trigger); `onValueClick` callback threaded from `PrimitiveRow` up through `ResultValue`, `ResultsTab`, `RightRail` to `App`.

## Impact

- `prototypes/studio/src/evidenceHighlights.ts` — palette constants
- `prototypes/studio/src/EvidenceHighlightLayer.tsx` — focus prop, position cache, redraw logic
- `prototypes/studio/src/ResultValue.tsx` — `onValueClick` prop on `PrimitiveRow`
- `prototypes/studio/src/ResultsTab.tsx` — thread `onValueClick`
- `prototypes/studio/src/RightRail.tsx` — thread `onValueClick`
- `prototypes/studio/src/App.tsx` — `focusValue` state, wire callbacks
