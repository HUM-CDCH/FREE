## ADDED Requirements

### Requirement: Structured extraction includes a built-in evidence-field instruction
When structured extraction uses an evidence-wrapped template, the instructions block sent to the model SHALL include a mandatory evidence-field directive that precedes any caller-supplied instruction.

#### Scenario: Evidence-field instruction is injected for structured extraction
- **WHEN** `extractWithModel` prepares a structured extraction request
- **THEN** the instructions passed to the prompt builder begin with the built-in evidence-field directive
- **AND** the directive instructs the model to set `snippet` to a verbatim excerpt from the document
- **AND** the directive instructs the model to set `page` to the 1-based index of the page or image where the value appears

#### Scenario: Caller instruction is appended after the evidence-field directive
- **WHEN** the caller supplies a non-empty `instruction` string to `extractWithModel`
- **THEN** the caller instruction is appended after the built-in evidence-field directive
- **AND** the combined instruction is passed as a single string to the prompt builder

#### Scenario: No caller instruction leaves only the evidence-field directive
- **WHEN** the caller does not supply an `instruction` to `extractWithModel`
- **THEN** the instructions block contains only the built-in evidence-field directive
- **AND** no empty or null instruction segments are emitted

#### Scenario: Model populates snippet and page for each evidence-wrapped field
- **WHEN** the model receives a structured extraction prompt with the evidence-field directive
- **THEN** each `snippet` field in the response contains a non-empty verbatim string from the document
- **AND** each `page` field contains a positive integer

#### Scenario: splitEvidenceResult produces non-null evidence
- **WHEN** the model response includes non-empty `snippet` and positive `page` values
- **THEN** `splitEvidenceResult` returns a non-null `evidence` record
- **AND** evidence highlights can be drawn by `EvidenceHighlightLayer`
