# capability-route-resolution Specification

## Purpose
Maps every Studio model operation to its Project Context owner's route, with the deployment's defaults for unset routes.

## Requirements

### Requirement: Two Capability Routes per Researcher Account
Schema Suggestion SHALL resolve the Schema Suggestion Route; conversational Extraction Schema editing (edit proposals) SHALL resolve the Interaction Route. Extraction runs in the Parsing Service on the Extraction Model Choice and resolves no Capability Route. Every operation, background work included, SHALL resolve the Project Context owner's configuration when it starts.

#### Scenario: Schema Suggestion is routed
- **WHEN** a researcher starts Schema Suggestion in a Project Context
- **THEN** it resolves that Project Context owner's Schema Suggestion Route
- **AND** it does not consult another account's route

#### Scenario: Schema editing is routed
- **WHEN** a researcher requests a conversational Extraction Schema edit proposal
- **THEN** it resolves that Project Context owner's Interaction Route
- **AND** Extraction continues to use the Parsing Service's Extraction Model Choice

#### Scenario: Another account's routes are never consulted
- **WHEN** two accounts set different routes and start work in their own Project Contexts
- **THEN** each operation uses only the configuration of its Project Context owner

### Requirement: Resolution uses one exact target, with named defaults
An unset Interaction Route SHALL resolve to the deployment's instruction model when the deployment serves one; an unset Schema Suggestion Route SHALL resolve `schemaSuggestion ?? interaction ?? default`. Nothing else substitutes. An explicitly selected model ID SHALL remain selected even when absent from an advisory discovery result. FREE MUST NOT import or fall back to `AI_*` settings.

#### Scenario: An unset Schema Suggestion Route follows the Interaction Route
- **WHEN** the Schema Suggestion Route is unset and the Interaction Route names a model
- **THEN** Schema Suggestion calls that exact model

#### Scenario: With no route and no deployment default the operation fails with `invalid_model_config`
- **WHEN** the needed route is unset and the deployment has no instruction-model default
- **THEN** the operation fails with `invalid_model_config` without invoking a provider

#### Scenario: The selected model was entered manually
- **WHEN** a route names a model ID absent from the latest discovery result
- **THEN** FREE passes that exact ID to the selected provider
- **AND** it does not choose a discovered replacement

#### Scenario: Environment settings are present
- **WHEN** `AI_PROVIDER`, `AI_MODEL`, `AI_CHAT_MODEL`, `AI_BASE_URL`, or `AI_API_KEY` is present
- **THEN** FREE does not read it as model configuration or a credential for the operation

### Requirement: The NuExtract protocol is derived
Schema Suggestion SHALL use the NuExtract protocol exactly when the route's connection is vLLM and its model ID names NuExtract (`/nuextract/i`); no route stores or selects a protocol, and no other route uses it.

#### Scenario: All four combinations of vLLM or not and NuExtract model or not
- **WHEN** Schema Suggestion resolves each combination of a vLLM or other connection and a NuExtract or other model ID
- **THEN** only the vLLM plus NuExtract combination uses the NuExtract protocol
- **AND** every other combination uses its general provider protocol

### Requirement: Interaction context uses canonical Source Document Markdown
Conversational Extraction Schema editing SHALL include canonical Source Document Markdown when its existing nullable source is present and SHALL continue with only the conversation and current Extraction Schema when that source is null. It SHALL NOT send raw Docling output or choose a route based on input media.

#### Scenario: Schema editing has a Source Document source
- **WHEN** conversational Extraction Schema editing receives a non-null Source Document source
- **THEN** FREE sends its canonical Markdown with the conversation and current Extraction Schema
- **AND** it does not send raw Docling output

#### Scenario: Schema editing has no Source Document source
- **WHEN** conversational Extraction Schema editing receives a null Source Document source
- **THEN** FREE proceeds with only the conversation and current Extraction Schema
- **AND** it neither creates a synthetic placeholder nor rejects the request solely for the missing source

### Requirement: Explicit unsupported temperature fails before model invocation
When a model-operation request supplies an explicit temperature and the selected provider does not support temperature, FREE SHALL return HTTP 400 with `error.code` `unsupported_temperature`. FREE MUST NOT silently omit the value or use a fallback target. When temperature is absent, FREE SHALL retain the selected provider's default behavior.

#### Scenario: Codex CLI receives an explicit temperature
- **WHEN** a route selects Codex CLI and its request includes temperature
- **THEN** FREE returns `unsupported_temperature` before invoking Codex CLI

#### Scenario: Claude Code receives an explicit temperature
- **WHEN** a route selects Claude Code and its request includes temperature
- **THEN** FREE returns `unsupported_temperature` before invoking Claude Code

#### Scenario: A supported provider receives temperature
- **WHEN** a route selects a provider that supports temperature and its request includes one
- **THEN** FREE passes that exact value to the selected provider

### Requirement: A recovered operation resolves again and records no attribution
A workflow SHALL carry only IDs; each attempt resolves the owner's current route and key. Interactive results (generations and edit proposals) record no Model Attribution.

#### Scenario: A route changed between two attempts runs the second attempt on the new route
- **WHEN** a workflow restarts after its owner changes the route
- **THEN** its new attempt resolves the changed route and key
- **AND** the result records no attribution reconstructed from a later route

Transport envelopes, strict client-request parsing, and pre-stream versus committed-stream error behavior are specified by `studio-model-operation-contract`.
