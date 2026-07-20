## ADDED Requirements

### Requirement: Completed extraction supports review, JSON, and Markdown views

When an extraction completes, the Results tab SHALL offer Review, Raw JSON, and Markdown views. Review SHALL show only the current node's direct children, allow primitive values to be edited, and keep those edits in the live displayed result. Raw JSON SHALL pretty-print that live result. Markdown SHALL display the canonical source-document Markdown passed into the results panel.

#### Scenario: Researcher inspects all result views

- **WHEN** an extraction is ready
- **THEN** Review displays the extraction tree and permits primitive edits
- **AND** Raw JSON displays the live edited result with two-space indentation
- **AND** Markdown displays the canonical document Markdown without another model or API call

#### Scenario: Primitive edit updates the live result

- **WHEN** the researcher saves an inline primitive edit in Review
- **THEN** the edited value remains visible after navigation
- **AND** Raw JSON, Copy JSON, and Download use the edited result

### Requirement: Running state reports non-streaming progress

While extraction is in progress, the Results tab SHALL show a running indicator for the selected extraction strategy. It SHALL NOT claim to show partial model output because the extraction request completes as one response.

#### Scenario: Extraction request is in flight

- **WHEN** extraction state is `running`
- **THEN** the Results tab shows a progress indicator and the selected strategy
- **AND** no partial result is presented as completed data

### Requirement: Result export actions

When a result is ready, the Results tab SHALL provide Copy JSON and Download actions for the live displayed result.

#### Scenario: Researcher copies JSON

- **WHEN** the researcher chooses Copy JSON
- **THEN** the live result is serialized with two-space indentation and written to the clipboard

#### Scenario: Researcher downloads JSON

- **WHEN** the researcher chooses Download
- **THEN** the live result is downloaded as `free-extraction-result.json` with JSON media type

### Requirement: Primitive result values trigger path-based tracing

Every non-missing primitive row in Review SHALL report its full result path and displayed string when clicked. Missing values SHALL NOT trigger tracing.

#### Scenario: Result value selects its evidence path

- **WHEN** the researcher clicks a non-missing primitive value
- **THEN** the callback receives that value's full result path and displayed string
- **AND** equal strings at different paths remain independently selectable

#### Scenario: Missing value does not trigger tracing

- **WHEN** a primitive row displays the missing badge
- **THEN** clicking it does not invoke the tracing callback

## MODIFIED Requirements

### Requirement: Re-run replaces the displayed result

When a result is already displayed and the schema is ready, the researcher SHALL be able to re-run extraction. The newly produced result SHALL replace the previous live result and reset result-tree navigation to the root.

#### Scenario: Re-running after a result exists

- **WHEN** a result is shown and the researcher triggers a re-run
- **THEN** a new extraction runs and replaces the previous result
- **AND** prior inline edits are discarded
- **AND** current path, back stack, and forward stack reset to the root view

## REMOVED Requirements

### Requirement: Read-only pretty-printed JSON result

**Reason**: The results experience now includes editable Review, Raw JSON, and Markdown views.

**Migration**: Use the completed-extraction views requirement and treat the live edited result as the source for JSON display and export.

### Requirement: Live output while running

**Reason**: The current extraction endpoint returns one completed response and does not stream partial model output.

**Migration**: Show an honest running indicator until the response completes.

### Requirement: No export affordance

**Reason**: Copy JSON and Download are now intentional result-inspection actions.

**Migration**: Export the live displayed result through the specified actions.

### Requirement: Primitive result values trigger tracing on click

**Reason**: Raw value strings cannot distinguish duplicate values at different locations.

**Migration**: Thread the result path and displayed string through the click callback.
