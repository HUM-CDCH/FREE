## MODIFIED Requirements

### Requirement: Resolution uses one exact target, with named defaults
An unset Interaction Route SHALL resolve to the Model Gateway's default model on the *Deployment model cache* connection when the deployment has a gateway with a default model; an unset Schema Suggestion Route SHALL resolve `schemaSuggestion ?? interaction ?? default`. Nothing else substitutes. An explicitly selected model ID SHALL remain selected even when absent from an advisory discovery result. FREE MUST NOT import or fall back to `AI_*` settings.

#### Scenario: An unset Schema Suggestion Route follows the Interaction Route
- **WHEN** the Schema Suggestion Route is unset and the Interaction Route names a model
- **THEN** Schema Suggestion calls that exact model

#### Scenario: With no route and no deployment default the operation fails with `invalid_model_config`
- **WHEN** the needed route is unset and the deployment has no gateway default model
- **THEN** the operation fails with `invalid_model_config` without invoking a provider

#### Scenario: The selected model was entered manually
- **WHEN** a route names a model ID absent from the latest discovery result
- **THEN** FREE passes that exact ID to the selected provider
- **AND** it does not choose a discovered replacement

#### Scenario: Environment settings are present
- **WHEN** `AI_PROVIDER`, `AI_MODEL`, `AI_CHAT_MODEL`, `AI_BASE_URL`, or `AI_API_KEY` is present
- **THEN** FREE does not read it as model configuration or a credential for the operation

## ADDED Requirements

### Requirement: A cold gateway model is waited for, not substituted
When an operation routed to the *Deployment model cache* receives `503 model_starting`, a background operation (Schema Suggestion, edit proposal or Extraction) SHALL wait durably and retry after `Retry-After`, up to the operator's start timeout, without changing the selected model. The interactive Assistant SHALL show the researcher that the model is loading and retry. `model_capacity_exhausted` and `model_failed` SHALL fail the operation with that code once the wait ends; they SHALL NOT fall back to another model.

#### Scenario: Schema Suggestion on a stopped model
- **WHEN** Schema Suggestion is routed to a stopped cached model
- **THEN** its workflow waits until the model serves and then calls that exact model

#### Scenario: The Assistant on a starting model
- **WHEN** a researcher sends an Assistant message to a model that is starting
- **THEN** the conversation shows that the model is loading and sends the message once it serves

#### Scenario: Capacity is exhausted
- **WHEN** the gateway answers `model_capacity_exhausted` until the wait ends
- **THEN** the operation fails with `model_capacity_exhausted` and no other model is called
