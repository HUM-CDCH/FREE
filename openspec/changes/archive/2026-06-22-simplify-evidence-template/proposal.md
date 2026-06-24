## Why

The current evidence mechanism puts `_evidence` in a separate top-level block that mirrors the entire schema structure, including per-item nesting for arrays. This forces the model to maintain two parallel structures simultaneously — values in one place, evidence in another — which is structurally redundant and produces unstable output. The few-shot example also includes `_evidence` in the schema, adding further ambiguity. Additionally, highlights currently cover the entire snippet (a broad context passage), rather than the precise extracted value.

## What Changes

- Replace the separate `_evidence` block with **inline evidence**: every scalar leaf in the extraction result becomes `{"value": <extracted>, "snippet": <broader context>, "page": <1-based page>}` instead of a bare value.
- `wrap_template_with_evidence` is rewritten to transform each scalar field into `{"value": "type_string", "snippet": "string", "page": "number"}` at every level (top-level scalars and scalar subfields within array items).
- `split_evidence_result` is rewritten to recursively traverse the result, separate `value` from `{snippet, page}` at each leaf, and return a clean result (bare scalar values) alongside a mirrored evidence structure (only `{snippet, page}` at leaves).
- `_EVIDENCE_INSTRUCTION` is updated to describe the new per-field inline format.
- The few-shot example is rewritten with a schema using the new `{value, snippet, page}` shape and a result that demonstrates correctly filled inline evidence at every scalar.
- **Precise value highlighting**: the highlight layer uses the snippet to locate the region in the PDF, then highlights only the sub-range that matches the extracted `value`. Falls back to highlighting the full snippet if the value cannot be found within it.

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `nuextract-few-shot`: Schema in the few-shot example uses the inline `{value, snippet, page}` shape per scalar; result demonstrates correctly filled inline evidence at every scalar leaf, including within array items.
- `evidence-highlight-layer`: Highlights now cover the extracted value's text span rather than the full snippet span. The snippet is still used to locate the region; the value is searched within that region to determine the precise highlight bounds.

## Impact

- `prototypes/mine/backend/shared/evidence_template.py` — rewrite `wrap_template_with_evidence` and `split_evidence_result`
- `prototypes/mine/backend/shared/few_shot_examples.py` — rewrite `STRUCTURED_EXTRACTION_EXAMPLE`
- `prototypes/mine/backend/shared/nuextract_request.py` — update `_EVIDENCE_INSTRUCTION`
- `prototypes/mine/pdf-render/src/EvidenceHighlightLayer.tsx` — add `value` field to `Highlight` type; pass value through `collectLeaves`; add value-within-snippet search to `searchSnippetInPage`
- No API contract changes — `evidence` field in `ExtractDone` stays `Record<str, Any>`
