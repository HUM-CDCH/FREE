## MODIFIED Requirements

### Requirement: SourceContextBuilder assembles source context

The backend SHALL assemble source context through `SourceContextBuilder` using typed request and result objects. Source context SHALL include provided annotation-backed source material along with direct text and prepared source-document input, but MUST NOT own extraction schema semantics, task instructions, or prompt controls.

#### Scenario: Source context returns content and page count

- **WHEN** a pipeline builds source context from direct text, prepared source-document input, annotations, or a combination of them
- **THEN** the builder returns a `SourceContext` containing model content and page count
- **AND** the page count is preserved for pipeline results

#### Scenario: Builder renders annotations as source material

- **WHEN** a source-context request contains annotations
- **THEN** the builder adds annotation-backed source material to the returned model content
- **AND** each annotation preserves its text and page number in a source-facing representation

#### Scenario: Extraction schema remains task-specific

- **WHEN** schema-guided extraction is prepared
- **THEN** extraction schema text is added by an extraction-specific request-construction collaborator
- **AND** `SourceContextBuilder` does not treat the extraction schema as part of source context

#### Scenario: Task text remains outside source context

- **WHEN** a source context is built
- **THEN** `SourceContext` contains source-facing model content and page count only
- **AND** task instructions, extraction schema text, markdown mode instructions, template-generation guidance, annotation-mode guidance, and parser expectations are added by task-specific request construction rather than `SourceContextBuilder`
