## ADDED Requirements

### Requirement: NuExtract request builder prepares outbound model requests
The backend SHALL construct NuExtract-specific outbound model requests through a dedicated request builder before those requests reach `ModelGateway`.

#### Scenario: Structured extraction request is fully prepared
- **WHEN** structured extraction source content, an extraction schema, researcher instructions, reasoning, and temperature are provided to the NuExtract request builder
- **THEN** it returns a `ModelRequest` whose content begins with the structured NuExtract task prompt
- **AND** the content includes readable instruction and extraction-schema controls
- **AND** the request contains provider-neutral template kwargs for mode, template, instructions, and thinking
- **AND** the request carries the requested reasoning flag and temperature

#### Scenario: Content extraction request is fully prepared
- **WHEN** content extraction source content and optional researcher instructions are provided to the NuExtract request builder
- **THEN** it returns a `ModelRequest` whose content begins with the content NuExtract task prompt
- **AND** instruction controls are duplicated in readable content only when instructions are present
- **AND** the request contains provider-neutral template kwargs for content mode and thinking

#### Scenario: Template generation request is fully prepared
- **WHEN** schema-suggestion source content and template-generation guidance are provided to the NuExtract request builder
- **THEN** it returns a `ModelRequest` whose content begins with the template-generation NuExtract task prompt
- **AND** the request contains provider-neutral template kwargs for template-generation mode with thinking disabled

#### Scenario: Markdown request is fully prepared
- **WHEN** markdown source content, reasoning, and temperature are provided to the NuExtract request builder
- **THEN** it returns a `ModelRequest` whose content begins with the markdown NuExtract task prompt
- **AND** the request contains provider-neutral template kwargs for markdown mode and thinking

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
