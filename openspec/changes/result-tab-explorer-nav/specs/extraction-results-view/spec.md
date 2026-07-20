## MODIFIED Requirements

### Requirement: Re-run replaces the displayed result

When a result is already displayed and the schema is ready, the researcher SHALL be able to re-run the extraction, and the newly produced result SHALL replace the previously displayed one without carrying over any prior per-field state. In addition, the result-tree navigator state (current path, back stack, forward stack) SHALL be reset to the root view whenever the extraction state changes away from `ready`.

#### Scenario: Re-running after a result exists

- **WHEN** a result is shown and the researcher triggers a re-run
- **THEN** a new extraction runs and its result replaces the previously displayed result
- **AND** no review decisions or staleness state from the previous run are preserved
- **AND** the navigator resets to the root view (breadcrumb shows "Results", no back/forward buttons visible)

#### Scenario: Navigator resets when extraction restarts

- **WHEN** the researcher was navigated inside a node (navPath non-empty) and a new extraction is triggered
- **THEN** navPath, backStack, and forwardStack are all cleared
- **AND** the root view is shown as soon as the extraction completes
