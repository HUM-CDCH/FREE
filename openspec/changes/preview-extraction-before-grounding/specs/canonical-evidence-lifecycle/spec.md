## ADDED Requirements

### Requirement: Provisional values remain separate from canonical Evidence authority

FREE SHALL expose checkpointed interactive Extraction values before Evidence linking completes, but SHALL NOT expose Evidence Links, Review Decisions, review actions, or export authority until a successful immutable Extraction exists.

#### Scenario: Values finish before Evidence linking

- **WHEN** an interactive Extraction has checkpointed values and remains running
- **THEN** the researcher can inspect those values with an Evidence-linking indication and cannot review or export them

#### Scenario: Researcher reopens provisional work

- **WHEN** the researcher navigates away from a running interactive Extraction and later reopens its Source Document
- **THEN** FREE restores the latest logical attempt and any checkpointed values without having cancelled server work

### Requirement: Explicit cancellation is durable

Leaving an Extraction view SHALL stop browser polling without cancelling server work. Explicit cancellation of an owned active interactive job SHALL be durable and SHALL prevent terminal promotion when committed first.

#### Scenario: Cancellation races terminal promotion

- **WHEN** cancellation commits before the worker's terminal transaction
- **THEN** the job becomes failed with cancellation recorded and no Extraction is inserted
