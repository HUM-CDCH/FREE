## MODIFIED Requirements

### Requirement: Read-only pretty-printed JSON result

When a server-owned Article attempt has a result, the Results tab SHALL display that result as pretty-printed JSON (2-space indentation) in a scrollable, read-only region. The result SHALL NOT be editable or exportable. A review action SHALL be present only for a completed, server-computed reviewable attempt whose pinned Schema Revision is still selected; it SHALL post review decisions for the stored Extraction ID rather than reposting result material.

#### Scenario: Reviewable completed extraction renders as JSON

- **WHEN** a completed Article attempt is reviewable and its pinned schema remains selected
- **THEN** the Results tab shows the server result serialized with `JSON.stringify(result, null, 2)`
- **AND** it offers review finalization for that Extraction ID without sending result, Evidence, attribution, diagnostics, or pins

#### Scenario: Attempt is not reviewable

- **WHEN** a completed attempt has an ungrounded populated content path
- **THEN** its result remains visible
- **AND** no review-finalization action is offered

### Requirement: Live output while running

While a server-owned Article operation is pending, the Results tab SHALL display its current client-known phase without displaying or retaining raw model output. When the terminal response arrives, the view SHALL replace progress with the persisted attempt result, failure, or cancellation state.

#### Scenario: Server operation is running

- **WHEN** the Article POST remains pending
- **THEN** the Results experience reports that the server-owned extraction is running
- **AND** it does not display streamed raw model output

### Requirement: Error state with retry

When a server-owned Article attempt fails, the Results tab SHALL display its sanitized failure and offer an action that creates a new operation UUID and re-runs the Article extraction with the current pins. Reusing the failed attempt UUID MUST replay the failure rather than retry it.

#### Scenario: Extraction fails

- **WHEN** the server returns a failed terminal attempt
- **THEN** the Results tab shows its failure message
- **AND** retry posts a new UUID with the current Source Representation Revision and Schema Revision

### Requirement: Re-run replaces the displayed result

When an attempt is displayed and the schema is ready, the researcher SHALL be able to run another Article extraction using a new UUID. The terminal attempt returned by that run SHALL replace the currently displayed attempt without carrying over per-field or navigator state; the prior attempt remains append-only in PostgreSQL.

#### Scenario: Re-running after a result exists

- **WHEN** the researcher triggers a re-run
- **THEN** the browser creates a new UUID and posts only the current pins and `ARTICLE`
- **AND** the returned terminal attempt replaces the displayed attempt without altering the earlier row
- **AND** navigator state resets to the root

#### Scenario: Newer attempt is unreviewed on reopen

- **WHEN** a fresh browser reopens a Source Document whose latest attempt is unreviewed and whose latest reviewed Extraction is older
- **THEN** the Results experience restores the latest attempt for inspection
- **AND** retains the independently pinned latest reviewed Extraction for reviewed-state resolution
