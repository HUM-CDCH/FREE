## Context

`extractWithModel` in `api/_model.ts` wraps the caller-supplied template with `wrapTemplateWithEvidence`, which adds `{value, snippet: "string", page: "number"}` envelopes around every scalar leaf. The model sees the type hints (`"string"`, `"number"`) but has no explicit instruction to actually populate those fields — so it writes `null` for both `snippet` and `page` throughout.

`splitEvidenceResult` (in `api/_evidence_template.ts`) discards any evidence leaf where `snippet` is empty or `page ≤ 0`, producing `evidence: null` for the whole extraction. With `evidence: null`, `EvidenceHighlightLayer` falls back to the bare value-search path and the snippet-anchored path is never used.

## Goals / Non-Goals

**Goals:**
- Model consistently fills `snippet` with a verbatim excerpt and `page` with the 1-based image/page index for every evidence-wrapped field.
- Caller-supplied `instruction` still works and is appended after the system evidence instruction.
- No changes to API surface, schema, or callers.

**Non-Goals:**
- Fixing cases where the value genuinely does not appear in the document — the instruction can't conjure evidence that isn't there.
- Modifying `splitEvidenceResult` validation thresholds.
- Handling the Python backend (only the main-branch TypeScript API is in scope).

## Decisions

**Compose the evidence instruction inside `extractWithModel`, not at the call site.**

The evidence instruction is an implementation detail of evidence-wrapped extraction. Injecting it at `extractWithModel` keeps all callers clean and guarantees the instruction is always present when evidence wrapping is active. The composed instruction is `[EVIDENCE_INSTRUCTION, caller_instruction].filter(Boolean).join('\n')`.

Alternatives considered:
- Add a constant to `_evidence_template.ts` and import it — equivalent but adds coupling; keeping it colocated in `_model.ts` is simpler.
- Require callers to pass the instruction — error-prone; callers must not forget it.

**Instruction wording: require snippet ≠ null and page > 0.**

The instruction must be direct and minimal. NuExtract follows explicit constraints well; type hints alone are insufficient. The wording: "For every evidence field, set `snippet` to a short verbatim excerpt from the document containing the value, and set `page` to the 1-based index of the page/image where the value appears."

## Risks / Trade-offs

- [Longer prompt] → Marginal increase in token cost; negligible at typical document sizes.
- [Model ignores instruction] → Fallback in `EvidenceHighlightLayer` already handles `snippet: null`; existing behaviour preserved. No regression.
- [Instruction conflicts with caller instruction] → Resolved by placing the evidence instruction first; caller instructions refine, not override.
