## ADDED Requirements

### Requirement: Exactly two Capability Routes determine all model operations

FREE SHALL define exactly one machine-wide Extraction Route and one machine-wide Interaction Route. Extraction and Schema Suggestion SHALL resolve the Extraction Route. Document chat and conversational Extraction Schema editing SHALL resolve the Interaction Route.

#### Scenario: Extraction and Schema Suggestion are routed

- **WHEN** FREE performs Extraction or Schema Suggestion
- **THEN** it resolves the Extraction Route exactly once for that operation
- **AND** it does not consult the Interaction Route

#### Scenario: Document chat and schema editing are routed

- **WHEN** FREE performs document chat or conversational Extraction Schema editing
- **THEN** it resolves the Interaction Route exactly once for that operation
- **AND** it does not consult the Extraction Route

### Requirement: Resolution uses one exact saved target without fallback

For each model operation, FREE SHALL read one validated immutable saved configuration snapshot, resolve the operation's named route, use only that route's Model Connection and model ID, and obtain only that connection's required credential. FREE MUST NOT select another route, connection, model, provider, profile, provider default, catalog entry, or configuration source as a substitute.

#### Scenario: The required route is absent

- **WHEN** an operation's required route is null, missing, dangling, or otherwise invalid in the saved snapshot
- **THEN** the operation fails with the stable HTTP error envelope and `error.code` `invalid_model_config`
- **AND** it does not try the other route or any default target

#### Scenario: The selected model was entered manually

- **WHEN** the selected model ID did not appear in an explicit probe result
- **THEN** FREE passes that exact selected ID to the selected provider
- **AND** it does not block execution or select a discovered replacement

#### Scenario: Environment settings are present

- **WHEN** `AI_PROVIDER`, `AI_MODEL`, `AI_CHAT_MODEL`, `AI_BASE_URL`, or `AI_API_KEY` is present while an operation is resolved
- **THEN** FREE does not read it as model configuration or credentials
- **AND** the saved route remains the sole target source

#### Scenario: A local and a remote route are both configured

- **WHEN** Extraction is configured for a local Ollama connection and Interaction for a remote OpenAI connection
- **THEN** Extraction sends work only to the configured Ollama target
- **AND** document chat and conversational Extraction Schema editing send work only to the configured OpenAI target

### Requirement: Execution profiles are explicit and constrained

The persisted Extraction Route SHALL use the optional `nuextractRaw?: true` flag
for raw NuExtract and omit that flag for the general path. The Interaction Route
cannot carry that flag. During resolution, FREE SHALL derive the internal
execution target profile as `general` or `nuextract-raw`; it SHALL not expose a
second persisted profile representation or coerce invalid combinations. The raw
flag is valid only when the selected connection is Ollama, and a flagged
Extraction Route on another provider fails with HTTP 409 and
`error.code` `invalid_model_config`.

#### Scenario: General execution is selected

- **WHEN** an Extraction or Interaction Route omits `nuextractRaw`
- **THEN** FREE resolves the internal `profile: 'general'` target
- **AND** it does not infer a different profile from the model ID

#### Scenario: Raw NuExtract is selected

- **WHEN** the Extraction Route sets `nuextractRaw: true` on an Ollama
  connection
- **THEN** FREE resolves the internal `profile: 'nuextract-raw'` target
- **AND** it uses the raw Ollama protocol with the exact saved model ID, server
  base, and optional resolved authorization

### Requirement: Interaction context uses canonical Source Document Markdown

Document chat SHALL include canonical Source Document Markdown with the conversation. Conversational Extraction Schema editing SHALL include canonical Source Document Markdown when its existing nullable source is present and SHALL continue with only the conversation and current Extraction Schema when that source is null. Neither Interaction operation SHALL send raw Docling output or choose a route based on input media.

#### Scenario: Document chat has a Source Document

- **WHEN** a researcher sends a document-chat message for a Source Document
- **THEN** FREE sends canonical Source Document Markdown as Interaction context
- **AND** it does not send raw Docling output

#### Scenario: Schema editing has a Source Document source

- **WHEN** conversational Extraction Schema editing receives a non-null Source Document source
- **THEN** FREE sends its canonical Source Document Markdown with the conversation and current Extraction Schema

#### Scenario: Schema editing has no Source Document source

- **WHEN** conversational Extraction Schema editing receives a null Source Document source
- **THEN** FREE proceeds with the conversation and current Extraction Schema only
- **AND** it neither creates a synthetic document placeholder nor rejects the request solely because the source is null

### Requirement: Explicit unsupported temperature fails before model invocation

When a model-operation request supplies an explicit temperature and the selected provider does not support temperature, FREE SHALL return HTTP 400 with `error.code` `unsupported_temperature`. This is a breaking change for Codex CLI and Claude Code. FREE MUST NOT silently omit the value, warn and continue, or use a fallback target. When temperature is absent, FREE SHALL retain the selected provider's existing default behavior.

#### Scenario: Codex CLI receives an explicit temperature

- **WHEN** a route selects Codex CLI and its model-operation request includes temperature
- **THEN** FREE returns HTTP 400 with `error.code` `unsupported_temperature`
- **AND** it does not invoke Codex CLI or any fallback target

#### Scenario: Claude Code receives an explicit temperature

- **WHEN** a route selects Claude Code and its model-operation request includes temperature
- **THEN** FREE returns HTTP 400 with `error.code` `unsupported_temperature`
- **AND** it does not invoke Claude Code or any fallback target

#### Scenario: A supported provider receives temperature

- **WHEN** a route selects Ollama, OpenAI, Anthropic, Google, or OpenAI-compatible and its request includes temperature
- **THEN** FREE passes the explicit temperature to the exact selected provider path
- **AND** it does not change routes or profiles

Transport envelopes, strict client-request parsing, and pre-stream versus
committed-stream error behavior are specified normatively by
`studio-model-operation-contract`. This capability owns only route-specific
causes and the no-fallback requirement above.
