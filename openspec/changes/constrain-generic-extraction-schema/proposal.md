## Why

For general-profile models (e.g. Claude/Anthropic, and any other non-NuExtract chat model), `extractWithModel` constrains the Extraction Result's field set with a plain-text instruction only (`EXTRACTION_SCOPE_GUARDRAIL`). Models occasionally violate it — observed case: Claude echoed the schema's own `_description` guidance text back as an extra `description` key. `restoreSchemaNodeOrder` then throws `Unexpected model key: description`, which for the CATALOG strategy fails that record silently; when every record fails this way the Extraction succeeds with `records: []`, and downstream grounding finds nothing to ground, surfacing as "No reviewable result" with no indication of the real cause. A schema-enforced generation contract removes this failure mode at its source instead of hoping every provider always follows a text instruction.

## What Changes

- `extractWithModel`'s general-profile branch derives a JSON Schema (exact key set, matching `SchemaNode[]` shape) from the Extraction Schema and passes it into the model call as a real structured-output constraint (e.g. Vercel AI SDK `Output.object({ schema })` or provider tool-calling), for targets whose route advertises structured-output support.
- Targets without structured-output support keep today's text-instruction-only path unchanged (`EXTRACTION_SCOPE_GUARDRAIL` stays as a fallback/belt-and-braces instruction in both cases).
- `restoreSchemaNodeOrder`'s "Unexpected model key" failure becomes unreachable for structured-output targets on this path; it remains as defence-in-depth and still applies to any target still on the text-instruction fallback (including NuExtract's raw-prompt path, unchanged).

## Capabilities

### New Capabilities
- `general-profile-structured-extraction`: When a general-profile execution target supports schema-constrained/tool-calling generation, `extractWithModel` builds a JSON Schema from the Extraction Schema and requests output constrained to it, rather than relying solely on a text instruction.

### Modified Capabilities

(none — no existing spec currently governs Studio's TypeScript extraction call shaping; `model-call-composition`, `model-provider-adapters`, and `model-command-compilation` describe the Python parsing_service pipeline, and `studio-model-operation-contract` governs the HTTP response contract, not the outbound model request shape.)

## Impact

- `prototypes/studio/api/_model.ts`: `extractWithModel`, `generateWithGenericJsonPrompt`, and whatever capability-route metadata is needed to know a target supports structured output.
- `prototypes/studio/api/_provider.ts` (or wherever `ExecutionTarget`/`GeneralExecutionTarget` is defined): may need a flag indicating structured-output/tool-calling support per route, if one doesn't already exist alongside `jsonOutput`.
- `packages/extraction/src/schema.ts`: reuse/extend `SchemaNode[]` → template mapping (e.g. `nodesToTemplate`) to also produce a JSON Schema shape, if no such conversion exists yet.
- No change to the NuExtract raw-prompt path (`generateWithNuExtractRawPrompt`) or to `generateSchemaWithModel` (schema suggestion is intentionally open-ended and out of scope).
