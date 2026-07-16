<!-- markdownlint-disable MD013 MD041 -->

## MODIFIED Requirements

### Requirement: Highlight source uses direct text-layer search, not model-provided evidence

The `EvidenceHighlightLayer` SHALL locate searchable scalar Extraction Result leaves in the PDF text layer. String leaves SHALL use their trimmed value; finite number and boolean leaves SHALL be stringified before searching. Embedded Evidence snippets and page hints MAY guide search order, but highlight rectangles SHALL be derived from PDF text content rather than model-provided geometry.

#### Scenario: Searchable scalar value is found in the text layer

- **WHEN** the Extraction Result contains a string, finite number, or boolean leaf
- **AND** its searchable text (or an allowed prefix) is found in `pdfPage.getTextContent()`
- **THEN** the component draws a highlight rectangle over the matching text items on the canvas overlay
- **AND** the highlight color corresponds to the top-level key containing the leaf value

#### Scenario: Embedded Evidence guides a searchable scalar

- **WHEN** a searchable scalar leaf has an embedded Evidence snippet or page hint
- **THEN** the component uses that context to guide PDF text-layer search
- **AND** falls back to direct scalar-value search when the guided search does not resolve

#### Scenario: Value is not found after progressive shortening

- **WHEN** neither the full searchable text, its 5-word prefix, nor its 3-word prefix is found in the text layer
- **THEN** no rectangle is drawn for that value
- **AND** other values continue to be processed

#### Scenario: Result contains a non-searchable leaf

- **WHEN** a result leaf is `null`, a non-finite number, or another non-scalar value
- **THEN** that leaf is skipped rather than converted into searchable text
