## ADDED Requirements

### Requirement: Primitive result values trigger tracing on click
In the review view, every `PrimitiveRow` component displaying a non-empty string value SHALL accept an `onValueClick?: (value: string) => void` prop. When the researcher clicks the value text span, `onValueClick` SHALL be called with the raw string value. The prop SHALL be threaded from `PrimitiveRow` through `ResultValue`, `ResultsTab`, and `RightRail` up to `App`.

#### Scenario: onValueClick called on value click
- **WHEN** the researcher clicks the value text in a `PrimitiveRow`
- **THEN** `onValueClick(text)` is invoked with the displayed string
- **AND** no edit mode is triggered by this click

#### Scenario: Missing value does not trigger onValueClick
- **WHEN** a `PrimitiveRow` displays a `MissingBadge` (empty/null value)
- **THEN** clicking the badge does NOT call `onValueClick`
