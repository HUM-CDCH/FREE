# Spec: Result Tracing

## Purpose

Defines the interactive tracing capability that links primitive extraction result values to their corresponding evidence highlights in the PDF viewer. When a researcher clicks a value in the Results tab, the PDF scrolls to the page where that value appears and intensifies its highlight, while dimming all other highlights.

## Requirements

### Requirement: Primitive result values are clickable for tracing

Every primitive (non-object, non-array) value displayed in the Results tab review view SHALL be interactive: clicking it sets that value as the active focus target, scrolling the PDF viewer to the location where that value appears and intensifying its highlight. Clicking the currently focused value SHALL deselect it (toggle off).

#### Scenario: Clicking an unfocused primitive value

- **WHEN** the researcher clicks a primitive value in the Results tab review view
- **THEN** the PDF viewer scrolls to the page containing that value
- **AND** the corresponding evidence highlight is drawn at increased opacity
- **AND** all other evidence highlights are drawn at reduced opacity (dimmed)

#### Scenario: Clicking the currently focused value deselects

- **WHEN** the researcher clicks a value that is already the active focus target
- **THEN** `focusValue` is set to null
- **AND** all evidence highlights are redrawn at their normal opacity

#### Scenario: Focus resets when a new extraction completes

- **WHEN** an extraction completes (success or re-run)
- **THEN** `focusValue` is reset to null
- **AND** all highlights are redrawn at normal opacity

### Requirement: Focus state is owned by App and threaded as props

The active focus value (`focusValue: string | null`) SHALL be owned as React state in `App`. An `onValueClick` callback SHALL be threaded from `PrimitiveRow` up through `ResultValue`, `ResultsTab`, and `RightRail` to `App`. `App` SHALL pass `focusValue` down to `EvidenceHighlightLayer`.

#### Scenario: Clicking a value updates App-level state

- **WHEN** `onValueClick(value)` is called from `PrimitiveRow`
- **THEN** `App` receives the callback and updates `focusValue` state
- **AND** the new `focusValue` propagates to `EvidenceHighlightLayer` as a prop

### Requirement: Clickable values show pointer cursor on hover

Primitive value text in the Results tab review view SHALL display a pointer cursor (`cursor-pointer`) on hover to signal interactivity.

#### Scenario: Hover on a primitive value span

- **WHEN** the researcher hovers over a primitive value string in the review view
- **THEN** the cursor changes to a pointer
