# Resolve Ambiguous Prose Anchor Matches

- [x] Add optional canonical provenance to frontend highlight/evidence objects, shaped as `canonicalSpan: { markdownStart: number; markdownEnd: number } | null`.
- [x] Populate `canonicalSpan` while building highlights by searching the field's `value` or `snippet` only inside its existing `sourceScope`; set it only when exactly one scoped canonical-Markdown occurrence exists.
- [x] In `prototypes/studio/src/markdownAnchorMatch.ts`, add a span-based resolver that resolves anchors directly from `canonicalSpan` without re-searching snippet text.
- [x] Update `prototypes/studio/src/EvidenceHighlightLayer.tsx` to prefer span-based anchor resolution before the existing snippet-based anchor lookup.
- [x] Preserve existing fallback behavior when `canonicalSpan` is absent, ambiguous, outside scope, or has no anchor coverage.
- [x] Add focused tests proving duplicate snippets inside one source scope do not guess, while a unique scoped `canonicalSpan` resolves to the intended anchor bbox.
