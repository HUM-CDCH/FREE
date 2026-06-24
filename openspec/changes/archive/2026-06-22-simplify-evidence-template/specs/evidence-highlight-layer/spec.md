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

## ADDED Requirements

### Requirement: Highlights cover the extracted value, not the full snippet

The `EvidenceHighlightLayer` SHALL use each evidence `snippet` to locate the source region in the PDF text layer, then restrict the drawn highlight to the sub-range that matches the extracted `value` within that region. This produces precise, word-level highlights instead of broader context-passage highlights.

#### Scenario: Value found within snippet region

- **WHEN** a `{snippet, page, value}` evidence leaf is processed
- **AND** the snippet is found in the PDF text layer on the specified page
- **AND** the value text appears within the matched snippet character range
- **THEN** only the text items overlapping the value sub-range are highlighted
- **AND** the highlight does not extend into the surrounding context words of the snippet

#### Scenario: Value not found within snippet — fallback to full snippet

- **WHEN** a `{snippet, page, value}` evidence leaf is processed
- **AND** the snippet is found in the PDF text layer
- **AND** the value text cannot be located within the matched snippet range (e.g. OCR mismatch)
- **THEN** the highlight falls back to covering the full snippet range
- **AND** no error is thrown

#### Scenario: Evidence leaf has no value field

- **WHEN** a `{snippet, page}` evidence leaf is processed (no `value` key)
- **THEN** the full snippet range is highlighted, unchanged from previous behavior
