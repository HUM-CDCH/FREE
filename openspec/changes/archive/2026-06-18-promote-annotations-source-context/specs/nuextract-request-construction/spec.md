## ADDED Requirements

### Requirement: Schema suggestion separates annotation source material from task intent

Schema-suggestion request construction SHALL receive annotation-backed source material through source content and SHALL receive annotation-mode behavior only as task guidance.

#### Scenario: Annotation text is source content for schema suggestion

- **WHEN** the schema-suggestion pipeline builds a request from a source document and annotations
- **THEN** annotation-backed source material is present in the source content passed to NuExtract request construction
- **AND** natural-language schema-suggestion guidance does not duplicate the annotation text

#### Scenario: Annotation mode remains schema-suggestion guidance

- **WHEN** schema suggestion is requested with an annotation mode such as hints or fields
- **THEN** the pipeline represents the mode as schema-suggestion task guidance
- **AND** the source-context builder does not decide how schema suggestion should interpret annotations
