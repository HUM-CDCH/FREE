## ADDED Requirements

### Requirement: Model commands express semantic model work
The backend SHALL represent outbound model work with immutable provider-neutral `ModelCommand` values whose task variant expresses the semantic operation without URL, headers, provider payload keys, `chat_template_kwargs`, or provider-specific reasoning fields.

#### Scenario: Chat command carries no extraction controls
- **WHEN** the chat pipeline prepares a model command for researcher chat text
- **THEN** the command task is `ChatTask`
- **AND** the command content contains the chat text
- **AND** the command does not contain an extraction schema, researcher instruction, NuExtract mode, or raw template-kwargs dictionary

#### Scenario: Structured extraction command requires an extraction schema
- **WHEN** schema-guided extraction prepares a model command
- **THEN** the command task is `StructuredExtractionTask`
- **AND** the task carries required `template_json`
- **AND** the task may carry researcher instructions separately from the extraction schema

#### Scenario: Non-structured tasks cannot carry an extraction schema
- **WHEN** chat, markdown, direct extraction, or schema suggestion prepares a model command
- **THEN** the task variant has no `template_json` field
- **AND** an extraction schema cannot be represented for that task without choosing `StructuredExtractionTask`

#### Scenario: Reasoning has one source of truth
- **WHEN** any model command is created
- **THEN** the command contains exactly one provider-neutral `reasoning` flag
- **AND** all wire-level thinking and reasoning controls are derived from that flag and provider profile

### Requirement: Request compiler emits complete provider requests
The backend SHALL compile a `ModelCommand` into a complete `PreparedProviderRequest` containing the provider URL, request headers, and full JSON payload before transport begins.

#### Scenario: Compiler owns common chat-completion payload fields
- **WHEN** a command is compiled
- **THEN** the prepared payload contains configured model, resolved temperature, token limit, stream flag, system message, and user message content
- **AND** no later transport or executor step adds those fields

#### Scenario: Compiler owns endpoint and authorization fields
- **WHEN** a command is compiled for a configured provider
- **THEN** the prepared request contains the normalized chat-completions URL for that provider
- **AND** it contains the authorization headers implied by the configured API key

#### Scenario: Compiler resolves temperature once
- **WHEN** a command supplies an explicit temperature
- **THEN** the prepared payload uses that value unchanged
- **AND** the executor does not resolve or override temperature

#### Scenario: Compiler applies default reasoning temperature
- **WHEN** a command omits temperature
- **THEN** the prepared payload uses `0.6` when command reasoning is enabled
- **AND** the prepared payload uses `0.2` when command reasoning is disabled

### Requirement: Request compiler encodes NuExtract tasks by provider profile
The request compiler SHALL translate task variants into exactly one authoritative NuExtract task-control channel for each supported provider profile while deriving thinking controls from the command reasoning flag.

#### Scenario: Ollama structured extraction uses message text controls
- **WHEN** a structured extraction command is compiled for `ollama`
- **THEN** the user message content contains the structured task prompt, source context, researcher instructions when provided, and extraction schema text
- **AND** `chat_template_kwargs` omits `mode`, `template`, and task `instructions`
- **AND** `chat_template_kwargs.enable_thinking` equals the command reasoning flag

#### Scenario: vLLM structured extraction uses template kwargs controls
- **WHEN** a structured extraction command is compiled for `vllm`
- **THEN** the user message content contains source context without duplicated structured task controls
- **AND** `chat_template_kwargs` contains `mode: structured`, the extraction schema, combined task and researcher instructions, and `enable_thinking`

#### Scenario: OpenAI-compatible structured extraction uses template kwargs controls
- **WHEN** a structured extraction command is compiled for provider setting `openai`
- **THEN** the compiler uses the same NuExtract extension-compatible task-control placement as `vllm`
- **AND** the provider setting is not treated as strict official OpenAI chat completion behavior in this change

#### Scenario: Ollama markdown and direct extraction use message text controls
- **WHEN** markdown or direct extraction is compiled for `ollama`
- **THEN** the compiler prepends the task prompt to message content
- **AND** direct extraction appends researcher instructions to message content when provided
- **AND** task mode kwargs are omitted

#### Scenario: vLLM markdown and direct extraction use template kwargs controls
- **WHEN** markdown or direct extraction is compiled for `vllm` or `openai`
- **THEN** markdown uses `chat_template_kwargs.mode: markdown`
- **AND** direct extraction uses `chat_template_kwargs.mode: content`
- **AND** direct extraction includes `chat_template_kwargs.instructions` only when researcher instructions are present

#### Scenario: Schema suggestion has one base task prompt owner
- **WHEN** schema suggestion is compiled
- **THEN** the compiler, not the use case, owns the base template-generation task prompt
- **AND** annotation-mode guidance is appended as task input at most once
- **AND** `chat_template_kwargs.enable_thinking` equals the command reasoning flag

### Requirement: Compiled payloads preserve characterized behavior
The backend SHALL use compiler-level golden tests as the oracle for current provider payload behavior before removing the legacy request path.

#### Scenario: Golden tests cover supported task and provider combinations
- **WHEN** compiler payload tests are inspected
- **THEN** they cover chat, markdown, direct extraction, schema-guided extraction, and schema suggestion for `ollama`, `vllm`, and `openai`
- **AND** they assert payload, URL, headers, reasoning fields, and resolved temperature

#### Scenario: Accepted schema-suggestion cleanup is documented in tests
- **WHEN** schema-suggestion compiler payload tests run for `vllm` or `openai`
- **THEN** they assert that use-case guidance no longer contributes the base template-generation prompt to content
- **AND** they still assert template-generation mode in `chat_template_kwargs`
