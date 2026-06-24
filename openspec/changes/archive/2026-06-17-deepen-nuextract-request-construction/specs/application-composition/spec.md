## MODIFIED Requirements

### Requirement: ModelGateway is the use-case-facing model boundary

The backend SHALL expose model access to use cases through a `ModelGateway` that executes prepared `ModelRequest` values. `ModelGateway` MUST be deeper than the provider transport adapter: it SHALL execute requests through the model-call spine and MUST NOT merely duplicate the `ModelProvider.stream_chat` protocol.

#### Scenario: ModelGateway executes a prepared request

- **WHEN** a pipeline asks the model gateway to collect or stream a `ModelRequest`
- **THEN** the gateway resolves model-call execution through the configured provider and existing model-call collaborators
- **AND** the pipeline does not call `ModelProvider.stream_chat` directly

#### Scenario: ModelRequest is outbound-only

- **WHEN** a pipeline creates a `ModelRequest`
- **THEN** the request contains outbound model-call data: prepared content, provider-neutral `template_kwargs`, reasoning flag, and optional temperature
- **AND** it does not contain a result parser

#### Scenario: Parser remains inbound interpretation

- **WHEN** a pipeline needs structured parsing, template parsing, or raw text
- **THEN** it passes the parser or absence of parser to the model gateway execution method
- **AND** any model behavior required by that parser is represented in a prepared outbound `ModelRequest`

### Requirement: SourceContextBuilder assembles source context

The backend SHALL assemble source context through `SourceContextBuilder` using typed request and result objects. Source context MAY include direct text, prepared source-document input, and future annotations, but MUST NOT own extraction schema semantics, task instructions, or prompt controls.

#### Scenario: Source context returns content and page count

- **WHEN** a pipeline builds source context from direct text, prepared source-document input, or both
- **THEN** the builder returns a `SourceContext` containing model content and page count
- **AND** the page count is preserved for pipeline results

#### Scenario: Builder has a stable slot for future annotations

- **WHEN** the source-context request type is inspected
- **THEN** it has a typed place for annotations or equivalent source-facing context
- **AND** adding annotation-backed context later does not require changing every use-case pipeline signature

#### Scenario: Extraction schema remains task-specific

- **WHEN** schema-guided extraction is prepared
- **THEN** extraction schema text is added by an extraction-specific request-construction collaborator
- **AND** `SourceContextBuilder` does not treat the extraction schema as part of source context

#### Scenario: Task text remains outside source context

- **WHEN** a source context is built
- **THEN** `SourceContext` contains source-facing model content and page count only
- **AND** task instructions, extraction schema text, markdown mode instructions, template-generation guidance, and parser expectations are added by task-specific request construction rather than `SourceContextBuilder`
