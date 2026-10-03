## MODIFIED Requirements

### Requirement: Eight provider kinds; CLI providers are deployment connections
FREE SHALL support Ollama, OpenAI, Anthropic, Google, vLLM and OpenAI-compatible researcher connections, and Codex CLI and Claude Code only as deployment connections enabled by `FREE_DEPLOYMENT_CLI_PROVIDERS`. Deployment connections (the *Deployment model cache* vLLM connection to the Model Gateway named by `FREE_DEPLOYMENT_MODEL_GATEWAY_URL`, and enabled CLI providers) SHALL be listed read-only with reserved IDs, never saved, and usable by every researcher. The *Deployment model cache* connection's discovery SHALL list every model the gateway lists, with its state. HTTP bases SHALL preserve valid supplied version and path prefixes, reject embedded credentials, and use the selected provider's native resource protocol.

#### Scenario: Provider bases preserve supplied versions and prefixes
- **WHEN** an HTTP connection is saved with a valid base ending in `/v1` or `/v1beta`
- **THEN** its adapter appends only resource paths beneath that exact base

#### Scenario: An API base contains embedded credentials
- **WHEN** an HTTP API base includes a username or password
- **THEN** FREE refuses it without persisting or sending the embedded value

#### Scenario: A native API base is customized
- **WHEN** an Ollama, OpenAI, Anthropic or Google connection uses a custom valid base
- **THEN** FREE keeps that provider's native protocol rather than interpreting it as OpenAI-compatible

#### Scenario: An Ollama server base reaches each native resource once
- **WHEN** an Ollama connection stores a server base with or without a path prefix
- **THEN** discovery uses `{base}/api/tags` and general generation uses `{base}/api/chat`
- **AND** FREE does not append `/api` twice or strip the prefix

#### Scenario: Native OpenAI and OpenAI-compatible use distinct generation protocols
- **WHEN** otherwise equivalent routes choose OpenAI and OpenAI-compatible connections
- **THEN** native OpenAI generates through `{base}/responses` and OpenAI-compatible through `{base}/chat/completions`
- **AND** neither adapter substitutes the other protocol

#### Scenario: An enabled CLI provider is a read-only deployment connection
- **WHEN** the operator enables Codex CLI or Claude Code
- **THEN** every researcher sees it as read-only with a reserved ID
- **AND** no account saves its own copy of that connection

#### Scenario: The model cache is one deployment connection
- **WHEN** the gateway lists three cached generation models
- **THEN** every researcher sees one read-only *Deployment model cache* connection whose discovery offers those three model ids

## ADDED Requirements

### Requirement: Model steps list cached models with their serving state
The *Schema & chat* and *Extracting data* steps SHALL offer every model of the *Deployment model cache*, each labelled `serving`, `starting`, `stopped`, `failed` or `unservable`. Stopped, starting and failed models SHALL be selectable, with a note that the first use loads the model and can take minutes. `unservable` models SHALL be shown but not selectable. *Extracting data* SHALL offer NuExtract models only for the fields role. A saved choice that the listing no longer offers SHALL stay saved and shown, and a listing failure SHALL block no other edit.

#### Scenario: A stopped model is chosen for extraction
- **WHEN** a researcher picks the stopped `nvidia/Qwen3.8-27B-NVFP4` for the reasoning role and applies
- **THEN** the choice is saved and the page notes that the model loads on first use

#### Scenario: NuExtract is offered only for fields
- **WHEN** the listing includes `numind/NuExtract3-FP8`
- **THEN** it appears in the Fields picker and not in the Reasoning picker

#### Scenario: An unservable model cannot be chosen
- **WHEN** the gateway lists a model as `unservable`
- **THEN** the page shows it but does not allow it as a new choice
