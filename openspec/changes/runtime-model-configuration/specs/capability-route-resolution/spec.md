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

#### Scenario: The selected model is absent from its catalog

- **WHEN** the selected model ID is absent from the latest persisted catalog
- **THEN** FREE passes that exact selected ID to the selected provider
- **AND** it does not block execution based on the catalog or select a discovered replacement

#### Scenario: Environment settings are present

- **WHEN** `AI_PROVIDER`, `AI_MODEL`, `AI_CHAT_MODEL`, `AI_BASE_URL`, or `AI_API_KEY` is present while an operation is resolved
- **THEN** FREE does not read it as model configuration or credentials
- **AND** the saved route remains the sole target source

#### Scenario: Resolution begins during a configuration save

- **WHEN** a model operation begins while a PUT is between credential mutation and JSON commit
- **THEN** route resolution does not wait for the PUT and reads one validated saved configuration snapshot immediately
- **AND** any credential/configuration mismatch fails through the normal error contract without target substitution

#### Scenario: A local and a remote route are both configured

- **WHEN** Extraction is configured for a local Ollama connection and Interaction for a remote OpenAI connection
- **THEN** Extraction sends work only to the configured Ollama target
- **AND** document chat and conversational Extraction Schema editing send work only to the configured OpenAI target

### Requirement: Execution profiles are explicit and constrained

The Extraction Route SHALL allow profile `general` for supported providers and `nuextract-raw` only for Ollama. The Interaction Route SHALL allow only profile `general`. FREE SHALL reject any other connection/profile/route combination with HTTP 409 and `error.code` `invalid_model_config`; it MUST NOT coerce the profile.

#### Scenario: General profile is selected

- **WHEN** an Extraction or Interaction Route selects profile `general`
- **THEN** FREE executes the selected provider through its general model protocol
- **AND** it does not infer a different profile from the model ID

#### Scenario: Raw NuExtract profile is selected

- **WHEN** the Extraction Route selects an Ollama model with profile `nuextract-raw`
- **THEN** FREE uses the raw Ollama NuExtract protocol with the exact saved model ID, service root, and optional resolved authorization
- **AND** it does not route that request through the general model protocol

#### Scenario: Raw NuExtract is invalid for Interaction

- **WHEN** an Interaction Route selects `nuextract-raw`
- **THEN** FREE rejects the configuration with HTTP 409 and `error.code` `invalid_model_config`
- **AND** it does not rewrite the route to `general`

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

### Requirement: Model-operation request and error boundaries are stable

FREE SHALL parse client-supplied model-operation JSON strictly and SHALL reserve repair for generated model output. Buffered model operations and document-chat failures detected before stream creation SHALL return `{ "error": { "code": string, "message": string, "details"?: unknown } }`. Statuses SHALL be 400 for invalid requests or unsupported options, 409 for invalid saved model state, 502 for provider or generated-output failure, 503 for required keyring failure, and 500 for unexpected failure. The envelope and its details MUST NOT add FREE-managed credentials, request headers, full request bodies, stack traces, or arbitrary thrown objects; immediate provider response detail MAY be raw but SHALL obey the bounded design contract.

#### Scenario: Client JSON is malformed

- **WHEN** a buffered model operation or pre-stream document-chat request contains malformed or schema-invalid client JSON
- **THEN** FREE returns HTTP 400 with `error.code` `invalid_request`
- **AND** it does not repair the supplied JSON or invoke a model

#### Scenario: Required credential cannot be resolved

- **WHEN** the exact selected route requires a FREE-managed credential and its keyring entry is unavailable or cannot be read
- **THEN** the operation returns HTTP 503 with `error.code` `keyring_unavailable`
- **AND** it does not try a credentialless, external, environment, or alternate connection

#### Scenario: Buffered operation has a provider failure

- **WHEN** Extraction, Schema Suggestion, or conversational Extraction Schema editing reaches its selected provider and the provider or generated output fails
- **THEN** FREE returns HTTP 502 with a stable error envelope
- **AND** any immediate upstream detail is the bounded raw provider detail allowed by the design, while the envelope does not add FREE-managed credentials, request headers, full request bodies, stack traces, or arbitrary thrown objects

### Requirement: Document chat preserves the committed stream error protocol

Before document-chat stream headers are committed, failures SHALL use the stable HTTP error envelope. After headers are committed, FREE SHALL emit the standard AI SDK UI-message error part `{ "type": "error", "errorText": string }` with sanitized bounded text. FREE MUST NOT encode the JSON error envelope in the stream or alter the already committed HTTP status; the frontend SHALL treat the error part as a failed operation.

#### Scenario: Document chat fails before streaming starts

- **WHEN** document-chat request parsing, route resolution, temperature validation, or required credential lookup fails before stream creation
- **THEN** FREE returns the corresponding non-200 HTTP status and stable JSON error envelope
- **AND** it does not open a UI-message stream

#### Scenario: Document chat fails after streaming starts

- **WHEN** the selected provider or generation fails after document-chat stream headers are committed
- **THEN** FREE emits an AI SDK UI-message error part with sanitized `errorText`
- **AND** the committed HTTP status remains unchanged and the event omits upstream bodies, credentials, causes, stack traces, and error details

#### Scenario: The frontend receives an in-stream error

- **WHEN** the document-chat frontend receives an AI SDK UI-message error part
- **THEN** it terminates stream consumption on that error, including through `readUIMessageStream` with `terminateOnError: true` or equivalent behavior
- **AND** it reports a failed operation rather than a completed assistant message
