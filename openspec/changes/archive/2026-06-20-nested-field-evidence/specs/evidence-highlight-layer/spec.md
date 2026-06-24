## MODIFIED Requirements

### Requirement: Schema-reactive highlight colors
The `EvidenceHighlightLayer` component SHALL assign highlight colors based on **top-level key order** in the schema, cycling through a fixed 4-color palette, so that each top-level key receives a distinct color from its immediate neighbors.

#### Scenario: Each top-level key gets a unique palette slot
- **WHEN** the schema has N top-level keys
- **THEN** the k-th key (0-indexed) is assigned `PALETTE[k % 4]`
- **AND** no two adjacent top-level keys share the same color

#### Scenario: Schema prop changes after initial render
- **WHEN** the `schema` prop value changes
- **THEN** the effect re-runs and highlights are redrawn with colors re-derived from the new schema's top-level key order
