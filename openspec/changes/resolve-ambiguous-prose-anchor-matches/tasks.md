# Resolve Ambiguous Prose Anchor Matches

- [ ] In `prototypes/studio/src/markdownAnchorMatch.ts`, stop treating scoped duplicate prose matches as an automatic hard failure when there is a stable disambiguator available.
- [ ] Extend `findScopedMarkdownAnchorMatch(...)` to accept `occurrenceIndex: number | null` and pass it through to `findMarkdownAnchorMatch(...)` for both the primary term and fallback snippet.
- [ ] In `findMarkdownAnchorMatch(...)`, keep the existing `sourceScope` boundary strict: only collect occurrences whose full snippet range is inside `sourceScope.markdownStart` and `sourceScope.markdownEnd`, and only resolve against anchors overlapping that scope.
- [ ] For scoped matches, return the sole covered match when exactly one exists; when multiple covered matches exist, return `matches[occurrenceIndex]` only if `occurrenceIndex` is non-null and in range; otherwise return `null`.
- [ ] Do not use `hintPage` to widen or rescue scoped duplicate prose anchor matches; page hints may narrow unscoped legacy lookup only.
- [ ] In `prototypes/studio/src/EvidenceHighlightLayer.tsx`, thread the already-computed occurrence index for each highlight into `findAnchorRects(...)`, then into `findScopedMarkdownAnchorMatch(...)`.
- [ ] Verify that occurrence indexing is scoped enough for nested duplicate fields such as `records.6.finds.2.*`; if `computeOccurrenceIndices(...)` currently groups too broadly or too narrowly, adjust only its keying logic in `prototypes/studio/src/tableCellMatch.ts` and preserve existing table-cell disambiguation behavior.
- [ ] Add focused tests in `prototypes/studio/src/markdownAnchorMatch.test.ts` for: two identical snippets inside one source scope with two covered anchors and `occurrenceIndex: 1` selecting the second bbox; the same duplicate case without `occurrenceIndex` returning `null`; out-of-range `occurrenceIndex` returning `null`; and duplicate snippets outside the source scope remaining ignored.
- [ ] Add or update a focused `EvidenceHighlightLayer`/routing test if needed to prove the render path supplies occurrence indices to scoped prose anchor lookup.
- [ ] Run the relevant frontend tests from `prototypes/studio`, at minimum the markdown anchor match tests and any updated highlight-layer tests.
