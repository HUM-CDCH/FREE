# model-provider-adapters Specification

## Purpose
Provider adapters isolate transport details for supported model runtimes. They select endpoint URLs and headers, serialize already prepared `ModelRequest` content and template kwargs into provider payloads, and decode streaming deltas without owning NuExtract task semantics.

## Requirements
### Requirement: Provider selection uses a shared adapter interface
The backend SHALL select the configured model provider through a shared adapter interface for supported provider values.

#### Scenario: Ollama provider is selected
- **WHEN** `NUEXTRACT3_PROVIDER` is configured as `ollama`
- **THEN** the backend uses the Ollama adapter for model requests

#### Scenario: vLLM provider is selected
- **WHEN** `NUEXTRACT3_PROVIDER` is configured as `vllm`
- **THEN** the backend uses the vLLM adapter for model requests

#### Scenario: OpenAI alias selects vLLM provider
- **WHEN** `NUEXTRACT3_PROVIDER` is configured as `openai`
- **THEN** the backend uses the vLLM adapter for model requests

### Requirement: Provider adapters preserve endpoint and authentication behavior
The provider adapters SHALL preserve the existing endpoint URL and authorization-header behavior for Ollama and vLLM/OpenAI-compatible providers.

#### Scenario: Ollama root URL is normalized
- **WHEN** the Ollama provider is configured with a root base URL that does not end in `/v1`
- **THEN** model requests target the same base URL with `/v1` appended before `/chat/completions`

#### Scenario: vLLM URL is preserved
- **WHEN** the vLLM provider is configured with an OpenAI-compatible base URL
- **THEN** model requests target that base URL without adding an Ollama-specific path segment

#### Scenario: Empty API key omits authorization
- **WHEN** the configured API key is empty or the placeholder value `EMPTY`
- **THEN** model requests omit the `Authorization` header

#### Scenario: Real API key sends bearer authorization
- **WHEN** the configured API key is a non-empty non-placeholder value
- **THEN** model requests include `Authorization: Bearer <api key>`

### Requirement: Provider adapters preserve prepared payload behavior
The provider adapters SHALL preserve provider payload mechanics while treating inbound model content and template kwargs as already prepared by upstream request construction.

#### Scenario: Ollama payload includes prepared content and template kwargs
- **WHEN** the Ollama adapter receives prepared model content and template kwargs
- **THEN** the request payload includes the configured model, temperature, token limit, stream flag, system prompt, chat template kwargs, and the prepared content unchanged in the user message

#### Scenario: Ollama content payload omits reasoning when disabled
- **WHEN** the Ollama adapter receives a request with reasoning disabled
- **THEN** the request payload omits the provider reasoning flag

#### Scenario: Ollama content payload includes reasoning when enabled
- **WHEN** the Ollama adapter receives a request with reasoning enabled
- **THEN** the request payload includes the provider-specific reasoning flag

#### Scenario: vLLM payload includes prepared content and template kwargs
- **WHEN** the vLLM adapter receives prepared model content and template kwargs
- **THEN** the request payload includes the configured model, temperature, token limit, stream flag, system prompt, chat template kwargs, and the prepared content unchanged in the user message

#### Scenario: Provider payload construction does not decide NuExtract control channels
- **WHEN** provider payload construction receives prepared content and template kwargs
- **THEN** the provider payload includes those values unchanged except for provider transport mapping
- **AND** provider payload construction does not inject NuExtract task prompts, extraction schemas, researcher instructions, or schema-suggestion guidance
- **AND** provider payload construction does not decide whether message text or template kwargs are authoritative for NuExtract controls

### Requirement: Provider adapters remain NuExtract task-channel agnostic
Provider adapters SHALL serialize prepared model requests without deciding NuExtract task-control placement.

#### Scenario: Adapter serializes prepared content unchanged
- **WHEN** a provider adapter receives prepared model content
- **THEN** it serializes that content into the provider request unchanged except for provider transport formatting
- **AND** it does not prepend NuExtract task prompts or append extraction controls

#### Scenario: Adapter serializes prepared template kwargs unchanged
- **WHEN** a provider adapter receives provider-neutral template kwargs
- **THEN** it maps those kwargs to the provider payload field used for template kwargs
- **AND** it does not add or remove NuExtract task controls such as mode, extraction schema, researcher instructions, markdown mode, or template-generation mode

#### Scenario: Adapter handles provider transport controls only
- **WHEN** a provider requires transport-specific fields such as endpoint normalization, authorization headers, streaming flags, token limits, or Ollama reasoning payloads
- **THEN** the adapter may add those provider-specific transport fields
- **AND** those fields do not decide whether message text or template kwargs are authoritative for NuExtract task controls

### Requirement: Provider adapters preserve stream output contract
The provider adapters SHALL expose streamed model output to backend event helpers as reasoning and content text deltas.

#### Scenario: Stream chunk contains reasoning and content
- **WHEN** a model stream chunk contains reasoning content or answer content
- **THEN** the adapter yields a `(reasoning_delta, content_delta)` tuple carrying only the new text

#### Scenario: Stream chunk is malformed or empty
- **WHEN** a model stream line is not a parseable chat-completion data chunk
- **THEN** the adapter ignores that line without changing the JSONL event contract

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
