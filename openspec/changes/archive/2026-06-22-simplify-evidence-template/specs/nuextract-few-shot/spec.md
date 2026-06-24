## MODIFIED Requirements

### Requirement: A static few-shot example demonstrates correct evidence snippet quality

The backend SHALL provide a single static few-shot example as a module-level constant that contains a mixed schema (one scalar field and one array-of-objects field) and a correctly filled result, demonstrating the inline evidence format and that snippets are broader source passages rather than copies of extracted values.

The example schema (`schema_json`) SHALL represent each scalar field as `{"value": <type_hint>, "snippet": "string", "page": "number"}`, including scalar subfields within array-item schemas. There SHALL be no top-level `_evidence` key in the schema.

The example result (`result_json`) SHALL show each scalar leaf filled with `{"value": <extracted_value>, "snippet": <broader_context_passage>, "page": <1-based_page_number>}`. There SHALL be no top-level `_evidence` key in the result.

#### Scenario: Example schema uses inline evidence shape, no _evidence block

- **WHEN** `STRUCTURED_EXTRACTION_EXAMPLE.schema_json` is parsed
- **THEN** each scalar field is represented as an object with `value`, `snippet`, and `page` keys
- **AND** scalar subfields within array-item schemas follow the same shape
- **AND** there is no `_evidence` key at any level

#### Scenario: Example result fills inline evidence at every scalar leaf

- **WHEN** `STRUCTURED_EXTRACTION_EXAMPLE.result_json` is parsed
- **THEN** each scalar leaf is an object with `value` (the extracted scalar), `snippet` (a string), and `page` (a positive integer)
- **AND** there is no `_evidence` key at any level

#### Scenario: Snippets are broader passages, not copies of extracted values

- **WHEN** a snippet in the example result is compared to the corresponding `value`
- **THEN** the snippet contains the extracted value as a substring or near-match
- **AND** the snippet includes surrounding words from the original source text, providing enough context for fuzzy positional search in the PDF

#### Scenario: Every evidenced item has a non-empty snippet and a valid page number

- **WHEN** all `{snippet, page}` pairs in the example result are collected
- **THEN** every snippet is a non-empty string
- **AND** every page is a positive integer
