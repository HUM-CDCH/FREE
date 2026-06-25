## MODIFIED Requirements

### Requirement: Schema-reactive highlight colors
The `EvidenceHighlightLayer` component SHALL assign highlight colors based on **top-level key order in the extraction result**, cycling through a fixed 4-color palette, so that each top-level result key receives a distinct color from its immediate neighbors. Color assignment SHALL NOT depend on the schema prop.

#### Scenario: Each top-level result key gets a unique palette slot
- **WHEN** the extraction result has N top-level keys
- **THEN** the k-th key (0-indexed) is assigned `PALETTE[k % 4]`
- **AND** no two adjacent top-level keys share the same color

#### Scenario: Schema prop changes after initial render
- **WHEN** the `schema` prop value changes
- **THEN** highlight colors are unaffected — colors derive from result keys only

#### Scenario: Result key not found in schema
- **WHEN** the model returns result keys that differ from schema keys
- **THEN** colors are still assigned by result key iteration order
- **AND** all top-level result keys receive distinct colors
