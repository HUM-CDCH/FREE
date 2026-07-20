## MODIFIED Requirements

### Requirement: Primitive result values are clickable for tracing

Every non-missing primitive value displayed in Review SHALL be interactive. Clicking it SHALL set its full result path as the active focus target, scroll the PDF viewer to evidence at that path, intensify that path's highlight, and dim highlights at other paths. The Results toolbar SHALL provide a Clear action whenever a focus path is active.

#### Scenario: Clicking an unfocused primitive value

- **WHEN** the researcher clicks a non-missing primitive value in Review
- **THEN** its full result path becomes the active focus path
- **AND** the PDF scrolls to the first cached evidence rectangle at that path
- **AND** highlights at other paths are dimmed even when they have the same display value

#### Scenario: Researcher clears the active selection

- **WHEN** the researcher chooses Clear while a focus path is active
- **THEN** `focusPath` is set to null
- **AND** all evidence highlights return to normal opacity

#### Scenario: Focus resets when extraction completes

- **WHEN** an extraction completes successfully, including a re-run
- **THEN** `focusPath` is reset to null

### Requirement: Focus state is owned by App and threaded as props

The active result path (`focusPath: string[] | null`) SHALL be owned as React state in `App`. An `onValueClick(path, value)` callback SHALL be threaded from `PrimitiveRow` through `ResultValue`, `ResultsTab`, and `RightRail` to `App`. `App` SHALL pass `focusPath` to `EvidenceHighlightLayer` and expose a clear callback to Results.

#### Scenario: Clicking a value updates App-level path state

- **WHEN** `onValueClick(path, value)` is called from `PrimitiveRow`
- **THEN** `App` stores `path` as `focusPath`
- **AND** that path propagates to `EvidenceHighlightLayer`
- **AND** equal values at different paths do not alias one another
