<!-- markdownlint-disable MD013 MD041 -->

## ADDED Requirements

### Requirement: Model results are recursively conformed to the Extraction Schema

Extraction SHALL apply the behavior of the pinned `FREE-technical` `_conform_to_schema` function recursively before merging or returning a model result. Conformance SHALL drop unknown object keys and restore every key declared by the Extraction Schema.

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

Text Evidence SHALL be normalized against canonical pages, spans, and Evidence Anchors from the `ParsedDocument`, preserving the pinned ellipsis-snippet behavior.

#### Scenario: Text Evidence resolves to canonical source material

- **WHEN** model-produced text Evidence can be resolved through canonical page content and anchors
- **THEN** the returned Evidence identifies the normalized source material and canonical location

#### Scenario: Evidence snippet uses the reference ellipsis form

- **WHEN** the pinned Evidence behavior shortens source context with an ellipsis
- **THEN** normalization preserves the same ellipsis-snippet behavior

### Requirement: Table Evidence preserves table_index and resolves deterministic table order

Table Evidence SHALL preserve the public `table_index` field and resolve it against the deterministic order of canonical `ParsedTable` objects and cells. This change SHALL NOT rename the field to `table_id`.

#### Scenario: Valid table index is supplied

- **WHEN** embedded Evidence contains a `table_index` that identifies a canonical table in deterministic order
- **THEN** normalization grounds the Evidence against that `ParsedTable` and its referenced cells
- **AND** the returned Evidence continues to expose `table_index`

#### Scenario: Nested table Evidence is supplied

- **WHEN** a nested `fundliste` Evidence leaf refers to a canonical table
- **THEN** normalization applies the same deterministic `table_index` resolution at that nested location
