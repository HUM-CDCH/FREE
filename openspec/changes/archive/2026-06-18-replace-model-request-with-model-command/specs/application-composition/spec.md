## REMOVED Requirements

### Requirement: ModelGateway is the use-case-facing model boundary
**Reason**: `ModelGateway` and `ModelCall` are removed and replaced by `ModelExecutor`.

**Migration**: Compose one `ModelExecutor` from `RequestCompiler`, generic provider transport, splitter configuration, and result parsing support; inject that executor into use-case pipelines.

### Requirement: Application composition configures NuExtract control channel
**Reason**: Application composition no longer creates a NuExtract request builder or exposes a separate task-control channel selection.

**Migration**: Application composition creates `RequestCompiler` from provider settings; the compiler owns provider control placement.

## MODIFIED Requirements

### Requirement: Application services are composed in FastAPI lifespan

The backend SHALL compose runtime dependencies and use-case pipelines from FastAPI lifespan through an explicit application composition container. Route handlers SHALL access route-facing pipelines through `request.app.state.services` rather than module-level runtime globals. `request.app.state.services` SHALL NOT expose lower-level collaborators such as the request compiler, provider transport, model executor, source-document input preparer, or source-context builder.

#### Scenario: Lifespan composes application services

- **WHEN** the FastAPI application starts
- **THEN** lifespan creates the shared HTTP client, request compiler, provider transport, model executor, source-document input preparer, source-context builder, and use-case pipelines
- **AND** it stores an `ApplicationServices` facade on `app.state.services`
- **AND** the facade exposes only the `chat`, `extract`, `generate_template`, and `markdown` pipelines

#### Scenario: Route handlers use composed services

- **WHEN** a request reaches `/chat`, `/extract`, `/generate-template`, or `/markdown`
- **THEN** the route handler retrieves the relevant pipeline from `request.app.state.services`
- **AND** the handler does not read a process-global model provider, compiler, or executor
- **AND** the handler does not reach through application state for lower-level collaborators

### Requirement: Typed internal errors preserve diagnostic detail

The backend SHALL use typed internal exceptions for source-document preparation, model-provider failures, and result parsing failures. These exceptions SHALL preserve raw detail and original causes so developer-stage diagnostics for vLLM, Ollama, and Docker Model Runner failures remain inspectable.

#### Scenario: Model failure preserves raw provider detail

- **WHEN** the provider returns or raises a detailed failure
- **THEN** the model-provider error retains the raw detail and original cause
- **AND** the API response preserves the current developer-stage model endpoint error detail

#### Scenario: Source-document failure maps at HTTP boundary

- **WHEN** source-document preparation fails because input is unsupported or unreadable
- **THEN** the pipeline raises a typed source-document error
- **AND** the FastAPI route maps it to the existing client-error behavior without requiring `source_document.py` to import FastAPI

## ADDED Requirements

### Requirement: Application composition configures model compilation
Application composition SHALL configure model command compilation from provider settings and SHALL NOT configure a separate NuExtract task-control channel.

#### Scenario: Ollama compiler profile is configured
- **WHEN** application services are built with `NUEXTRACT3_PROVIDER` set to `ollama`
- **THEN** the request compiler compiles provider requests using the Ollama URL, header, payload, task-control, and reasoning behavior

#### Scenario: vLLM compiler profile is configured
- **WHEN** application services are built with `NUEXTRACT3_PROVIDER` set to `vllm`
- **THEN** the request compiler compiles provider requests using vLLM/OpenAI-compatible URL, header, payload, task-control, and reasoning behavior

#### Scenario: OpenAI-compatible compiler profile is configured
- **WHEN** application services are built with `NUEXTRACT3_PROVIDER` set to `openai`
- **THEN** the request compiler compiles provider requests using the existing OpenAI-compatible NuExtract extension behavior

#### Scenario: Application services hide lower-level compiler decisions
- **WHEN** route handlers access `request.app.state.services`
- **THEN** they receive only route-facing pipelines
- **AND** they do not access or override provider profiles, task-control placement, headers, URLs, or payload construction
