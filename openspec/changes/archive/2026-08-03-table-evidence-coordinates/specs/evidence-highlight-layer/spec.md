## ADDED Requirements

### Requirement: Table geometry supplied as a new prop

`EvidenceHighlightLayer` SHALL accept a `tables: ParsedTable[]` prop carrying per-document table cell geometry, used only for the coordinate-lookup step described below. Existing props (`pdfViewer`, `result`, `evidence`, `schemaTemplate`, `containerEl`, `focusPath`) SHALL remain unchanged in meaning and behavior.

#### Scenario: Prop omitted or empty

- **WHEN** a caller does not pass `tables`, or passes an empty array
- **THEN** the layer behaves identically to its implementation before this change

### Requirement: Table-cell coordinate lookup precedes text search

For each highlight, `EvidenceHighlightLayer` SHALL attempt to resolve it to a table cell via the table-cell-coordinate-matching logic before running the existing PDF text search. When a match is found, the highlight SHALL be drawn from the matched cell's bounding box (converted from PDF points to viewport pixels using the target page's current viewport scale) instead of searching page text. When no match is found, the highlight SHALL fall back to the pre-existing text-search behavior (snippet-anchored search, then full-text search with progressive query shortening), unchanged.

#### Scenario: Table cell match found

- **WHEN** a highlight's value resolves to a `TableCell` via table-cell-coordinate-matching
- **THEN** the highlight is drawn using that cell's bounding box scaled to the current viewport
- **AND** no PDF text search runs for that highlight

#### Scenario: No table cell match

- **WHEN** table-cell-coordinate-matching returns no match for a highlight (including when the document has no tables)
- **THEN** the highlight is resolved exactly as it was before this change: snippet-anchored search falling back to full-text search
