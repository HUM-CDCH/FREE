## Why

Catalog extraction already splits canonical Markdown into record-aligned sections and extracts those sections in parallel. After merging, however, an Evidence leaf retains only model-generated `snippet` and `page`; it loses the deterministic section that the model actually read. The highlighter then searches the whole document again, so a correct result can be associated with a duplicate snippet, a wrong page, or an oversized anchor block from another record.

## What Changes

- Add backend-generated section provenance to every Evidence leaf produced by sectioned Catalog extraction. The provenance identifies the canonical-Markdown offset range and page range of the section that supplied the model input.
- Carry provenance through the Studio extraction response without exposing it as an extracted result field.
- Restrict prose-anchor and table-cell resolution to the Evidence leaf's section scope; a location outside that scope is not a valid highlight candidate.
- Resolve highlights by section/record with bounded concurrency, then draw the resolved entries in result-tree order. Unverifiable evidence remains visible in Results but is not highlighted.
- Preserve whole-document Article extraction behavior by assigning its Evidence leaves the full-document scope.

## Capabilities

### New Capabilities
- `section-scoped-evidence-provenance`: deterministic provenance metadata that binds sectioned extraction evidence to the exact canonical Markdown range and page range supplied to the model.

### Modified Capabilities
- `evidence-highlight-layer`: highlight resolution is scoped to the evidence-producing source range and must not select a location outside that range.

## Impact

- Backend extraction orchestration in `prototypes/studio/api/_model.ts` and evidence result handling in `_evidence_template.ts`.
- Frontend Evidence types, matching helpers, and `EvidenceHighlightLayer.tsx` resolution scheduling.
- Existing extraction and highlight tests, plus new cross-section duplicate-text and concurrent-resolution coverage.
- No change to the user-facing result value schema; provenance is evidence metadata only.
