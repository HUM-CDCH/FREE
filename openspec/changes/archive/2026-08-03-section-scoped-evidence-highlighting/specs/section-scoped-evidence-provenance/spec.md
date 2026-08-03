## ADDED Requirements

### Requirement: Sectioned evidence carries deterministic source scope
For every Evidence leaf emitted by Catalog sectioned extraction, the system SHALL attach `source_scope` containing `markdown_start`, `markdown_end`, `start_page`, and `end_page`. These values SHALL be derived from the canonical Markdown section supplied to the model, not from model output.

#### Scenario: A record is extracted from one section
- **WHEN** Catalog extraction invokes the model for a heading-derived section
- **THEN** every Evidence leaf retained from that section contains the same section-derived `source_scope`
- **AND** `markdown_start` and `markdown_end` bound the exact source Markdown substring sent to that extraction call

#### Scenario: Catalog sections are merged after parallel extraction
- **WHEN** multiple section extraction calls finish in any order
- **THEN** each merged result record retains Evidence scopes belonging to its own source section
- **AND** no record inherits the scope of another completed call

### Requirement: Whole-document evidence has an explicit full-document scope
For Article extraction, the system SHALL attach a `source_scope` spanning the full canonical Markdown to every Evidence leaf that has valid evidence.

#### Scenario: An article is extracted in one model call
- **WHEN** Article extraction returns valid evidence for a field
- **THEN** its `source_scope.markdown_start` is `0`
- **AND** its `source_scope.markdown_end` is the canonical Markdown length

### Requirement: Provenance is evidence metadata, not an extracted result field
The system SHALL preserve `source_scope` through response parsing and frontend state without adding it to the displayed or exported extraction result.

#### Scenario: Result and evidence are split
- **WHEN** a model response is converted into `result` and `evidence`
- **THEN** `source_scope` exists only beneath the corresponding Evidence leaf
- **AND** the result JSON retains only researcher-defined schema fields
