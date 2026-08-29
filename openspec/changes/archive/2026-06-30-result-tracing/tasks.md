## 1. Palette

- [x] 1.1 Update `PALETTE` in `evidenceHighlights.ts` to Paul Tol's Muted: sky blue `rgba(148,203,236,0.55)`, olive `rgba(220,205,125,0.55)`, rose `rgba(194,106,119,0.45)`, teal `rgba(93,168,153,0.45)` — already partially done, verify constants match spec

## 2. EvidenceHighlightLayer — cache and focus

- [x] 2.1 Add `CachedEntry` type `{ highlight: Highlight; pageNumber: number; rects: DOMRect[]; pageTop: number; pageLeft: number }` and `cachedEntriesRef = useRef<CachedEntry[]>([])` in `EvidenceHighlightLayer`
- [x] 2.2 Add `focusValue: string | null` prop to `EvidenceHighlightLayer` Props type and component signature
- [x] 2.3 Add `focusValueRef` (ref that tracks `focusValue`) and `[cacheVersion, setCacheVersion]` state in `EvidenceHighlightLayer`
- [x] 2.4 In the main render effect: clear `cachedEntriesRef.current = []` at start; after finding each `pageTop`/`pageLeft`, push entry to `cachedEntriesRef`; read `focusValueRef.current` when setting `ctx.globalAlpha` (0.25 dimmed, 1.0 normal; double-draw active at globalAlpha 0.6); call `setCacheVersion(v => v + 1)` on completion
- [x] 2.5 Add focus effect with deps `[focusValue, cacheVersion, containerEl]`: scroll container to active entry's rect, redraw canvas from cache using same dim/double-draw logic; return early when `cachedEntriesRef.current.length === 0`

## 3. ResultValue — onValueClick prop

- [x] 3.1 Add `onValueClick?: (value: string) => void` to `ResultValueProps` and thread it into `PrimitiveRow`, `ObjectSection` (pass through to children), and `ArraySection` (pass through to children)
- [x] 3.2 In `PrimitiveRow`: add `cursor-pointer` class to the value text span and call `onValueClick?.(text)` in its `onClick` handler (only when value is non-empty)

## 4. Thread onValueClick up the tree

- [x] 4.1 Add `onValueClick?: (value: string) => void` to `ResultsTabProps`; pass it to `<ResultValue>` in the review view
- [x] 4.2 Add `onValueClick?: (value: string) => void` to `RightRailProps`; pass it to `<ResultsTab>`
- [x] 4.3 In `App`: add `focusValue: string | null` state; implement `handleValueClick` (toggle: same value → null, new value → set); reset `focusValue` to null in `onComplete` extraction callback; pass `focusValue` to `<EvidenceHighlightLayer>` and `onValueClick={handleValueClick}` to `<RightRail>`

## 5. Verify

- [x] 5.1 Run `pnpm build` in `prototypes/studio` and confirm zero TypeScript errors
