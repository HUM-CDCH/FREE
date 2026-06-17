## ADDED Requirements

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
