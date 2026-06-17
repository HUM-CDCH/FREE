## ADDED Requirements

### Requirement: Application composition configures NuExtract control channel
The backend SHALL derive the NuExtract task-control channel from provider settings during application composition and inject it into NuExtract request construction.

#### Scenario: Ollama selects message-text control
- **WHEN** application services are built with `NUEXTRACT3_PROVIDER` set to `ollama`
- **THEN** the NuExtract request builder is configured to use message text as the authoritative task-control channel

#### Scenario: vLLM selects template-kwargs control
- **WHEN** application services are built with `NUEXTRACT3_PROVIDER` set to `vllm`
- **THEN** the NuExtract request builder is configured to use template kwargs as the authoritative task-control channel

#### Scenario: OpenAI alias selects template-kwargs control
- **WHEN** application services are built with `NUEXTRACT3_PROVIDER` set to `openai`
- **THEN** the NuExtract request builder is configured to use template kwargs as the authoritative task-control channel

#### Scenario: Application services hide lower-level channel decisions
- **WHEN** route handlers access `request.app.state.services`
- **THEN** they receive only route-facing pipelines
- **AND** they do not access or override the NuExtract task-control channel directly
