# model-provider-adapters Specification

## Purpose
Provider adapters isolate transport details for supported model runtimes. They select endpoint URLs and headers, serialize already prepared `ModelRequest` content and template kwargs into provider payloads, and decode streaming deltas without owning NuExtract task semantics.
## Requirements
### Requirement: Route contracts remain unchanged
The provider refactor SHALL NOT change existing backend route contracts.

#### Scenario: JSONL clients request streaming responses
- **WHEN** a client requests `/chat`, `/extract`, `/markdown`, or `/generate-template` with JSONL-compatible accept headers
- **THEN** the response remains a JSON Lines stream of `JsonLineEvent` objects

#### Scenario: JSON clients request buffered responses
- **WHEN** a client requests a streaming endpoint with `Accept: application/json` and not `application/jsonl`
- **THEN** the response remains a buffered JSON array of `JsonLineEvent` objects

#### Scenario: Existing validation errors are preserved
- **WHEN** a request violates an existing route validation rule
- **THEN** the response status and error detail remain unchanged

### Requirement: Compiled provider requests preserve endpoint and authentication behavior
The backend SHALL preserve existing endpoint URL and authorization-header behavior when compiling provider requests for Ollama and vLLM/OpenAI-compatible providers.

#### Scenario: Ollama root URL is normalized
- **WHEN** a command is compiled for `ollama` with a root base URL that does not end in `/v1`
- **THEN** the prepared request URL appends `/v1` before `/chat/completions`

#### Scenario: Ollama explicit v1 URL is preserved
- **WHEN** a command is compiled for `ollama` with a base URL that already ends in `/v1`
- **THEN** the prepared request URL does not append a second `/v1`

#### Scenario: vLLM URL is preserved
- **WHEN** a command is compiled for `vllm` with an OpenAI-compatible base URL
- **THEN** the prepared request URL targets that base URL followed by `/chat/completions`
- **AND** no Ollama-specific path segment is added

#### Scenario: Empty API key omits authorization
- **WHEN** the configured API key is empty or the placeholder value `EMPTY`
- **THEN** the prepared request headers omit `Authorization`

#### Scenario: Real API key sends bearer authorization
- **WHEN** the configured API key is a non-empty non-placeholder value
- **THEN** the prepared request headers include `Authorization: Bearer <api key>`

### Requirement: Provider transport posts compiled requests unchanged
The provider transport SHALL send prepared provider requests without adding provider payload fields, changing headers, changing URLs, or choosing task-control channels.

#### Scenario: Transport uses prepared request fields
- **WHEN** provider transport opens an HTTP stream
- **THEN** it posts to `PreparedProviderRequest.url`
- **AND** it passes `PreparedProviderRequest.headers`
- **AND** it passes `PreparedProviderRequest.payload` as the JSON body

#### Scenario: Transport does not inspect model command semantics
- **WHEN** provider transport code is inspected
- **THEN** it does not import `ModelCommand` task variants
- **AND** it does not branch on chat, markdown, direct extraction, schema-guided extraction, or schema suggestion

### Requirement: Provider transport exposes a minimal stream seam
The backend SHALL expose provider transport to the model executor through a minimal stream operation that accepts a `PreparedProviderRequest` and yields chat deltas.

#### Scenario: Executor can use a stubbed transport
- **WHEN** tests compose `ModelExecutor`
- **THEN** they can inject a transport test double with `stream(prepared)`
- **AND** the test double does not need provider settings, an HTTP client, content, template kwargs, or temperature arguments

#### Scenario: Provider protocol does not expose settings or client
- **WHEN** provider transport protocols or interfaces are inspected
- **THEN** they expose only the operation needed by model execution
- **AND** they do not require public `settings` or `client` attributes

### Requirement: Shared provider base types remain available
The backend SHALL retain shared provider base types that are still used by command, compiler, and transport code after provider subclasses are removed.

#### Scenario: Shared content and delta types survive adapter removal
- **WHEN** provider payload-building subclasses are removed
- **THEN** `ChatContent` remains available for `ModelCommand`
- **AND** `ChatDelta` remains available for provider transport
- **AND** `ProviderSettings` remains available for request compilation

### Requirement: Provider transport preserves stream output contract
The provider transport SHALL expose streamed model output to backend event helpers as reasoning and content text deltas.

#### Scenario: Stream chunk contains reasoning and content
- **WHEN** a model stream chunk contains reasoning content or answer content
- **THEN** the transport yields a `(reasoning_delta, content_delta)` tuple carrying only the new text

#### Scenario: Stream chunk is malformed or empty
- **WHEN** a model stream line is not a parseable chat-completion data chunk
- **THEN** the transport ignores that line without changing the JSONL event contract

### Requirement: Provider transport centralizes model-provider errors
The provider transport SHALL be the only boundary that converts HTTP transport failures into the backend model-provider error type.

#### Scenario: HTTP status error preserves response body
- **WHEN** the provider returns an HTTP status error with a response body before streaming completes
- **THEN** the raised model-provider error preserves the HTTP status, URL, and response body text

#### Scenario: Connection error preserves raw detail
- **WHEN** the HTTP client raises a connection-level error
- **THEN** the raised model-provider error preserves the raw detail and original cause

#### Scenario: Executor and routes do not catch raw HTTP errors
- **WHEN** executor and route error-handling code is inspected
- **THEN** it handles the backend model-provider error type
- **AND** it does not include redundant raw `httpx.HTTPError` provider-boundary catches

