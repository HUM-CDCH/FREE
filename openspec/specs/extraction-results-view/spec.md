# extraction-results-view Specification

## Purpose

Defines how researchers run extraction, inspect completed results, view source Markdown, and copy or download the result.

## Requirements

### Requirement: Completed extraction supports review, JSON, and Markdown views

When an extraction completes, the Results tab SHALL offer read-only Review, Raw JSON, and Markdown views. Review SHALL show only the current node's direct children. Raw JSON SHALL pretty-print the extraction result. Markdown SHALL display the canonical source-document Markdown passed into the results panel.

#### Scenario: Researcher inspects all result views

- **WHEN** an extraction is ready
- **THEN** Review displays the extraction tree without edit controls
- **AND** Raw JSON displays the extraction result with two-space indentation
- **AND** Markdown displays the canonical document Markdown without another model or API call

### Requirement: Empty state before any extraction

When no extraction result exists, the Results tab SHALL show an empty state that directs the researcher to run extraction rather than a blank or error view.

#### Scenario: No result yet

- **WHEN** no extraction has been run for the current document
- **THEN** the Results tab prompts the researcher to choose a schema if needed and run extraction

### Requirement: Running state reports non-streaming progress

While extraction is in progress, the Results tab SHALL show a running indicator for the selected extraction strategy. It SHALL NOT claim to show partial model output because the extraction request completes as one response.

#### Scenario: Extraction request is in flight

- **WHEN** extraction state is `running`
- **THEN** the Results tab shows a progress indicator and the selected strategy
- **AND** no partial result is presented as completed data

### Requirement: Error state with retry

When extraction fails, the Results tab SHALL display the failure message and offer an action to re-run extraction.

#### Scenario: Extraction fails

- **WHEN** an extraction request fails with an error
- **THEN** the Results tab shows the error message
- **AND** provides a Retry extraction control

### Requirement: Re-run replaces the displayed result

When a result is already displayed and the schema is ready, the researcher SHALL be able to re-run extraction. The newly produced result SHALL replace the previous live result and reset result-tree navigation to the root.

#### Scenario: Re-running after a result exists

- **WHEN** a result is shown and the researcher triggers a re-run
- **THEN** a new extraction runs and replaces the previous result
- **AND** current path, back stack, and forward stack reset to the root view

### Requirement: Result export actions

When a result is ready, the Results tab SHALL provide Copy JSON and Download actions for the extraction result.

#### Scenario: Researcher copies JSON

- **WHEN** the researcher chooses Copy JSON
- **THEN** the extraction result is serialized with two-space indentation and written to the clipboard

#### Scenario: Researcher downloads JSON

- **WHEN** the researcher chooses Download
- **THEN** the extraction result is downloaded as `free-extraction-result.json` with JSON media type

### Requirement: Primitive result values trigger path-based tracing

Every non-missing primitive row in Review SHALL report its full result path and displayed string when clicked. Missing values SHALL NOT trigger tracing.

#### Scenario: Result value selects its evidence path

- **WHEN** the researcher clicks a non-missing primitive value
- **THEN** the callback receives that value's full result path and displayed string
- **AND** equal strings at different paths remain independently selectable

#### Scenario: Missing value does not trigger tracing

- **WHEN** a primitive row displays the missing badge
- **THEN** clicking it does not invoke the tracing callback
