<!-- markdownlint-disable MD013 MD041 -->

## ADDED Requirements

### Requirement: Extraction warnings remain visible with the result

When canonical-document extraction succeeds with one or more warnings, the Results tab SHALL display those warnings without replacing or hiding the successful schema-shaped Extraction Result.

#### Scenario: Catalog boundary fallback is used

- **WHEN** the extraction response contains a `boundary_fallback` warning and a successful Extraction Result
- **THEN** the Results tab displays the pretty-printed result
- **AND** it displays the fallback warning alongside the result

#### Scenario: Extraction has no warnings

- **WHEN** the extraction response has an empty warnings collection
- **THEN** the Results tab displays the Extraction Result without an empty warning placeholder

## MODIFIED Requirements

### Requirement: Read-only pretty-printed JSON result

When canonical-document extraction has completed, the Results tab SHALL display the schema-shaped Extraction Result, including embedded Evidence, as pretty-printed JSON with 2-space indentation in a scrollable, read-only region. The view SHALL NOT provide controls to edit, accept, reject, or otherwise modify the result.

#### Scenario: Completed extraction renders as JSON

- **WHEN** canonical-document extraction completes successfully and produces an Extraction Result
- **THEN** the Results tab shows that result serialized with `JSON.stringify(result, null, 2)` in a scrollable region
- **AND** embedded Evidence remains visible at its schema-declared locations
- **AND** no accept, edit, reject, confirm-empty, or bulk-accept controls are present

### Requirement: Re-run replaces the displayed result

When an Extraction Result is already displayed and the schema and parsing task ID are ready, the humanities researcher SHALL be able to re-run extraction with an explicit strategy. The newly returned result and warnings SHALL replace the previously displayed result and warnings without carrying over prior per-field state.

#### Scenario: Re-running after a result exists

- **WHEN** a result is shown and the humanities researcher triggers a re-run
- **THEN** a new task-ID-based extraction runs and its result replaces the previously displayed JSON
- **AND** its warnings replace the previous warnings
- **AND** no review decisions or staleness state from the previous run are preserved

## REMOVED Requirements

### Requirement: Live output while running

**Reason**: The canonical-document extraction endpoint returns a decoded schema-shaped result and warnings rather than exposing the old browser-facing JSONL model stream.

**Migration**: While extraction is pending, show the existing running state without accumulated raw model output. Replace it with the decoded Extraction Result and warnings when the request completes.
