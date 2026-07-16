<!-- markdownlint-disable MD013 MD041 -->

## ADDED Requirements

### Requirement: Model results are recursively conformed to the Extraction Schema

Extraction SHALL apply the behavior of the pinned `FREE-technical` `_conform_to_schema` function recursively against `schema.record` before merging or returning a model result. Conformance SHALL drop unknown object keys and restore every key declared by the record schema. Envelope metadata SHALL guide extraction but SHALL NOT appear in the returned result.

#### Scenario: Model object has unknown and missing keys

- **WHEN** a model object contains a key absent from the corresponding schema object and omits a declared key
- **THEN** conformance drops the unknown key
- **AND** it restores the omitted declared key with its schema-directed missing value

#### Scenario: Nested objects and arrays are present

- **WHEN** a model result contains nested schema-shaped objects or arrays
- **THEN** conformance applies the same rules recursively at every declared level

### Requirement: Missing and incompatible scalar values conform to null

A missing scalar SHALL become `null` regardless of the scalar exemplar in the Extraction Schema. A non-scalar value supplied for a scalar slot SHALL also become `null`.

#### Scenario: Scalar field is absent

- **WHEN** the Extraction Schema declares a scalar field and the model omits it
- **THEN** conformance sets that field to `null`

#### Scenario: Scalar field receives a container

- **WHEN** the Extraction Schema declares a scalar field and the model supplies an object or array
- **THEN** conformance sets that field to `null`

### Requirement: Arrays recover missing and singleton values

A missing schema-declared array SHALL become `[]`. When the model supplies one compatible non-array value for a schema-declared typed array, conformance SHALL recover it as a one-element array.

#### Scenario: Array field is absent

- **WHEN** the Extraction Schema declares an array and the model omits it
- **THEN** conformance restores the field as `[]`

#### Scenario: Typed array receives one compatible item

- **WHEN** the Extraction Schema declares a typed array and the model supplies one compatible singleton value
- **THEN** conformance wraps the conformed item in a one-element array

### Requirement: Empty schema containers remain free-form

An empty object exemplar `{}` and empty array exemplar `[]` in the Extraction Schema SHALL remain free-form containers rather than imposing an inferred child shape.

#### Scenario: Empty object exemplar receives object data

- **WHEN** the schema slot is `{}` and the model supplies an object
- **THEN** conformance preserves that object as a free-form value

#### Scenario: Empty array exemplar receives array data

- **WHEN** the schema slot is `[]` and the model supplies an array
- **THEN** conformance preserves that array as a free-form value

### Requirement: Embedded Evidence preserves the local schema shape

Extraction SHALL retain and normalize local `_evidence` slots already declared by the copied Extraction Schemas, including Evidence nested within Catalog arrays such as `fundliste`. Embedded Evidence SHALL be the only public Evidence shape returned by this change.

#### Scenario: Nested result declares local Evidence

- **WHEN** a conformed result contains nested values with corresponding `_evidence` slots
- **THEN** normalization retains the Evidence beside the values at the declared schema locations
- **AND** it does not move Evidence into a separate top-level envelope

#### Scenario: Evidence slot is absent from the schema

- **WHEN** an extracted value has no schema-declared `_evidence` slot
- **THEN** normalization does not invent a public Evidence field for that value

### Requirement: Text Evidence is grounded through canonical locations

Text Evidence SHALL be normalized against canonical page text and spans from the `ParsedDocument`. Evidence Anchors SHALL be used as an additional grounding source when present but SHALL NOT be required. The pinned ellipsis behavior SHALL split snippets joined with `...` or `…` into trimmed non-empty contiguous snippets.

#### Scenario: Text Evidence resolves without anchors

- **WHEN** model-produced text Evidence matches canonical page text and the document has no Evidence Anchors
- **THEN** the returned Evidence identifies the matching canonical page

#### Scenario: Optional Evidence Anchor resolves a snippet

- **WHEN** canonical page text alone does not resolve a snippet and a compatible Evidence Anchor is present
- **THEN** normalization uses the anchor's canonical page location

#### Scenario: Evidence snippet joins non-contiguous spans with an ellipsis

- **WHEN** a snippet contains `...` or `…` between non-empty text fragments
- **THEN** normalization replaces it with separate trimmed snippet entries
- **AND** no ellipsis-glued snippet remains

### Requirement: Table Evidence preserves table_index and resolves deterministic table order

Table Evidence SHALL preserve the public 1-based `table_index` field and resolve it against the deterministic order of canonical `ParsedTable` objects and their 0-based `row` and `col` cells. Applying the pinned default-extractor backfill algorithm to Catalog output SHALL be an intentional extension because the pinned hierarchical path ignored table files. This change SHALL NOT rename `table_index` to `table_id`.

#### Scenario: Valid table index is supplied

- **WHEN** embedded Evidence contains a `table_index` that identifies a canonical table in deterministic order
- **THEN** normalization grounds the Evidence against that `ParsedTable` and its referenced cells
- **AND** the returned Evidence continues to expose `table_index`

#### Scenario: Nested table Evidence is supplied

- **WHEN** a nested `fundliste` Evidence leaf refers to a canonical table
- **THEN** normalization applies the same deterministic `table_index` resolution at that nested location
