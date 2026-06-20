## 1. EvidenceHighlightLayer.tsx

- [x] 1.1 Replace `DEPTH_COLORS` with a 4-entry `PALETTE` array of rgba color strings
- [x] 1.2 Replace `buildDepthMap` with `buildTopLevelColorMap(schema)` — iterates top-level schema keys (skipping `_evidence`), assigns `PALETTE[k % 4]` to each, returns `Record<string, string>`
- [x] 1.3 Replace `depthColor(fieldKey, depthMap)` with `topLevelColor(fieldKey, colorMap)` — direct lookup with `PALETTE[0]` fallback
- [x] 1.4 Update `buildHighlights` to accept and use `colorMap: Record<string, string>` instead of `depthMap`
- [x] 1.5 Update the `useEffect` body to call `buildTopLevelColorMap(schema)` and pass the result to `buildHighlights`

## 2. Verify

- [x] 2.1 Confirm `DEPTH_COLORS` and `buildDepthMap` are fully removed (no dead code remains)
- [x] 2.2 Confirm each top-level scalar key in the schema produces a highlight in a different color from its neighbors
