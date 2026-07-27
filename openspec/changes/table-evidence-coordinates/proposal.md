## Why

Evidence highlighting currently locates every extracted value by a flat, full-document text search (`EvidenceHighlightLayer`'s `findValueRects`/`rectsForQuery`), so when a table has the same value repeated across rows or columns, the wrong cell gets highlighted. The parsing service already computes precise per-cell coordinates for tables (`ParsedTable.cells[].bbox`, via Docling + Camelot enrichment in `prototypes/parsing_service/app/parsing/table_extraction.py`), but Studio never fetches `/tasks/{id}/document` and never uses this geometry — table highlight precision is stuck at "first text match in the document wins."

## What Changes

- Studio fetches the parsing service's `/tasks/{id}/document` (the full `ParsedDocument`, including `tables`) alongside the existing markdown fetch, and threads per-document table geometry to both the extraction request and the highlight layer.
- The extraction model prompt, only when the source document contains tables, asks for two additional evidence slots per leaf — `row_header` and `column_header` — naming the table row/column a value came from. Documents without tables see no prompt or schema change.
- A new pure matching function resolves an extracted value (+ its optional row/column header hints) to a specific `TableCell`: exact text match against table cells → header-hint disambiguation when multiple cells share the same text → reading-order (top-to-bottom, left-to-right) positional fallback keyed to the value's index within its `records` array → no match.
- `EvidenceHighlightLayer` tries this table-cell match first for every highlight (unconditionally, not gated on whether the field is "known" to be table-sourced). On a match, the highlight is drawn from the cell's known PDF-point bbox (converted to viewport pixels) instead of a text search. On no match, behavior is byte-for-byte the same as today (existing snippet-anchored / full-text search).
- **BREAKING** (internal-only, no external API): `parseDocumentToMarkdown` in `prototypes/studio/src/api.ts` changes its return type from `Promise<string>` to `Promise<{ taskId: string; markdown: string }>` so the resolved task id can be reused for the tables fetch. `requestExtraction` gains a new trailing `hasTables: boolean` parameter. Both call sites (`App.tsx`) update accordingly.

## Capabilities

### New Capabilities
- `table-cell-coordinate-matching`: pure function(s) that resolve an extracted evidence value + optional row/column header hints to a specific table cell's bounding box, with text-match, header-disambiguation, and reading-order-fallback tiers, degrading to "no match" when none apply.
- `table-evidence-hints`: backend evidence-template and prompt changes that let the model report which table row/column a value came from, gated on document-level table presence, without affecting documents that have no tables.

### Modified Capabilities
- `evidence-highlight-layer`: highlight resolution gains a table-cell-coordinate lookup step that runs before the existing PDF text search, using per-document table geometry threaded in as a new prop; falls back unchanged when the lookup finds nothing.
- `frontend-api-client`: `parseDocumentToMarkdown`'s return type and `requestExtraction`'s signature change to support table-geometry retrieval — narrows that spec's existing "signatures SHALL remain unchanged" guarantee to exclude this change.

## Impact

- Frontend: `prototypes/studio/src/App.tsx`, `api.ts`, `useExtraction.ts`, `evidenceHighlights.ts`, `EvidenceHighlightLayer.tsx`, a new `tableCellMatch.ts` module, and new lightweight frontend types mirroring the backend's `BoundingBox`/`TableCell`/`ParsedTable` (currently zero such types exist client-side). New/updated tests alongside each.
- Backend: `prototypes/studio/api/_evidence_template.ts` (leaf wrapper shape + split logic), `_model.ts` (prompt instruction + `extractWithModel` param), `extract.ts` (new FormData field). No change to `_model_output.ts` itself, but its existing "template shape is the strict Zod validator" behavior (`objectSchemaFromTemplate`) means the model must always emit `row_header`/`column_header` (even as `null`) once requested, or the whole leaf's validation silently falls back to raw passthrough — call this out explicitly in the new prompt wording.
- No parsing-service changes — `ParsedTable.cells[].bbox` already exists, computed today, and is read-only from Studio's perspective.
- Note on pre-existing spec drift found during research: `openspec/specs/frontend-api-client/spec.md` and `openspec/specs/nuextract-request-construction/spec.md` describe an architecture (a `streamJsonl<T>` JSONL transport; a Python `ModelGateway`/`ModelCommand` request-construction layer) that does not match the current `prototypes/studio/src/api.ts` (plain `fetch` + JSON) or `prototypes/studio/api/_model.ts` (raw NuExtract prompt string built by hand) implementations. This change does not attempt to reconcile that pre-existing drift — its delta against `frontend-api-client` is written against the actual current code, not the stale spec text.
