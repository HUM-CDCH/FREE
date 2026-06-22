# Design: nuextract-few-shot-examples

## Context

NuExtract3 is a template-filling model. It receives a JSON schema and fills in values from the source document. For structured extraction with evidence, the backend wraps the researcher's schema with a `_evidence` block before sending it to the model.

The model currently receives only natural-language instructions describing how to fill `_evidence`. In practice it often misinterprets the nested array structure — using extracted field values (e.g. `"distribution"`) as `_evidence` keys instead of preserving the array shape defined in the template. This breaks the highlight pipeline because the frontend's `buildHighlights` function cannot locate any `{snippet, page}` leaves.

Few-shot examples sidestep this by showing the model a concrete (schema → filled result) pair. The model can pattern-match the structure it should produce rather than infer it from a description.

## Goals / Non-Goals

**Goals:**

- Embed one (schema, result) few-shot example in every structured extraction request to demonstrate that `_evidence` snippets should be broader source passages, not copies of extracted values.
- Use a single mixed example (scalar field + array field) — no per-request selection logic needed.
- Support both control channels (`message_text` and `template_kwargs`) without duplicating examples across channels.
- Keep examples as pure data (no runtime logic to generate them).

**Non-Goals:**

- Generating examples dynamically from the actual document or schema.
- Multiple few-shot examples per request (one is sufficient; more increases prompt length without clear benefit).
- Changing the `_evidence` template format or the `split_evidence_result` parsing logic.
- Frontend changes.

## Decisions

### Decision 1: Store the example as static data, not generated at runtime

**Choice:** A new `few_shot_examples.py` module exports a single `FewShotExample` dataclass instance (a module-level constant) holding `schema_json` and `result_json` strings.

**Rationale:** The example only needs to change when the evidence template format changes (rare). Generating it dynamically would require a second model call or complex template introspection. A module-level constant is easy to review and test.

**Alternatives considered:**

- Load from a JSON file on disk: adds indirection with no benefit at this scale.
- Generate from the actual schema at request time: complex, and the structural pattern — not the field names — is what the model needs to learn.

---

### Decision 2: One mixed example, always embedded — no selection logic

**Choice:** A single static example with one scalar field and one array-of-objects field is unconditionally embedded in every structured extraction request.

**Rationale:** The frontend now collects `{snippet, page}` leaves recursively from `_evidence` regardless of nesting structure, so the example no longer needs to enforce specific key names or array alignment. The only thing the model needs to learn from the example is: snippets should be broader source passages (with surrounding context), not copies of extracted values. A single mixed example is sufficient to demonstrate this.

---

### Decision 3: Render the example as a text block in message content (both channels)

**Choice:** The few-shot example is always added to `content` as a text block, regardless of the control channel. It is prepended before the source document content, formatted as:

```text
Example of a correctly filled extraction:

Schema:
<schema_json>

Correct output:
<result_json>
```

**Rationale:**

- Message content is always seen by the model regardless of channel.
- `template_kwargs` has no standard parameter for few-shot examples in llama.cpp / GGUF deployments.
- Keeping examples in content avoids coupling to provider-specific kwarg schemas.

**Alternatives considered:**

- Add as a new `template_kwargs` key (e.g. `examples`): no evidence this is supported by the GGUF runtime.
- Append after the template: placing it before gives the model the correct pattern before it sees the actual schema.

---

### Decision 4: `FewShotExample` is a plain dataclass; the builder accepts it as an optional parameter

**Choice:** `few_shot_examples.py` exports a `FewShotExample` dataclass and a single module-level constant `STRUCTURED_EXTRACTION_EXAMPLE`. `NuExtractRequestBuilder.structured_extraction` accepts an optional `few_shot: FewShotExample | None` parameter. `ExtractPipeline.run` passes the constant directly — no selection function needed.

**Rationale:** With one unconditional example, there is nothing to select. The builder renders; the pipeline decides what to pass. Keeping the constant importable makes it easy to swap or extend later.

## Risks / Trade-offs

- **Longer prompts** → slightly higher latency and token cost. Acceptable: a single example adds ~300–500 tokens.
- **Example mismatch** → if the static example becomes stale relative to the `_evidence` format, it could confuse the model. Mitigation: the example is unit-tested and co-located with `evidence_template.py` conventions.
- **Model ignores the example** → few-shot examples do not guarantee compliance for all schemas. Mitigation: best-effort improvement; the highlight pipeline already has progressive fallback logic for OCR mismatches.

## Migration Plan

1. Add `few_shot_examples.py` with `FewShotExample` dataclass and `STRUCTURED_EXTRACTION_EXAMPLE` constant (mixed scalar + array schema with correct `_evidence`).
2. Update `NuExtractRequestBuilder.structured_extraction` to accept optional `few_shot` and prepend the rendered block to content.
3. Update `ExtractPipeline.run` to import and pass `STRUCTURED_EXTRACTION_EXAMPLE`.
4. Add unit tests for prompt rendering (with and without few-shot).
5. No API changes; no frontend changes; no migration needed.

## Open Questions

- Should `schema_suggestion` (template generation) also receive a few-shot example showing correct schema output format? Out of scope for this change but worth considering if schema generation also produces structural issues.
