## Context

`EvidenceHighlightLayer` is a new React component that renders evidence snippets as colored overlays on the PDF viewer canvas. It was introduced alongside the evidence highlighting feature and contains two defects introduced during development.

## Goals / Non-Goals

**Goals:**
- Remove debug console.log statements
- Add `schema` to the `useEffect` dependency array

**Non-Goals:**
- Changing highlight rendering logic
- Improving snippet search performance
- Altering color assignment logic

## Decisions

### Decision 1: Add `schema` to deps rather than memoizing `depthMap`

The simplest fix is to add `schema` to the dependency array. An alternative would be to memoize `depthMap` with `useMemo` and depend on it instead — but that would be a larger change with no benefit at current scale. `schema` is a plain object prop; React's shallow comparison will trigger re-runs correctly.

## Risks / Trade-offs

Adding `schema` to deps means the effect re-runs on every render where `schema` reference changes. Since `schema` is derived from streamed extraction state, it will change frequently during extraction. This is the correct behavior — highlights should update as the schema fills in — but it does mean more canvas redraws during streaming. Acceptable at current scale.
