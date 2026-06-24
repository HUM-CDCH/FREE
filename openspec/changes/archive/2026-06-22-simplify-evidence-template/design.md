## Context

The current evidence mechanism wraps the extraction template with a top-level `_evidence` block that mirrors the full schema structure. The model must output two parallel structures — values in their normal positions, evidence in a separate `_evidence` block. For array-of-objects fields, the model must produce per-item evidence entries that mirror the array item schema exactly. This parallel structure is error-prone and produces inconsistent model output.

The highlight layer currently highlights the full snippet span — a broad context passage. The extracted value sits somewhere within that span, but the user sees a large highlighted region rather than the precise text.

## Goals / Non-Goals

**Goals:**

- Make evidence inline: every scalar leaf in the result is `{"value": extracted, "snippet": context, "page": N}` rather than a bare scalar with a parallel `_evidence` counterpart.
- Eliminate the top-level `_evidence` block entirely from both schema and result.
- Highlight only the extracted value's span in the PDF (not the full snippet span); use the snippet only for reliable location.
- Keep the `ExtractDone` response type unchanged — `evidence` stays `Record<str, Any> | None`.

**Non-Goals:**

- Changing how highlight colors are assigned (still per top-level key).
- Changing the `/extract` or `/generate-template` API surface.

## Decisions

### Decision: Every scalar becomes `{value, snippet, page}`

**Choice:** `wrap_template_with_evidence` replaces every scalar value in the template with `{"value": <original_type_hint>, "snippet": "string", "page": "number"}`. This applies recursively: top-level scalars and scalar subfields within array-item schemas.

**Rationale:** The model fills in value and evidence in the same place at the same time. No parallel structure to maintain, no risk of field count mismatch between the value block and the evidence block.

**Alternatives considered:**

- Keep `_evidence` as a top-level block but simplify to one entry per top-level field → still requires the model to know which top-level key to put each field under; no improvement for nested arrays.
- Add `{field}_snippet` / `{field}_page` sibling keys → pollutes field names; harder to parse generically.

### Decision: `split_evidence_result` becomes a recursive splitter

**Choice:** Replace the current top-level `_evidence` key extraction with a recursive traversal:
- At a `{value, snippet, page}` leaf → split into `value` (for clean result) and `{snippet, page}` (for evidence).
- At a dict → recurse into each key; collect non-None evidence into a parallel dict.
- At a list → recurse into each item; collect evidence into a parallel list.
- Fallback: if a node is not a `{value, snippet, page}` object (model didn't follow format), keep it as-is in the result and emit no evidence for it.

**Rationale:** Handles any nesting depth uniformly. Gracefully degrades when the model outputs bare values instead of `{value, snippet, page}`.

### Decision: `_EVIDENCE_INSTRUCTION` updated to describe inline format

The instruction text in `nuextract_request.py` is rewritten to tell the model to return `{"value": ..., "snippet": ..., "page": ...}` for each field rather than "fill the `_evidence` block".

### Decision: Few-shot example uses the new inline format

`STRUCTURED_EXTRACTION_EXAMPLE.schema_json` shows the `{value, snippet, page}` shape for each scalar field (including within array items). `result_json` shows a correctly filled example with broader-context snippets at every leaf.

### Decision: Highlight the value sub-range, not the full snippet

**Choice:** In `searchSnippetInPage`, after locating the snippet's character range `[idx, idx+len]` in the joined text, search for the `value` string within that range. If found, return rects only for text items overlapping `[valueStart, valueStart+valueLen]`. If not found, fall back to the full snippet range.

```
fullText: "... ceramic sherds recovered from layer 3, consistent with wheel-thrown production ..."
snippet match: [120, 195]  ← full range located via snippet search
value "ceramic":  [124, 131] ← restricted range used for highlight rects
```

**Rationale:** Snippets provide robust location (OCR-tolerant, unique in context); values provide precise highlight bounds. Separating the two concerns gives both accuracy and resilience.

**Fallback:** Value not found within snippet → fall back to full snippet. No error; the highlight is slightly wider but still correct. Evidence leaf with no `value` field → fall back to full snippet unchanged.

## Risks / Trade-offs

- **Richer evidence granularity**: individual array items now each carry their own evidence — strictly better than before for highlight accuracy.
- **Model output volume**: each scalar now outputs three fields instead of one. NuExtract handles structured templates well, so this is unlikely to degrade accuracy.
- **Graceful fallback**: if the model outputs a bare string instead of `{value, snippet, page}`, `split_evidence_result` keeps the bare value and emits no evidence for that field — highlights just won't appear for that field.
- **Breaking**: old cached results with the `_evidence`-block format are not re-processed — no migration needed since there is no persistence layer.
