<!-- markdownlint-disable MD013 MD041 -->

## MODIFIED Requirements

### Requirement: Highlight source uses direct text-layer search, not model-provided evidence

The `EvidenceHighlightLayer` SHALL locate searchable scalar Extraction Result leaves in the PDF text layer. String leaves SHALL use their trimmed value; finite number and boolean leaves SHALL be stringified before searching. Embedded Evidence snippets and page hints MAY guide search order, but highlight rectangles SHALL be derived from PDF text content rather than model-provided geometry. Search normalization and tolerant token-sequence matching SHALL follow the `FREE-technical` highlight pipeline, with one intentional correction: scalar-value matches SHALL align to complete normalized PDF tokens rather than using its unrestricted substring fast path.

#### Scenario: Searchable scalar value is found in the text layer

- **WHEN** the Extraction Result contains a string, finite number, or boolean leaf
- **AND** its searchable text (or an allowed prefix) is found in `pdfPage.getTextContent()`
- **THEN** the component draws a highlight rectangle over the matching text items on the canvas overlay
- **AND** the highlight color corresponds to the top-level key containing the leaf value

#### Scenario: Embedded Evidence guides a searchable scalar

- **WHEN** a searchable scalar leaf has an embedded Evidence snippet or page hint
- **THEN** the component uses that context to guide PDF text-layer search
- **AND** falls back to direct scalar-value search when the guided search does not resolve

#### Scenario: Scalar array has field-level Evidence

- **WHEN** an array of searchable scalar values has one schema-declared field-level Evidence leaf
- **THEN** every scalar element inherits that Evidence leaf's snippets and page hint
- **AND** each highlight search still targets the individual scalar value
- **AND** the component does not infer positional pairing between snippets and array elements

#### Scenario: Grounded Evidence has no snippet

- **WHEN** a searchable scalar or scalar-array field has a valid Evidence page but no non-empty snippet
- **THEN** the component preserves that page as the preferred search location
- **AND** it searches for the scalar value directly on that page before searching other pages

#### Scenario: Short scalar is contained in a larger token

- **WHEN** the searchable scalar is `7` and the PDF text contains `17` but no complete normalized token `7`
- **THEN** the component does not highlight `17`
- **AND** it continues searching for a complete token match

#### Scenario: Hyphenated identifier is contained in a larger token

- **WHEN** the searchable scalar is `8-2` and the PDF text contains only a larger normalized token such as `28-29` or `8-20`
- **THEN** the component does not highlight the larger token

#### Scenario: PDF tokenization splits a supported normalized value

- **WHEN** the PDF text layer splits a value across adjacent tokens in a form handled by the reference token matcher
- **THEN** the component may combine those complete adjacent tokens according to the reference normalization rules
- **AND** it does not relax complete-token alignment

#### Scenario: Value is not found after progressive shortening

- **WHEN** neither the full searchable text, its 5-word prefix, nor its 3-word prefix is found in the text layer
- **THEN** no rectangle is drawn for that value
- **AND** other values continue to be processed

#### Scenario: Result contains a non-searchable leaf

- **WHEN** a result leaf is `null`, a non-finite number, or another non-scalar value
- **THEN** that leaf is skipped rather than converted into searchable text
