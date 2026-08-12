# table-evidence-hints Specification

## Purpose
TBD - created by archiving change table-evidence-coordinates. Update Purpose after archive.
## Requirements
### Requirement: Row/column header evidence slots are gated on table presence

When the source document contains at least one table, the extraction evidence template SHALL add optional `row_header` and `column_header` string slots to every evidence leaf, in addition to the existing `value`/`snippet`/`page` slots. When the document has no tables, the evidence template SHALL be unchanged from its shape before this change.

#### Scenario: Document has tables

- **WHEN** `extractWithModel` is called with `hasTables: true`
- **THEN** every evidence leaf in the generated template includes `row_header` and `column_header` string slots alongside `value`, `snippet`, and `page`

#### Scenario: Document has no tables

- **WHEN** `extractWithModel` is called with `hasTables: false` or the flag omitted
- **THEN** the evidence template leaf shape is identical to its shape before this change

### Requirement: Model is instructed to fill header hints for table-sourced values

When `hasTables` is true, the extraction prompt instructions SHALL tell the model to set `row_header` to the identifying label of the table row and `column_header` to the header text of the table column for any value sourced from a table cell, to always include both keys, and to leave both empty/null when the value is not table-sourced.

#### Scenario: Table-aware instruction appended

- **WHEN** `hasTables` is true
- **THEN** the prompt instructions passed to the model include guidance to fill `row_header`/`column_header` for table-sourced values and to always include both keys

#### Scenario: Non-table documents get no extra instruction

- **WHEN** `hasTables` is false
- **THEN** the prompt instructions are byte-for-byte unchanged from before this change

### Requirement: Header hints survive the evidence/result split

`splitEvidenceResult` SHALL carry `row_header` and `column_header` through into the returned evidence object whenever present on a model-returned leaf, independent of whether the document has tables, and SHALL default them to `null` when absent (e.g. responses produced before this change, or non-table-sourced values).

#### Scenario: Leaf includes header hints

- **WHEN** a model-returned leaf includes non-empty `row_header`/`column_header` string values alongside `value`/`snippet`/`page`
- **THEN** the split evidence object for that leaf includes both header fields with their given values

#### Scenario: Leaf omits header hints

- **WHEN** a model-returned leaf has no `row_header`/`column_header` keys, or they are `null`/empty
- **THEN** the split evidence object for that leaf sets both fields to `null`

