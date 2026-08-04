## Why

`useExtraction.ts` sends every Extraction Schema wrapped as `{ records: [template], _strategy }` regardless of whether the researcher chose the Catalog or Article strategy — a plumbing artifact needed so `_strategy` can ride alongside the schema without a root-metadata slot on `SchemaNode[]` (see `heading-sectioned-extraction`'s design.md Decision 5). For Catalog documents this wrapper is meaningful: `runSectionedExtraction` genuinely produces one array entry per detected section. For Article documents — a single continuous document extracted in one whole-document pass — the array is structurally guaranteed to hold exactly one entry, so it carries no information. The Results tab's generic array rendering still displays it as a `records → Item 1` layer wrapping every real field, which reads as if the document had been split into multiple records when it was extracted as one whole.

## What Changes

- `useExtraction.ts`: when the researcher's chosen strategy is not `'catalog'`, unwrap the Extraction Result and its evidence one level (`result.records[0]`, `evidence?.records?.[0] ?? null`) before storing them in extraction state, so an Article-strategy result presents as a flat object of the researcher's own top-level fields instead of a singleton `records` array.
- No change to the request sent to the backend, to `extractWithModel`, or to the Catalog path — the wrapper stays exactly as-is on the way in; only the Article-strategy response is reshaped once, at the point it enters frontend state.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `extraction-results-view`: an Article-strategy Extraction Result no longer displays a singleton `records` array wrapper around the researcher's own fields.

## Impact

- Frontend: `prototypes/studio/src/useExtraction.ts` (the only change), and its test file. No changes needed in `ResultsTab.tsx`, `EvidenceHighlightLayer.tsx`, or `evidenceHighlights.ts` — `evidenceHighlights.ts`'s `buildHighlights` already has a "non-wrapped" code path (used today only when a template has no `records` key at all) that an unwrapped Article result now reaches naturally.
- No backend, schema, or API changes — the request shape and the Catalog strategy's response shape are untouched.
