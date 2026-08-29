## ADDED Requirements

### Requirement: New extraction runs offer an Article-default strategy selector

Studio SHALL place an Article/Catalog selector beside the Extract action. Each new run SHALL default to Article, and the selector SHALL not change the strategy of an active or persisted attempt.

#### Scenario: Researcher starts a new run

- **WHEN** extraction controls are initialized for a new run
- **THEN** Article is selected by default
- **AND** the researcher may select Catalog before starting

### Requirement: Partial Catalog records and diagnostics are visible

A succeeded incomplete Catalog attempt SHALL render successful records normally beneath an Incomplete banner. Failed and unattempted records SHALL NOT appear as placeholder result records. Results SHALL retain the primary space in the tab. Compact stage and per-record outcomes, finish reasons, calls, tokens, latency, canonical boundaries, failure codes, grounding batches, and applicable retry controls SHALL be available behind one collapsed, height-bounded Run details disclosure.

#### Scenario: Catalog has mixed record outcomes

- **WHEN** a Catalog attempt succeeds with some failed or limit-skipped records
- **THEN** successful records render in canonical source order
- **AND** an Incomplete banner is visible
- **AND** failed and skipped outcomes are visible in diagnostics but not as result placeholders

#### Scenario: Run details are collapsed by default

- **WHEN** a completed extraction result is displayed
- **THEN** the result remains visible without opening diagnostics
- **AND** diagnostics and applicable Catalog retry controls are available from one collapsed Run details disclosure

#### Scenario: Technical details are expanded

- **WHEN** the researcher expands a stage or record diagnostic
- **THEN** its persisted finish reason, calls, tokens, latency, failure code, canonical boundary, and applicable grounding details are shown

### Requirement: Catalog retry controls are explicit and current-attempt only

For a persisted Catalog attempt, Studio SHALL expose targeted retry controls behind Run details only for failed or limit-skipped document, discovery, and record diagnostics, regardless of whether that diagnostic was reused by an earlier child. Successful reused components remain ineligible. It SHALL submit a new child attempt using the selected parent and components, show reused versus executed provenance from the returned diagnostics, and keep review state scoped to each attempt. Studio SHALL NOT offer a generic Catalog rerun control that silently repeats successful work; Article SHALL retain its ordinary rerun action.

#### Scenario: Researcher retries selected Catalog components

- **WHEN** the researcher selects failed Catalog components and starts a retry
- **THEN** the UI submits a new child request naming the current attempt
- **AND** successful parent components remain marked reused while selected components show fresh outcomes

#### Scenario: Catalog parent and child review state stay separate

- **WHEN** a Catalog child is reopened after its parent was reviewed
- **THEN** the child renders its own review state and diagnostics
- **AND** the parent's review state is unchanged

### Requirement: Nested results provide explicit depth navigation

The Review view SHALL provide Back and Forward history, an always-visible Root location, and clickable breadcrumbs for every ancestor of the current object or array. Selecting a nested object or array SHALL replace the result content with that level. At non-root levels, Clear SHALL return directly to Root and clear both navigation history stacks.

#### Scenario: Researcher navigates and clears a nested result

- **WHEN** the researcher opens nested object and array levels
- **THEN** each ancestor is available as a breadcrumb
- **AND** Back and Forward traverse the visited levels
- **AND** Clear returns to Root with both history stacks empty
