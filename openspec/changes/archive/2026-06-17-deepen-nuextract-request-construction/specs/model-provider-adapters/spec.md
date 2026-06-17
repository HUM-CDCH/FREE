## MODIFIED Requirements

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
