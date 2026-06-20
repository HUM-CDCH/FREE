## Why

`EvidenceHighlightLayer` was added as part of the evidence highlighting feature but shipped with two defects: debug `console.log` statements left over from development, and a `useEffect` dependency array that omits `schema` — meaning highlight colors silently stale when the extraction schema changes.

## What Changes

- Two `console.log` calls are removed from the component body
- `schema` is added to the `useEffect` dependency array, making highlight color recalculation reactive to schema updates

## Capabilities

### New Capabilities

### Modified Capabilities
- `evidence-highlight-layer`: The component now responds correctly to schema changes (depth-based colors update on re-render) and no longer emits debug output to the browser console.

## Impact

- `prototypes/mine/pdf-render/src/EvidenceHighlightLayer.tsx`: remove 2 console.log lines, add `schema` to useEffect deps
