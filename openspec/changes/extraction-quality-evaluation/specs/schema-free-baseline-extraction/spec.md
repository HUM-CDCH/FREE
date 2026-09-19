## ADDED Requirements

### Requirement: A schema-free extraction strategy exists for baseline comparison

FREE SHALL support a `SCHEMA_FREE` extraction strategy that extracts
records/fields from a document without a researcher-authored schema,
producing output usable as a baseline to compare against `ARTICLE`/
`CATALOG` results on the same documents.

#### Scenario: Schema-free extraction runs without a pinned schema revision

- **WHEN** an extraction is run with strategy `SCHEMA_FREE`
- **THEN** FREE does not require a `SchemaRevision` to constrain or compile
  instructions for that run

### Requirement: Schema-free output is field-name-aligned before scoring

FREE SHALL perform a field-name alignment step before applying
`record-alignment-scoring` to schema-free results, because `SCHEMA_FREE`
output field names are not guaranteed to match the gold schema's field
names.

#### Scenario: Differently-named equivalent fields are aligned before comparison

- **WHEN** a schema-free extraction names a field differently than the gold
  schema's corresponding field
- **THEN** FREE aligns the two field names before record/field comparison
  runs, rather than scoring them as unrelated fields
