## 1. Rewrite `evidence_template.py`

- [x] 1.1 Rewrite `wrap_template_with_evidence` in `prototypes/mine/backend/shared/evidence_template.py`: replace each scalar value in the template with `{"value": <original_type_hint>, "snippet": "string", "page": "number"}` — apply this recursively to top-level scalars and to scalar subfields within array-item schemas; remove the separate `_evidence` block entirely
- [x] 1.2 Rewrite `split_evidence_result` in the same file: recursively traverse the result; at a `{"value", "snippet", "page"}` leaf, split into `value` (clean result) and `{"snippet", "page"}` (evidence); at a dict recurse into each key; at a list recurse into each item; fall back to keeping bare values as-is with no evidence when the model didn't follow the format

## 2. Update the few-shot example and instruction

- [x] 2.1 Rewrite `STRUCTURED_EXTRACTION_EXAMPLE.schema_json` in `prototypes/mine/backend/shared/few_shot_examples.py` to use the inline `{"value": type_hint, "snippet": "string", "page": "number"}` shape for every scalar field, including scalar subfields within the array-item schema; no `_evidence` key at any level
- [x] 2.2 Rewrite `STRUCTURED_EXTRACTION_EXAMPLE.result_json` to show correctly filled inline evidence at every scalar leaf, with broad context snippets; no `_evidence` key at any level
- [x] 2.3 Update `_EVIDENCE_INSTRUCTION` in `prototypes/mine/backend/shared/nuextract_request.py` to describe the inline format: for each extracted field return `{"value": <extracted>, "snippet": <broader_context_passage>, "page": <1-based_page>}`

## 3. Update `EvidenceHighlightLayer`

- [x] 3.1 Add optional `value?: string` to the `Highlight` type in `prototypes/mine/pdf-render/src/EvidenceHighlightLayer.tsx`; update `collectLeaves` to extract `value` from `{snippet, page, value}` leaves and pass it through
- [x] 3.2 Add an optional `valueToHighlight?: string` parameter to `searchSnippetInPage`; after locating the snippet range `[idx, idx+snippetLen]`, search for `valueToHighlight` within that range; if found use `[valueStart, valueStart+valueLen]` as the highlight range; if not found fall back to the full snippet range
- [x] 3.3 Pass `h.value` as `valueToHighlight` when calling `searchSnippetInPage` inside `findSnippetRects`
