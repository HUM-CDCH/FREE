## Why

Evidence highlights always rendered in yellow because color assignment was based on schema key order, but schema keys and result keys often diverged (e.g. model wraps output under a single key like `Graver`). The schema-based lookup always fell back to PALETTE[0].

## What Changes

- Remove schema-based color assignment entirely (`buildTopLevelColorMap` deleted, `schema` prop removed from `EvidenceHighlightLayer`).
- Colors are now assigned directly by result key iteration order: the k-th top-level key in the result gets `PALETTE[k % 4]`, guaranteed regardless of what the schema looks like.
- `buildHighlights` signature simplified — no `colorMap` parameter.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `evidence-highlight-layer`: Color assignment is now based on result key order, not schema key order. `schema` prop removed.

## Impact

- `prototypes/mine/pdf-render/src/evidenceHighlights.ts`: `buildHighlights` — removed `colorMap` parameter
- `prototypes/mine/pdf-render/src/EvidenceHighlightLayer.tsx`: removed `buildTopLevelColorMap`, removed `schema` from `Props` and `useEffect` deps
- `prototypes/mine/pdf-render/src/App.tsx`: removed `schema` prop from `<EvidenceHighlightLayer>`
