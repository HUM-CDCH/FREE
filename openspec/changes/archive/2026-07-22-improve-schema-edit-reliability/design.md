## Context

`editSchemaWithModel` (`prototypes/studio/api/_model.ts`) backs the schema chat-edit feature (`schema-chat-edit` capability). Today it makes one `generateText` call with a free-form prompt: dump the whole schema as nested JSON, list the instruction, and ask the model to return a JSON array of `{op, name, type, parentName}` operations for whatever fields it decides need changing. A prior iteration added a flattened field-path checklist to the prompt to reduce omissions, but this is still advisory text, not an enforced contract — the model can silently return an incomplete list.

This shows up concretely as: "translate all field names to Danish" only renames some fields, especially nested ones, more often on the smaller/quantized chat models this project runs locally.

The app resolves its chat model (`chatModel()` in the same file) to one of three backends depending on `AI_PROVIDER`: a local Ollama model, OpenAI's Codex CLI (via a reused `codexProvider()` app-server process), or Claude Code CLI (`ai-sdk-provider-claude-code`, one CLI subprocess per call). All three go through the standard AI SDK `generateText`/`Output` surface for chat/schema-edit (never the raw NuExtract prompt path, which is extraction/schema-generation only).

## Goals / Non-Goals

**Goals:**
- Guarantee that every field currently in the schema is accounted for in the model's response when an instruction could plausibly affect it — enforced structurally, not just requested in prose.
- Improve per-field transformation accuracy (not just presence) by giving the model fewer fields to reason about per call.
- Preserve `editSchemaWithModel`'s external contract (`Promise<EditSchemaOp[]>`) exactly, so `schemaOps.ts`, `SchemaPanel.tsx`'s diff/Apply/Discard flow, and the `/api/edit_schema` request/response shape in `api.ts` need no changes.

**Non-Goals:**
- Guaranteeing coverage of *new* fields the researcher's instruction implies but that don't exist yet (`add` ops) — these can't be enumerated against a fixed schema and stay a free-form (smaller, single-purpose) list.
- Adding a model-driven self-check pass that re-asks the model whether its own output is correct — completeness is now guaranteed by code (see Decision 2), so this class of fix isn't needed for coverage; it could still help *accuracy* of individual answers, but is deferred.
- Changing the NuExtract raw-prompt path (`generateWithNuExtractRawPrompt`) — schema chat-edit never uses it.
- Any change to the pending-diff UI or `SchemaNode`/`SchemaOp` application logic.

## Decisions

### 1. Structured, single-field-required output per call instead of a free-form op list

Each existing field gets its own `generateText` call with `output: Output.object({ schema })`, where `schema` is a small fixed Zod object `{ name: string, type: string, removed: boolean }` scoped to that one field (fields the model wants to leave alone simply echo their existing `name`/`type` with `removed: false`).

*Why*: a required key is a structural fact the response either has or doesn't — Zod validation rejects a response missing a field outright. Scoping this to *one field per call* (see Decision 2) also means the schema itself never has to vary in shape or size.

*Alternatives considered*:
- Keep free-form ops, add a post-hoc completeness check comparing returned field names against the full list and erroring/retrying. Rejected — still starts from an unconstrained response shape, so the model can produce a well-formed but incomplete list that passes basic JSON parsing before the completeness check catches it.
- Ask for `add`-style completeness too by pre-declaring "slots" for hypothetical new fields. Rejected — there's no bounded set of possible new fields to declare slots for.

### 2. Completeness comes from the calling code's iteration, not from the model's response shape (superseded an earlier per-batch design)

An earlier version of this change grouped fields into small batches (a handful per call) and required one JSON key per field *within that batch's response*. In manual testing this still produced incomplete results on larger schemas — the batch's required-keys schema is still something the model has to get right *for that whole batch in one turn*, and provider-dependent structured-output enforcement isn't reliably airtight in practice, especially on weaker/local models. A batch that silently drops a key doesn't necessarily fail Zod validation if the model still emits a well-formed (but incomplete) object shape the runtime accepts.

The fix: issue **one `generateText` call per individual field** (`editOneField`), and drive the full field list with `fields.map(field => () => editOneField(field, instruction))` under a concurrency cap (`runWithConcurrencyLimit`, `MAX_CONCURRENT_FIELD_CALLS = 6`). Completeness is now a property of `Array.prototype.map` over a known-length array, not of any model's output shape — every field unconditionally gets its own call, and `Promise.all`/the concurrency runner either produces a result for every one of them or a specific call throws (caught and retried up to `FIELD_EDIT_ATTEMPTS = 2` times for that field alone, never a whole batch).

*Why this is stronger*: the previous design's guarantee ultimately still depended on trusting the model to honor a schema. This design's guarantee depends on nothing more than the JS runtime executing every element of `fields.map(...)` — which it always does. Per-field calls are also simpler for the model (one field, one decision) than juggling several apath at once, which manual testing showed produced more consistent answers.

*Alternatives considered*:
- Small batches with a code-level "which keys are present" check and targeted re-query of just the missing ones. A reasonable middle ground (batches for speed, per-field retry only for stragglers) but more code paths for comparable latency to straight per-field calls at FREE's expected (compact) schema sizes; not pursued for this iteration.
- One call per field, sequential. Rejected — linear multiple of single-call latency for no benefit, since each field is independent.

### 3. Convert back to `EditSchemaOp[]` in code, contract unchanged

After collecting one result per field (plus the separate free-form `additions` list for new fields), diff each field's returned `name`/`type`/`removed` against its original value and emit the existing `patch`/`remove`/`add` op shapes. Downstream code (`schemaOps.ts`, `SchemaPanel.tsx`, `/api/edit_schema`'s request/response shape) is untouched.

## Risks / Trade-offs

- **[Risk]** N model calls (one per field) instead of one — for the Claude Code CLI provider in particular, each call spawns a subprocess, so this is real concurrent process pressure, not just cheap HTTP round-trips. → **Mitigation**: `MAX_CONCURRENT_FIELD_CALLS` caps in-flight calls rather than firing all of them at once; tune the constant if a given provider struggles under it.
- **[Risk]** Structured-output enforcement quality is still provider-dependent for any *individual* call. → **Mitigation**: `fieldEditResultSchema.safeParse` after every call, with up to `FIELD_EDIT_ATTEMPTS` retries before that one field's call throws — failure is scoped to a single field, never a whole batch or the whole edit.
- **[Risk]** A field loses batch-level sibling context a model might have used to disambiguate similarly-named fields. → **Mitigation**: each call's prompt includes the field's full dotted path (parent chain included), the same disambiguation signal `parentName` gives today; manual testing across 12–16 field schemas showed no cross-field confusion.
- **[Risk]** More total model calls per edit than the schema-wide or batched approaches. → **Mitigation**: accepted trade-off — correctness (every field is guaranteed a call) matters more than raw call count for a feature whose entire value proposition is "handle repetitive schema-wide edits correctly."

## Migration Plan

Pure implementation change behind a feature branch / PR; no data or API contract migration. Validated manually via direct `POST /api/edit_schema` calls against the running dev server (see tasks.md 5.2/5.3) with 12–16 field nested/flat templates and both broad and narrow instructions; all fields were covered with correct Danish translations, and narrow instructions produced minimal diffs. Not yet validated against the `ollama`/`codex-cli` providers (only `claude-code` was reachable in the verification environment) or through the SchemaPanel UI directly.

## Open Questions

- Whether `MAX_CONCURRENT_FIELD_CALLS = 6` is the right default for the Claude Code CLI provider's subprocess overhead at larger field counts (20+) — not load-tested beyond ~16 fields.
- Whether per-field accuracy (as opposed to completeness, which is now solved) still needs a verification/self-check pass for any provider — no evidence of this yet in manual testing, revisit if reported.
