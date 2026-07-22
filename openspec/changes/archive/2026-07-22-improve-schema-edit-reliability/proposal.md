## Why

Schema chat-edit instructions that apply broadly across the schema (e.g. "translate all field names to Danish") silently drop some fields. The current `editSchemaWithModel` prompt asks the model to enumerate one `patch`/`remove`/`add` operation per affected field from a single free-form pass over the whole schema; the model has no structural obligation to cover every field, and weaker/quantized chat models reliably miss items — especially nested ones — as the field count grows. Researchers only discover the gap after applying the diff and noticing some fields were left untouched, undermining trust in the feature for exactly the case (repetitive schema-wide edits) it should save the most time on.

## What Changes

- Replace the free-form "list of ops for whatever fields you decide to touch" prompt with one structured `generateText` call **per existing field**, each requesting a small fixed result (`{ name, type, removed }`) via a Zod-validated `Output.object()` schema. Completeness is now guaranteed by the calling code iterating every field (`fields.map(...)`), not by trusting a single model response to enumerate everything correctly. New-field `add` operations remain a separate, unconstrained list since they can't be enumerated in advance.
- Run the per-field calls concurrently (capped concurrency) so total latency stays close to one call's latency rather than growing linearly with field count; retry an individual field's call (not a whole batch) a couple of times before surfacing an error for just that field.
- Keep `editSchemaWithModel`'s external contract (`Promise<EditSchemaOp[]>`) unchanged: the per-field results are converted back into the existing `EditSchemaOp[]` shape internally, so `schemaOps.ts` (`applyOps`) and the SchemaPanel pending-diff/Apply/Discard flow require no changes.

## Capabilities

### New Capabilities
(none)

### Modified Capabilities
- `schema-chat-edit`: the op-list generation step gains a completeness guarantee for schema-wide instructions (every existing field is guaranteed its own model call, by code construction, not by trusting a single response to enumerate everything) and moves from one enumeration call to one concurrent call per field. The op list contract consumed by the frontend (`SchemaNode[]` application, pending-diff card) is unchanged.

## Impact

- `prototypes/studio/api/_model.ts`: rewrite of `editSchemaWithModel` (per-field structured calls, concurrency-capped orchestration, conversion back to `EditSchemaOp[]`).
- No changes expected to `prototypes/studio/src/schemaOps.ts`, `prototypes/studio/src/SchemaPanel.tsx`, or `prototypes/studio/src/api.ts` (`requestSchemaEdit` request/response shape is preserved).
- Latency: total wall-clock for a chat edit becomes roughly (field count / concurrency cap) call-latencies rather than one call's latency, but issues one concurrent request per field to whichever model provider is configured (Ollama, Codex CLI app-server, or Claude Code CLI) instead of a single call — more total requests, though bounded by a concurrency cap.
