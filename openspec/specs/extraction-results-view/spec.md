# extraction-results-view Specification

## Purpose
TBD - created by archiving change simplify-results-json-viewer. Update Purpose after archive.

## Requirements
### Requirement: Read-only pretty-printed JSON result

When an extraction has completed, the Results tab SHALL display the extraction result as pretty-printed JSON (2-space indentation) in a scrollable, read-only region. The view SHALL NOT provide any controls to edit, accept, reject, or otherwise modify the result. The result is guaranteed to be a JSON object by the existing `/extract` contract (`decodeExtractDone` rejects non-objects, and structured mode raises on the backend), so the viewer renders an object and does not add handling for other JSON value shapes.

#### Scenario: Completed extraction renders as JSON

- **WHEN** an extraction completes successfully and produces a result
- **THEN** the Results tab shows that result serialized with `JSON.stringify(result, null, 2)` in a scrollable region
- **AND** no accept / edit / reject / confirm-empty / bulk-accept controls are present

### Requirement: Empty state before any extraction

When no extraction result exists, the Results tab SHALL show an empty state that directs the user to run an extraction rather than a blank or error view.

#### Scenario: No result yet

- **WHEN** no extraction has been run for the current document
- **THEN** the Results tab shows an empty state prompting the user to run extraction

### Requirement: Live output while running

While an extraction is in progress, the Results tab SHALL display the streamed raw output as it arrives, updating in place until the run completes.

#### Scenario: Streaming during a run

- **WHEN** an extraction is running and the backend is streaming output
- **THEN** the Results tab shows the accumulated raw streamed text, updating as more arrives
- **AND** when the run completes, the view replaces the raw text with the pretty-printed parsed result

### Requirement: Error state with retry

When an extraction fails, the Results tab SHALL display the failure message and offer an action to re-run the extraction.

#### Scenario: Extraction fails

- **WHEN** an extraction request fails with an error
- **THEN** the Results tab shows the error message
- **AND** provides a control to retry / re-run the extraction

### Requirement: Re-run replaces the displayed result

When a result is already displayed and the schema is ready, the user SHALL be able to re-run the extraction, and the newly produced result SHALL replace the previously displayed one without carrying over any prior per-field state.

#### Scenario: Re-running after a result exists

- **WHEN** a result is shown and the user triggers a re-run
- **THEN** a new extraction runs and its result replaces the previously displayed JSON
- **AND** no review decisions or staleness state from the previous run are preserved

### Requirement: No export affordance

The Results tab SHALL NOT provide any export, download, or format-selection controls. The result is presented for on-screen inspection only.

#### Scenario: Export controls are absent

- **WHEN** a result is displayed
- **THEN** there is no "Export", "Download", JSON/CSV, or scope-selection control in the Results tab
