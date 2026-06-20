## ADDED Requirements

### Requirement: No debug output in production
The `EvidenceHighlightLayer` component SHALL NOT emit `console.log` or `console.debug` statements during normal operation.

#### Scenario: Component mounts with evidence
- **WHEN** the component renders with valid `pdfViewer`, `evidence`, and `containerEl` props
- **THEN** no console output is produced

#### Scenario: Component mounts without evidence
- **WHEN** the component renders with `evidence` set to `null`
- **THEN** no console output is produced

### Requirement: Schema-reactive highlight colors
The `EvidenceHighlightLayer` component SHALL re-render highlights whenever the `schema` prop changes, reflecting updated depth-based color assignments.

#### Scenario: Schema prop changes after initial render
- **WHEN** the `schema` prop value changes
- **THEN** the effect re-runs and highlights are redrawn with colors derived from the new schema's depth map
