## Why

Source scopes prevent document-wide matching, but their relationship to
geometry is implicit and table ownership is repeatedly inferred during
highlight resolution. Explicit segment identities and a one-time geometry
index make same-page catalog records deterministic, inspectable, and safe for
parallel resolution.

## What Changes

- Attach a deterministic Studio API-generated `segment_id` to every Evidence
  `source_scope`; Catalog sections use their section-input identity and
  Article extraction uses one full-document identity.
- Build one frontend geometry index per extraction, mapping each segment ID to
  its eligible anchors and tables.
- Assign a table to at most one segment. A table whose canonical Markdown view
  cannot be placed uniquely is left unassigned and never guessed from model
  page metadata.
- Resolve highlight groups concurrently from their indexed geometry, then keep
  result traversal order for cached entries and canvas painting.

## Capabilities

### New Capabilities
- `segment-geometry-index`: deterministic extraction provenance and a
  reusable segment-to-anchor/table geometry index.

### Modified Capabilities
- `evidence-highlight-layer`: consume explicit segment geometry instead of
  deriving table ownership during each highlight group resolution.

## Impact

- Studio API Evidence construction in `api/_evidence_template.ts` and
  `api/_model.ts`.
- Frontend Evidence types, parsed-table handling, segment geometry helpers,
  and `EvidenceHighlightLayer.tsx`.
- Focused API/frontend tests for section identity, same-page tables,
  ambiguous tables, concurrency, and deterministic drawing.
- No parsing-service reprocessing or model-prompt change.
