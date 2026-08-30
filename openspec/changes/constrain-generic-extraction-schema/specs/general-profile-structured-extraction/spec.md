## ADDED Requirements

### Requirement: General-profile extraction constrains generation to the Extraction Schema's key set
When `extractWithModel` resolves a `general`-profile execution target (any provider other than the NuExtract raw path) and can derive a schema from the Extraction Result template it was given, it SHALL request generation constrained to that schema (exact field names, nesting, and array shape) instead of relying solely on a text instruction. The model's output MUST NOT be accepted with a field absent from the Extraction Schema going unnoticed until `restoreSchemaNodeOrder` throws deep in the extraction pipeline.

#### Scenario: Model output omits an unrecognized key rather than crashing the extraction
- **WHEN** a general-profile model (e.g. Claude via Anthropic or Claude Code) would otherwise have echoed a schema-external field (such as `description`) into its Extraction Result output
- **THEN** the generation request constrains the model to the Extraction Schema's declared field set
- **AND** an extraction whose only obstacle was that hallucinated field no longer fails with `Unexpected model key: <name>`

#### Scenario: Fields legitimately absent from the source remain omissible
- **WHEN** the schema-constrained generation request is built for a record where some schema fields have no supporting value in the Source Document
- **THEN** the constrained schema still allows those fields to be omitted or null
- **AND** the model is not forced to fabricate a value merely to satisfy the constrained shape

### Requirement: Schema derivation and constrained generation degrade to today's behavior on failure
The general-profile branch SHALL NOT let a failure to derive a schema, or a provider's inability to honor `Output.object()`, prevent extraction from proceeding. Both failure modes MUST fall back to the existing text-instruction-only generation path so extraction that worked before this change keeps working.

#### Scenario: Schema derivation fails for an unrecognized template shape
- **WHEN** the Extraction Result template `extractWithModel` receives cannot be converted into a schema
- **THEN** `extractWithModel` falls back to today's `generateWithGenericJsonPrompt` behavior for that call, unconstrained by a derived schema
- **AND** the call does not throw or abort the Extraction solely because derivation failed

#### Scenario: A general-profile provider cannot produce schema-constrained output
- **WHEN** a general-profile provider's `Output.object()` call fails to produce a parseable result for a model that lacks adequate structured-output or tool-calling support
- **THEN** the failure is caught the same way today's `NoObjectGeneratedError` fallback is caught for native JSON output
- **AND** the raw model text is used to continue the extraction exactly as it would be without schema constraints

### Requirement: The NuExtract raw-prompt path is unaffected
Schema-constrained generation SHALL NOT be applied to the NuExtract raw-prompt execution path (`generateWithNuExtractRawPrompt`). NuExtract's resistance to schema-external keys already comes from its template-following training, and its raw-prompt protocol (control tokens, `<think>` blocks) is not validated against a decoding-time grammar constraint.

#### Scenario: NuExtract raw extraction calls remain untouched
- **WHEN** an Extraction resolves to the NuExtract raw-prompt execution path
- **THEN** the request sent to Ollama's `/api/generate` is unchanged by this capability
- **AND** no schema-derived `format`/`responseFormat` constraint is added to that request
