# nuextract-request-construction Specification

## Purpose
NuExtract request construction centralizes model-family task preparation before `ModelGateway`. It builds prepared `ModelRequest` values for extraction, schema suggestion, and markdown workflows while selecting exactly one authoritative NuExtract control channel from provider capability.

## Requirements
### Requirement: NuExtract request builder exposes a configured typed API
The backend SHALL configure NuExtract request construction with a single task-control channel and expose typed workflow methods for the NuExtract workflows FREE uses.

#### Scenario: Builder is configured with a task-control channel
- **WHEN** a NuExtract request builder is created
- **THEN** it is configured with either message text or template kwargs as the task-control channel
- **AND** the selected channel is not stored on `ModelRequest`

#### Scenario: Builder exposes typed workflow methods
- **WHEN** use-case pipelines prepare NuExtract model requests
- **THEN** they call typed request-builder methods for structured extraction, content extraction, schema suggestion, or markdown
- **AND** they do not call a generic method with raw task-control dictionaries

#### Scenario: Schema suggestion uses canonical internal terminology
- **WHEN** the schema-suggestion pipeline asks the request builder for a model request
- **THEN** it uses a schema-suggestion-oriented builder method
- **AND** legacy route or payload names such as `generate-template` or `template` do not define the internal request-construction vocabulary

### Requirement: NuExtract request builder prepares outbound model requests
The backend SHALL construct NuExtract-specific outbound model requests through a dedicated request builder before those requests reach `ModelGateway`.

#### Scenario: Structured extraction request is fully prepared for message-text control
- **WHEN** structured extraction source content, an extraction schema, researcher instructions, reasoning, and temperature are provided to the NuExtract request builder with message text as the authoritative control channel
- **THEN** it returns a `ModelRequest` whose content begins with the structured NuExtract task prompt
- **AND** the content includes readable researcher-instruction and extraction-schema controls
- **AND** the request does not duplicate extraction schema or researcher instructions in provider template kwargs
- **AND** the request carries the requested reasoning flag and temperature

#### Scenario: Structured extraction request is fully prepared for template-kwargs control
- **WHEN** structured extraction source content, an extraction schema, researcher instructions, reasoning, and temperature are provided to the NuExtract request builder with template kwargs as the authoritative control channel
- **THEN** it returns a `ModelRequest` whose content contains source context without duplicate readable extraction-schema or researcher-instruction controls
- **AND** the request contains provider-neutral template kwargs for mode, extraction schema, researcher instructions, and thinking
- **AND** the request carries the requested reasoning flag and temperature

#### Scenario: Content extraction request is fully prepared
- **WHEN** content extraction source content and optional researcher instructions are provided to the NuExtract request builder
- **THEN** it returns a `ModelRequest` whose content and template kwargs place researcher instructions in the selected authoritative control channel
- **AND** researcher instructions are not duplicated across message text and template kwargs
- **AND** the request carries thinking controls and any requested temperature

#### Scenario: Schema suggestion request is fully prepared
- **WHEN** schema-suggestion source content and natural-language schema-suggestion guidance are provided to the NuExtract request builder
- **THEN** the guidance is treated as task input message text
- **AND** template-kwargs-authoritative providers receive provider-neutral template kwargs for template-generation mode with thinking disabled
- **AND** message-text-authoritative providers receive message content sufficient to request a schema suggestion without relying on template-generation kwargs

#### Scenario: Schema suggestion instructs the model against wrapper keys
- **WHEN** the NuExtract request builder prepares a schema-suggestion request
- **THEN** the task instructions sent to the model include a constraint that top-level keys must be semantic field names
- **AND** the instructions prohibit using record identifiers, document titles, or subject names as top-level wrapper keys

#### Scenario: Markdown request is fully prepared
- **WHEN** markdown source content, reasoning, and temperature are provided to the NuExtract request builder
- **THEN** it returns a `ModelRequest` whose content and template kwargs place markdown mode instructions in the selected authoritative control channel
- **AND** markdown mode instructions are not duplicated across message text and template kwargs
- **AND** the request contains thinking controls and any requested temperature

### Requirement: NuExtract request construction selects one authoritative control channel
The backend SHALL select one authoritative NuExtract control channel for task controls before building each NuExtract `ModelRequest`.

#### Scenario: Provider capability determines control placement
- **WHEN** application composition creates the NuExtract request builder
- **THEN** it passes an explicit control-channel capability derived from provider settings
- **AND** the request builder uses that capability to decide whether NuExtract task controls belong in message text or provider-neutral template kwargs

#### Scenario: Task controls are not duplicated
- **WHEN** a NuExtract request includes task controls such as mode, extraction schema, researcher instructions, schema-suggestion mode, or markdown mode
- **THEN** those controls appear in exactly one authoritative channel
- **AND** provider template kwargs may still carry provider/model generation settings such as thinking controls when needed

### Requirement: NuExtract request construction hides raw control keys from pipelines
NuExtract use-case pipelines SHALL call typed request-builder methods instead of assembling raw NuExtract template kwargs directly.

#### Scenario: NuExtract pipelines use typed construction
- **WHEN** extraction, schema-suggestion, or markdown pipelines prepare model calls
- **THEN** they obtain `ModelRequest` values from the NuExtract request builder
- **AND** they do not directly construct `mode`, `template`, or `instructions` template-kwargs dictionaries

#### Scenario: Chat remains generic
- **WHEN** the generic chat pipeline prepares a model request
- **THEN** it does not use the NuExtract request builder
- **AND** it does not add a NuExtract task mode or task prompt

### Requirement: Request builder is the public NuExtract prompt-preparation surface
The backend SHALL expose typed NuExtract request-builder methods as the public prompt-preparation surface and keep low-level task-prompt prepending helpers private to that module.

#### Scenario: Provider modules do not export NuExtract prompt helpers
- **WHEN** provider modules are imported by callers
- **THEN** NuExtract task-prompt prepending helpers are not exported from `model_providers`
- **AND** callers use the request builder for NuExtract request preparation

### Requirement: NuExtract request builder follows provider-channel placement rules
The backend SHALL place NuExtract task controls according to the configured authoritative channel.

#### Scenario: Message-text channel carries task controls
- **WHEN** the request builder is configured for message text
- **THEN** NuExtract task prompts, extraction schemas, researcher instructions, markdown mode instructions, and schema-suggestion task guidance are represented in message content
- **AND** task-control kwargs such as mode, template, and instructions are omitted from provider-neutral template kwargs

#### Scenario: Template-kwargs channel carries task controls
- **WHEN** the request builder is configured for template kwargs
- **THEN** NuExtract mode, extraction schema, researcher instructions, markdown mode, and template-generation mode are represented in provider-neutral template kwargs where applicable
- **AND** message content does not duplicate those task controls
- **AND** schema-suggestion natural-language guidance remains message content because it is task input rather than a duplicated control

#### Scenario: Thinking controls remain generation controls
- **WHEN** a request includes reasoning or thinking configuration
- **THEN** the builder may include thinking configuration in provider-neutral template kwargs
- **AND** that thinking configuration does not count as duplicated NuExtract task control

### Requirement: Provider-control probe covers supported NuExtract workflows
The backend SHALL maintain local provider-control probe evidence for each NuExtract workflow FREE depends on.

#### Scenario: Probe exercises all workflow modes
- **WHEN** the provider-control probe is run against a supported NuExtract runtime
- **THEN** it checks structured extraction, content extraction, schema suggestion, and markdown control placement
- **AND** it records whether message text, template kwargs, or both single-channel formats work for each workflow

#### Scenario: Probe records conflict precedence
- **WHEN** a probed workflow can be expressed through both message text and template kwargs
- **THEN** the probe includes a conflict case where the two channels disagree
- **AND** the probe results identify which channel the runtime followed
