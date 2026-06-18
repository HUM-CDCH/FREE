## REMOVED Requirements

### Requirement: NuExtract request builder exposes a configured typed API
**Reason**: The configured request-builder API is replaced by provider-neutral `ModelCommand` task construction and compiler-owned provider encoding.

**Migration**: Use cases construct `ModelCommand` values with typed task variants; provider control channel selection moves to `RequestCompiler`.

### Requirement: NuExtract request builder prepares outbound model requests
**Reason**: The builder currently returns prepared `ModelRequest` values with raw `template_kwargs`, which is the legacy contract being removed.

**Migration**: Use cases pass source context into semantic task variants, and `RequestCompiler` prepares provider payloads.

### Requirement: NuExtract request construction selects one authoritative control channel
**Reason**: Control-channel selection remains required, but it no longer belongs to NuExtract request construction.

**Migration**: `RequestCompiler` chooses message text for `ollama` and `chat_template_kwargs` for `vllm` and `openai`.

### Requirement: NuExtract request construction hides raw control keys from pipelines
**Reason**: This remains a product goal, but the builder-specific requirement is superseded by command construction.

**Migration**: Pipelines create typed task variants and never construct `mode`, `template`, `instructions`, or `enable_thinking` dictionaries.

### Requirement: Request builder is the public NuExtract prompt-preparation surface
**Reason**: There is no request builder after this change.

**Migration**: The compiler is the only NuExtract prompt-preparation and provider-control encoding surface.

### Requirement: NuExtract request builder follows provider-channel placement rules
**Reason**: Provider-channel placement moves from the builder to the compiler so command creation stays provider-neutral.

**Migration**: Preserve the same placement rules in compiler tests and implementation.

## ADDED Requirements

### Requirement: NuExtract use cases construct typed model commands
NuExtract use-case pipelines SHALL construct `ModelCommand` values with typed task variants instead of prepared `ModelRequest` values or raw NuExtract control dictionaries.

#### Scenario: Schema-guided extraction creates a structured task
- **WHEN** `/extract` receives a non-empty extraction schema
- **THEN** the extraction pipeline creates a `ModelCommand` with `StructuredExtractionTask`
- **AND** the task carries the normalized extraction schema and researcher instructions
- **AND** the pipeline does not create `chat_template_kwargs`

#### Scenario: Direct extraction creates a content task
- **WHEN** `/extract` runs without an extraction schema
- **THEN** the extraction pipeline creates a `ModelCommand` with `ContentExtractionTask`
- **AND** researcher instructions, when present, are stored on the task
- **AND** the pipeline does not choose a provider control channel

#### Scenario: Markdown creates a markdown task
- **WHEN** `/markdown` prepares a model call
- **THEN** the markdown pipeline creates a `ModelCommand` with `MarkdownTask`
- **AND** the pipeline passes source-context content, reasoning, and optional temperature without task-control kwargs

#### Scenario: Schema suggestion creates a template-generation task
- **WHEN** `/generate-template` prepares a schema suggestion
- **THEN** the schema-suggestion pipeline creates a `ModelCommand` with `TemplateGenerationTask`
- **AND** annotation-mode guidance is stored as task guidance
- **AND** the pipeline does not include the base template-generation task prompt in that guidance

### Requirement: Use cases do not render NuExtract task prompts
Use-case pipelines SHALL leave NuExtract task prompt rendering to the request compiler.

#### Scenario: Task prompt files are not imported by use cases
- **WHEN** use-case modules are inspected
- **THEN** they do not import structured, markdown, content-extraction, or template-generation task prompt constants
- **AND** task prompt loading is reachable only from compiler-owned code

#### Scenario: Schema-suggestion guidance is annotation intent only
- **WHEN** annotations are supplied to `/generate-template`
- **THEN** `template_guidance()` returns only the annotation-mode instruction
- **AND** it does not prepend or repeat the base template-generation task prompt

#### Scenario: Empty schema-suggestion guidance is representable
- **WHEN** no annotations are supplied to `/generate-template`
- **THEN** the schema-suggestion task guidance may be empty
- **AND** the compiler still encodes the base template-generation task
