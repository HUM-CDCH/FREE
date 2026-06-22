## Why

Evidence highlights appear at the correct page but are offset from the actual text — consistently displaced because the `.page` element in the PDF viewer has a 9px transparent border, and the current coordinate calculation uses `getBoundingClientRect()` (which returns the border box) without compensating for that border.

## What Changes

- In `EvidenceHighlightLayer`, the canvas draw coordinates for each highlight rectangle are adjusted to account for the `.page` element's border by adding `pageEl.clientTop` and `pageEl.clientLeft` to the page-relative offsets.

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `evidence-highlight-layer`: The page-to-canvas coordinate mapping now correctly offsets for the `.page` element's border width.

## Impact

- `prototypes/mine/pdf-render/src/EvidenceHighlightLayer.tsx` — two-line change in the `render` function
- No backend changes
- No API changes
