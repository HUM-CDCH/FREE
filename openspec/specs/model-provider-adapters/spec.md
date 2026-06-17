# model-provider-adapters Specification

## Purpose
TBD - created by archiving change modularize-model-providers. Update Purpose after archive.
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

### Requirement: Provider adapters preserve payload behavior
The provider adapters SHALL preserve the current provider payload semantics while treating inbound model content as already prepared by upstream request construction.

#### Scenario: Ollama structured payload includes prepared content and template kwargs
- **WHEN** the Ollama adapter receives prepared structured extraction content with template kwargs and reasoning enabled
- **THEN** the request payload includes the configured model, temperature, token limit, stream flag, system prompt, chat template kwargs, Ollama reasoning flag, and the prepared content unchanged in the user message

#### Scenario: Ollama content payload omits reasoning when disabled
- **WHEN** the Ollama adapter receives content extraction with reasoning disabled
- **THEN** the request payload omits the provider reasoning flag

#### Scenario: vLLM structured payload includes prepared content
- **WHEN** the vLLM adapter receives prepared multimodal content and template kwargs
- **THEN** the request payload includes the configured model, temperature, token limit, stream flag, system prompt, chat template kwargs, and the prepared content unchanged in the user message

#### Scenario: Provider payload construction does not duplicate task prompts
- **WHEN** provider payload construction receives content that starts with a NuExtract task prompt
- **THEN** the provider payload includes that content unchanged
- **AND** provider payload construction does not call NuExtract task-prompt preparation helpers

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

