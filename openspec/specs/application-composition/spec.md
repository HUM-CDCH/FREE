# application-composition Specification

## Purpose
TBD - created by archiving change compose-application-services. Update Purpose after archive.
## Requirements
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

### Requirement: Source-document input preparation is FastAPI-neutral

The backend SHALL prepare source-document bytes through a FastAPI-neutral `SourceDocumentInputPreparer`. The preparer MUST accept ordinary data values, return typed prepared source-document input, and avoid FastAPI request/response types or global settings.

#### Scenario: Source document input is prepared from bytes

- **WHEN** a pipeline provides source-document bytes and a content type
- **THEN** the preparer returns `PreparedSourceDocument` containing source-document model content plus page count
- **AND** the return value keeps those values together in a typed object

#### Scenario: Preparer is transport-neutral

- **WHEN** `shared/source_document.py` is inspected
- **THEN** it does not import `UploadFile`
- **AND** it does not raise `HTTPException`
- **AND** it does not read global `settings` directly

#### Scenario: Preparer excludes task context

- **WHEN** source-document input is prepared
- **THEN** the preparer includes only source-document-derived content
- **AND** it does not append extraction schema text, researcher instructions, annotation guidance, or chat context

### Requirement: SourceContextBuilder assembles source context

The backend SHALL assemble source context through `SourceContextBuilder` using typed request and result objects. Source context SHALL include provided annotation-backed source material along with direct text and prepared source-document input, but MUST NOT own extraction schema semantics, task instructions, or prompt controls.

#### Scenario: Source context returns content and page count

- **WHEN** a pipeline builds source context from direct text, prepared source-document input, annotations, or a combination of them
- **THEN** the builder returns a `SourceContext` containing model content and page count
- **AND** the page count is preserved for pipeline results

#### Scenario: Builder renders annotations as source material

- **WHEN** a source-context request contains annotations
- **THEN** the builder adds annotation-backed source material to the returned model content
- **AND** each annotation preserves its text and page number in a source-facing representation

#### Scenario: Extraction schema remains task-specific

- **WHEN** schema-guided extraction is prepared
- **THEN** extraction schema text is added by an extraction-specific request-construction collaborator
- **AND** `SourceContextBuilder` does not treat the extraction schema as part of source context

#### Scenario: Task text remains outside source context

- **WHEN** a source context is built
- **THEN** `SourceContext` contains source-facing model content and page count only
- **AND** task instructions, extraction schema text, markdown mode instructions, template-generation guidance, annotation-mode guidance, and parser expectations are added by task-specific request construction rather than `SourceContextBuilder`

### Requirement: Use-case pipelines return plain results

The backend SHALL move use-case orchestration behind pipeline interfaces that accept transport-free request objects and return plain result objects. FastAPI handlers SHALL remain responsible for HTTP response creation and status-code mapping.

#### Scenario: Pipeline result is transport-free

- **WHEN** a pipeline completes successfully
- **THEN** it returns a plain typed result object or dictionary-equivalent value
- **AND** it does not return a FastAPI `Response`

#### Scenario: Pipeline request is transport-free

- **WHEN** a route handler calls a pipeline
- **THEN** it passes a typed request object such as `ChatRequest`, `ExtractRequest`, `GenerateTemplateRequest`, or `MarkdownRequest`
- **AND** that request object does not contain FastAPI `Request`, `Response`, `UploadFile`, or `HTTPException`

#### Scenario: Route handler maps result to existing response

- **WHEN** a route handler receives a pipeline result
- **THEN** it maps the result to the same HTTP response shape and status code as before this change
- **AND** `/chat`, `/extract`, `/generate-template`, and `/markdown` preserve their existing endpoint contracts

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

### Requirement: Future chat conversation state stays separate from model access

The application composition SHALL allow future chat conversation state to be injected separately from model access. The model gateway MUST remain stateless with respect to chat history and conversation persistence.

#### Scenario: Chat pipeline can receive conversation dependencies later

- **WHEN** chat conversation state is added in a future change
- **THEN** the application composition can inject a conversation store or context builder into the chat pipeline
- **AND** `ModelGateway` remains focused on executing prepared model requests

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

